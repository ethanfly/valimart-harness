/**
 * Mixed 数据契约（T03）：版本化配置、计划、任务、attempt、证据、审核 schema 与错误码。
 *
 * 依据计划 §4（运行数据/任务图/证据契约）、§5（状态机与异常语义）、§3.2（配置形状）。
 * 纯模块：schema、状态机表、错误码与无副作用的纯函数（key 派生、记录推进、图校验）。
 * 持久化由 store.js 负责（DSH storageDomain 'mixed' domain）。
 */
import crypto from 'node:crypto'
import { z } from 'zod' // 域层（dsh-storage-domain）要求 .parse/.safeParse：用 zod（与 dsh-workspace 一致）；schemastery 无 parse

export const MIXED_SCHEMA_VERSION = 1

// ---------- 错误码 ----------
// {code: 稳定判别, httpStatus: T07 API 映射, retryable: 客户端是否可原样重试}
export const MIXED_ERRORS = {
  mixed_not_configured: { httpStatus: 409, retryable: false, label: '三路由配置不齐全' },
  config_revision_conflict: { httpStatus: 409, retryable: false, label: '配置版本冲突（另一窗口已保存）' },
  route_unavailable: { httpStatus: 422, retryable: false, label: '角色路由不可用（模型下架/目录冲突）' },
  route_not_resolved: { httpStatus: 422, retryable: false, label: '路由解析失败' },
  run_not_found: { httpStatus: 404, retryable: false, label: '运行不存在或不属于当前 owner' },
  run_revision_conflict: { httpStatus: 409, retryable: false, label: '运行状态版本冲突' },
  owner_mismatch: { httpStatus: 403, retryable: false, label: '运行不属于当前账号/实例' },
  owner_epoch_stale: { httpStatus: 403, retryable: false, label: '账号已切换，旧运行被 fence' },
  run_not_in_status: { httpStatus: 409, retryable: false, label: '当前状态不允许该操作' },
  run_not_idle: { httpStatus: 409, retryable: false, label: '会话有活动运行，先停止' },
  question_mismatch: { httpStatus: 409, retryable: false, label: '补充输入与原问题不匹配' },
  plan_invalid: { httpStatus: 422, retryable: false, label: '计划未通过宿主校验' },
  resume_not_allowed: { httpStatus: 409, retryable: false, label: '该 run 当前不可自动恢复（建议用新需求重跑）' },
  stage_failed: { httpStatus: 502, retryable: false, label: '阶段未正常完成（stopReason 非 completed）' },
  stage_timeout: { httpStatus: 502, retryable: true, label: '阶段超时弃置：cancel 未在宽限期内生效（上游请求可能挂死），结果未知，可恢复重试' },
  task_failed: { httpStatus: 502, retryable: false, label: '任务实施失败/受阻且重新拆分次数耗尽' },
  workspace_conflict: { httpStatus: 409, retryable: false, label: '工作区正被另一 Mixed run 写入' },
  scheduler_deadlock: { httpStatus: 500, retryable: false, label: '调度器异常（疑似 stale/依赖抖动）' },
  evidence_invalid: { httpStatus: 422, retryable: false, label: '证据校验失败' },
  review_rejected: { httpStatus: 422, retryable: false, label: '审核输出未通过宿主校验' },
  record_validation_failed: { httpStatus: 500, retryable: false, label: '记录形状校验失败（数据问题，存储健康；修复数据后可重试）' },
  ownership_conflict: { httpStatus: 503, retryable: false, label: '存储目录被另一宿主独占' },
  storage_unhealthy: { httpStatus: 503, retryable: false, label: '状态落盘失败，已停止派发' },
  storage_write_timeout: { httpStatus: 503, retryable: false, label: '存储写超时（文件系统层挂起），已停止派发' },
  schema_too_new: { httpStatus: 503, retryable: false, label: '存储记录版本高于本宿主支持版本，请升级' },
  storage_corrupted: { httpStatus: 503, retryable: false, label: '存储记录损坏（已备份隔离，请检查诊断）' },
  // T07 本机 API 层
  unauthenticated: { httpStatus: 401, retryable: false, label: '未登录公司网关' },
  owner_not_resolved: { httpStatus: 503, retryable: true, label: 'owner 身份未解析（网关实例 id 未同步）' },
  bad_request: { httpStatus: 400, retryable: false, label: '请求体参数缺失或非法' },
  body_too_large: { httpStatus: 413, retryable: false, label: '请求体超过限额' },
  method_not_allowed: { httpStatus: 405, retryable: false, label: '方法不允许' },
  session_not_found: { httpStatus: 404, retryable: false, label: '会话不存在' },
  evidence_unavailable: { httpStatus: 503, retryable: false, label: '证据接口未初始化' },
}

export class MixedError extends Error {
  constructor(code, detail, { cause, httpStatus } = {}) {
    const meta = MIXED_ERRORS[code]
    if (!meta) throw new Error(`未知 Mixed 错误码: ${code}`)
    super(detail ?? meta.label)
    this.name = 'MixedError'
    this.code = code
    this.httpStatus = httpStatus ?? meta.httpStatus
    this.retryable = meta.retryable
    if (cause) this.cause = cause
  }
}

// ---------- 状态机 ----------
export const RUN_STATUSES = [
  'queued', 'planning', 'executing', 'waiting_input', 'reviewing', 'repairing',
  'finalizing', 'succeeded', 'blocked', 'cancelling', 'cancelled', 'interrupted',
]
export const RUN_TERMINAL = new Set(['succeeded', 'cancelled'])
export const RUN_RESUMABLE = new Set(['blocked', 'interrupted', 'waiting_input'])
/** 可派发恢复/启动 marker：可恢复态 + 重跑落下的 queued。 */
export const RUN_STARTABLE = new Set(['queued', ...RUN_RESUMABLE])
// 可进入 cancelling 的非终态
export const RUN_CANCELLABLE = new Set(['queued', 'planning', 'executing', 'waiting_input', 'reviewing', 'repairing', 'finalizing'])
const CANCELLABLE = RUN_CANCELLABLE
const INTERRUPTABLE = new Set(['planning', 'executing', 'reviewing', 'repairing', 'finalizing'])
const RESUME_TARGETS = new Set(['planning', 'executing', 'reviewing', 'repairing', 'finalizing'])
const BASE_TRANSITIONS = {
  queued: ['planning', 'blocked'], // blocked：领取后尚未开始规划即失败（存储/宿主配置错误）也要落 blocked
  planning: ['executing', 'waiting_input', 'blocked'],
  waiting_input: ['planning'],
  executing: ['reviewing', 'planning', 'blocked'],
  reviewing: ['finalizing', 'repairing', 'blocked'],
  repairing: ['reviewing', 'blocked'],
  finalizing: ['succeeded', 'blocked'],
  blocked: [...RESUME_TARGETS], // 恢复：按恢复选择回到对应阶段（宿主对账后）
  interrupted: [...RESUME_TARGETS],
  cancelling: ['cancelled'],
  succeeded: [],
  cancelled: [],
}

/** 最近一轮有结论的审核摘要（列表索引行与终态横幅共用；无 reviewRounds/未出结论 → null）。 */
export function lastReviewSummaryOf(record) {
  const rounds = record?.reviewRounds ?? []
  const last = [...rounds].reverse().find((x) => x?.result)
  if (!last?.result) return null
  return {
    verdict: last.result.verdict,
    summary: last.result.summary ?? '',
    round: rounds.length,
    criteria: last.result.criteria ?? [],
    findings: last.result.findings ?? [],
  }
}

/** 状态迁移合法性（§5.1）。from=当前、to=目标；cancelling/interrupted 由调用方按规则注入。 */
export function assertRunTransition(from, to, { interrupting = false, cancelling = false } = {}) {
  const ok =
    BASE_TRANSITIONS[from]?.includes(to) ||
    (cancelling && CANCELLABLE.has(from) && to === 'cancelling') ||
    (interrupting && INTERRUPTABLE.has(from) && to === 'interrupted')
  if (!ok) throw new MixedError('run_not_in_status', `运行状态 ${from} 不允许迁移到 ${to}`)
}

export const TASK_STATUSES = [
  'pending', 'ready', 'running', 'executed', 'failed', 'blocked', 'cancelled',
  'interrupted', 'accepted', 'changes_requested', 'stale',
]
// 依赖可 ready 的前置状态（§5.2）
export const TASK_DEP_SATISFIED = new Set(['executed', 'accepted'])

export const ATTEMPT_STAGES = ['planning', 'execution', 'verification', 'review', 'repair', 'summary']

// ---------- 模型路由（与网关 /api/mixed/catalog、T02 resolver 对齐）----------
const nonEmpty = z.string().min(1)
export const modelRouteSchema = z.object({
  catalogProvider: nonEmpty,
  modelId: nonEmpty,
  reasoningEffort: z.string().min(1).optional(),
})
export const resolvedRouteSchema = modelRouteSchema.extend({
  runtimeModelId: nonEmpty,
  capabilities: z.object({ planner: z.boolean(), executor: z.boolean(), reviewer: z.boolean() }),
  capabilitiesRevision: nonEmpty,
})

export const mixedPreferencesSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().min(1),
  ownerKey: nonEmpty,
  ownerEpoch: z.number().int().min(0),
  planner: resolvedRouteSchema.nullable(),
  executor: resolvedRouteSchema.nullable(),
  reviewer: resolvedRouteSchema.nullable(),
  updatedAt: z.string(),
})

// ---------- Run 聚合（§4.1）----------
export const inputRefSchema = z.object({
  kind: z.enum(['text', 'attachment', 'mention']),
  messageId: nonEmpty, // 原始消息 ID（不能丢引用）
  text: z.string().optional(), // kind=text 的文本
  filePath: z.string().optional(), // kind=attachment 的工作区相对路径
  sha256: z.string().optional(),
  size: z.number().int().min(0).optional(),
  mediaType: z.string().optional(),
  access: z.enum(['read', 'read-write']).optional(),
})

export const acceptanceItemSchema = z.object({
  id: nonEmpty,
  description: z.string(),
  checkable: z.boolean(),
})

export const planVersionSchema = z.object({
  version: z.number().int().min(1),
  goal: z.string(),
  interpretation: z.string().optional(),
  knownFacts: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  acceptance: z.array(acceptanceItemSchema),
  tasks: z.array(z.string()), // taskId 列表（任务明细在 run.tasks）
  verificationMethods: z.array(z.string()).default([]),
  supersedes: z.number().int().min(1).optional(), // 重新规划时指向被取代版本
  reason: z.string().optional(),
})

export const mixedTaskSchema = z.object({
  taskId: nonEmpty,
  parentTaskId: z.string().optional(), // 聚合父节点（拆分后父不再派发）
  dependsOnTaskIds: z.array(z.string()).default([]),
  title: z.string(),
  goal: z.string(),
  scope: z.string().optional(),
  inputRefs: z.array(inputRefSchema).default([]),
  expectedOutputs: z.array(z.string()).default([]),
  pathScope: z.array(z.string()).default([]), // 可能修改的路径范围（宿主校验合法）
  acceptanceIds: z.array(z.string()).default([]),
  verificationHints: z.array(z.string()).default([]),
  role: z.literal('executor'), // 固定 executor；模型由角色解析，规划器不能指定其他 provider
  status: z.enum(TASK_STATUSES),
  attemptIds: z.array(z.string()).default([]),
  evidenceIds: z.array(z.string()).default([]),
  blockedReason: z.string().optional(),
  repairNotes: z.array(z.string()).default([]), // 审核 findings 的返修指令（T06）
})

export const attemptUsageSchema = z.object({
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  totalTokens: z.number().int().min(0).optional(),
  coverage: z.enum(['full', 'partial', 'unknown']).default('unknown'),
})

export const attemptSchema = z.object({
  attemptId: nonEmpty,
  stage: z.enum(ATTEMPT_STAGES),
  taskId: z.string().optional(),
  planVersion: z.number().int().min(1),
  childSessionId: z.string().optional(), // 派发成功后才写
  route: resolvedRouteSchema,
  startedAt: z.string(),
  endedAt: z.string().optional(),
  stopReason: z.enum(['completed', 'aborted', 'error', 'max-tokens', 'refusal', 'timeout_abandoned']).optional(),
  inputHash: z.string().optional(),
  evidenceHashes: z.array(z.string()).default([]),
  requestIds: z.array(z.string()).default([]),
  usage: attemptUsageSchema.optional(),
  // starting 已持久化但子会话未派发成功 → 结果未知（§4.3 崩溃窗口）
  unknown: z.boolean().default(false),
})

export const evidenceRefSchema = z.object({
  evidenceId: nonEmpty,
  producer: z.enum(['host', 'executor', 'reviewer', 'planner']),
  type: z.enum(['baseline', 'artifact', 'file-manifest', 'command-log', 'verification', 'report']),
  producedAt: z.string(),
  taskId: z.string().optional(),
  attemptId: z.string().optional(),
  planVersion: z.number().int().min(1).optional(),
  fingerprint: z.string(), // 内容/验证输入指纹（不只时间戳）
  size: z.number().int().min(0).optional(),
  ref: z.string(), // 本机受管状态目录引用（不允许任意路径读取）
  truncated: z.boolean().default(false),
  invalidated: z.boolean().default(false), // 输入树指纹变化后作废
})

export const reviewCriteriaSchema = z.object({
  acceptanceId: nonEmpty,
  status: z.enum(['pass', 'fail', 'unverified']),
  evidenceIds: z.array(z.string()).default([]),
  explanation: z.string(),
})
export const reviewFindingSchema = z.object({
  findingId: nonEmpty,
  taskIds: z.array(z.string()).default([]),
  severity: z.enum(['blocking', 'nonblocking']),
  evidenceIds: z.array(z.string()).default([]),
  expected: z.string(),
  actual: z.string(),
  repairInstruction: z.string(),
})
export const reviewResultSchema = z.object({
  verdict: z.enum(['pass', 'changes_requested', 'blocked']),
  planVersion: z.number().int().min(1),
  evidenceManifestHash: z.string(),
  criteria: z.array(reviewCriteriaSchema),
  findings: z.array(reviewFindingSchema).default([]),
  summary: z.string(),
})

export const reviewRoundSchema = z.object({
  roundId: nonEmpty,
  planVersion: z.number().int().min(1),
  evidenceManifestHash: z.string(),
  // 进行中/崩溃窗口内允许 result 为空（开始先落盘，结束后回填）
  result: reviewResultSchema.nullable(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
})

export const runEventSchema = z.object({
  eventSeq: z.number().int().min(1),
  type: nonEmpty, // claimed / plan_saved / task_ready / attempt_started / attempt_ended / review_round / evidence_added / status_changed / ...
  at: z.string(),
  summary: z.string().optional(),
})

export const runRecordSchema = z.object({
  schemaVersion: z.literal(MIXED_SCHEMA_VERSION),
  runId: nonEmpty,
  ownerKey: nonEmpty,
  ownerEpoch: z.number().int().min(0),
  profileId: nonEmpty,
  sessionId: nonEmpty,
  sourceMessageId: nonEmpty,
  submissionKey: nonEmpty,
  rerunRequestId: z.string().optional(),
  retryOfRunId: z.string().optional(),
  workspace: z.object({ canonicalPath: nonEmpty, baselineId: nonEmpty }),
  models: z.object({ planner: resolvedRouteSchema, executor: resolvedRouteSchema, reviewer: resolvedRouteSchema }),
  policy: z.record(z.unknown()), // 执行策略快照（§3.3 边界）
  revision: z.number().int().min(1),
  eventSeq: z.number().int().min(1),
  stageGeneration: z.number().int().min(0),
  status: z.enum(RUN_STATUSES),
  goal: z.string(),
  inputRefs: z.array(inputRefSchema).default([]),
  planVersions: z.array(planVersionSchema).default([]),
  tasks: z.array(mixedTaskSchema).default([]),
  attempts: z.array(attemptSchema).default([]),
  reviewRounds: z.array(reviewRoundSchema).default([]),
  evidence: z.array(evidenceRefSchema).default([]),
  events: z.array(runEventSchema).default([]),
  cancelRequestedAt: z.string().optional(),
  error: z.object({ code: z.string(), retryable: z.boolean(), detail: z.string() }).optional(),
  /** 运行中用户新消息：排队为下一轮需求（§5.3），不修改当前目标。 */
  queuedInputs: z.array(z.object({ messageId: nonEmpty, text: z.string(), at: z.string() })).default([]),
  /** T09：规划缺关键需求时的待答问题（questionId 由宿主分配；回答后重规划）。 */
  pendingQuestions: z.array(z.object({
    questionId: nonEmpty,
    text: z.string(),
    answer: z.string().optional(),
    answeredAt: z.string().optional(),
  })).default([]),
  /** T09：待派发恢复（resume_requested 已落盘，等会话 agent 上线后补发 marker；状态离开可恢复集后失效）。 */
  pendingResume: z.object({ kind: z.enum(['continue', 'retry', 'answer']), at: z.string() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const sessionModeSchema = z.object({
  sessionId: nonEmpty,
  ownerKey: nonEmpty,
  ownerEpoch: z.number().int().min(0),
  enabled: z.boolean(),
  revision: z.number().int().min(1),
  updatedAt: z.string(),
})

export const storeGlobalSchema = z.object({
  schemaVersion: z.number().int().min(1),
  ownerKey: z.string().nullable(),
  ownerEpoch: z.number().int().min(0).default(0),
  hostId: z.string().nullable(),
  updatedAt: z.string(),
})

// ---------- 派生键（§4.1）----------
const digest = (parts) => crypto.createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex')

/** submissionKey = f(owner, profile, session, sourceMessage)：重复消息/重连/pre-step 重试 → 同一 key。 */
export function submissionKeyOf({ ownerKey, profileId, sessionId, sourceMessageId }) {
  return 'sub:' + digest([ownerKey, profileId, sessionId, sourceMessageId])
}
/** 初次 runId 由 submissionKey 派生（稳定）。 */
export function runIdOf(submissionKey) {
  return 'run-' + digest([submissionKey]).slice(0, 20)
}
/** 显式重跑：runId 由原 runId + rerunRequestId 派生；同一次重跑请求重试仍返回同一新 run。 */
export function rerunRunIdOf(runId, rerunRequestId) {
  return 'run-' + digest([runId, 'rerun', rerunRequestId]).slice(0, 20)
}
export const newId = (prefix) => `${prefix}_${crypto.randomUUID()}`

// ---------- 记录构造与推进（纯函数）----------
const nowIso = () => new Date().toISOString()

/** 新建 RunRecord（status=queued，revision=1）。调用方负责在 store 锁内 put。 */
export function newRunRecord({
  runId, ownerKey, ownerEpoch, profileId, sessionId, sourceMessageId, submissionKey,
  workspace, models, policy, goal, inputRefs, rerunRequestId, retryOfRunId, at,
}) {
  const t = at ?? nowIso()
  return {
    schemaVersion: MIXED_SCHEMA_VERSION,
    runId,
    ownerKey,
    ownerEpoch,
    profileId,
    sessionId,
    sourceMessageId,
    submissionKey,
    ...(rerunRequestId ? { rerunRequestId } : {}),
    ...(retryOfRunId ? { retryOfRunId } : {}),
    workspace,
    models,
    policy,
    revision: 1,
    eventSeq: 1,
    stageGeneration: 0,
    status: 'queued',
    goal,
    inputRefs: inputRefs ?? [],
    planVersions: [],
    tasks: [],
    attempts: [],
    reviewRounds: [],
    evidence: [],
    events: [{ eventSeq: 1, type: 'claimed', at: t, summary: '消息已领取，run 建立' }],
    pendingQuestions: [],
    createdAt: t,
    updatedAt: t,
  }
}

/**
 * 推进 run（纯函数，store 在 update 写链内调用）：
 * - 校验 owner/epoch 栅栏（旧 owner 或旧 epoch 不得推进——§4.3/§6.1）
 * - 校验 expectedRevision（进度/用量也会 bump revision，不能要求等于派发时值，用 >= 语义由调用方给）
 * - 校验状态迁移（assertRunTransition）
 * - bump revision + eventSeq，追加事件
 * @returns 新 RunRecord（不修改入参）
 */
export function advanceRun(current, {
  ownerKey, ownerEpoch, expectedRevision, to, event, patch = {},
  interrupting = false, cancelling = false, at,
}) {
  if (current.ownerKey !== ownerKey) throw new MixedError('owner_mismatch', `运行属于其他 owner`)
  if (current.ownerEpoch !== ownerEpoch) throw new MixedError('owner_epoch_stale', `运行属于旧 ownerEpoch=${current.ownerEpoch}`)
  if (typeof expectedRevision === 'number' && current.revision < expectedRevision) {
    throw new MixedError('run_revision_conflict', `运行 revision=${current.revision} 落后于 expected=${expectedRevision}`)
  }
  if (to && to !== current.status) assertRunTransition(current.status, to, { interrupting, cancelling })
  const t = at ?? nowIso()
  const eventSeq = current.eventSeq + 1
  const next = {
    ...structuredClone(current),
    ...(to ? { status: to } : {}),
    ...structuredClone(patch),
    revision: current.revision + 1,
    eventSeq,
    events: [...current.events, { eventSeq, type: event?.type ?? (to ? 'status_changed' : 'updated'), at: t, summary: event?.summary }],
    updatedAt: t,
  }
  return runRecordSchema.parse(next)
}

// ---------- 计划图校验（§4.2；T05 调度器复用）----------
/**
 * 校验任务 DAG 与验收覆盖。返回 {ok, errors[]}。
 * 规则：ID 唯一、依赖存在、无环、不依赖自身、根目标验收覆盖完整、数量/深度受限、路径合法。
 */
export function validatePlanGraph(tasks, acceptance, limits = { maxLeaves: 16, maxTotal: 32, maxDepth: 4 }) {
  const errors = []
  const byId = new Map()
  for (const t of tasks) {
    if (byId.has(t.taskId)) errors.push(`taskId 重复: ${t.taskId}`)
    byId.set(t.taskId, t)
  }
  for (const t of tasks) {
    for (const dep of t.dependsOnTaskIds) {
      if (!byId.has(dep)) errors.push(`${t.taskId} 依赖未知任务 ${dep}`)
    }
    if (t.dependsOnTaskIds.includes(t.taskId)) errors.push(`${t.taskId} 依赖自身`)
    for (const p of t.pathScope ?? []) {
      if (p.startsWith('/') || p.includes('..') || /^[a-zA-Z]:/.test(p)) errors.push(`${t.taskId} 路径非法: ${p}`)
    }
  }
  // 验收覆盖：每个验收项至少被一个任务引用（聚合父的验收由子节点覆盖时豁免——父无任务派发）
  const leafTasks = tasks.filter((t) => !byId.has(t.taskId) || !tasks.some((c) => c.parentTaskId === t.taskId))
  const covered = new Set()
  for (const t of leafTasks) for (const a of t.acceptanceIds) covered.add(a)
  const hasAggregates = tasks.some((t) => byId.has(t.taskId) && tasks.some((c) => c.parentTaskId === t.taskId))
  if (!hasAggregates) {
    for (const a of acceptance) if (!covered.has(a.id)) errors.push(`验收项 ${a.id} 未被任何任务覆盖`)
  }
  // 环检测（三色 DFS）
  const color = new Map() // 0 白 1 灰 2 黑
  const visit = (id, stack) => {
    color.set(id, 1)
    stack.push(id)
    const t = byId.get(id)
    if (t) for (const dep of t.dependsOnTaskIds) {
      if (!byId.has(dep)) continue
      const c = color.get(dep) ?? 0
      if (c === 1) {
        const i = stack.indexOf(dep)
        errors.push(`依赖环: ${stack.slice(i).join(' → ')} → ${dep}`)
      } else if (c === 0) visit(dep, stack)
    }
    stack.pop()
    color.set(id, 2)
  }
  for (const id of byId.keys()) if ((color.get(id) ?? 0) === 0) visit(id, [])
  // 规模/深度
  const leaves = tasks.filter((t) => !tasks.some((c) => c.parentTaskId === t.taskId))
  if (leaves.length > limits.maxLeaves) errors.push(`叶子任务 ${leaves.length} 超过上限 ${limits.maxLeaves}`)
  if (tasks.length > limits.maxTotal) errors.push(`任务总数 ${tasks.length} 超过上限 ${limits.maxTotal}`)
  const depthOf = (id, seen = new Set()) => {
    if (seen.has(id)) return 0
    seen.add(id)
    const t = byId.get(id)
    if (!t || !t.dependsOnTaskIds.length) return 1
    return 1 + Math.max(...t.dependsOnTaskIds.map((d) => depthOf(d, seen)))
  }
  const maxDepth = Math.max(0, ...tasks.map((t) => depthOf(t.taskId)))
  if (maxDepth > limits.maxDepth) errors.push(`任务层级 ${maxDepth} 超过上限 ${limits.maxDepth}`)
  return { ok: errors.length === 0, errors }
}

/** 某任务的依赖是否全部满足（§5.2：executed/accepted 且证据未失效）。 */
export function taskReady(task, byId) {
  if (task.status !== 'pending' && task.status !== 'ready') return false
  for (const dep of task.dependsOnTaskIds) {
    const d = byId.get(dep)
    if (!d || !TASK_DEP_SATISFIED.has(d.status)) return false
  }
  return true
}

// ---------- 恢复 marker（T09）----------
//
// 恢复执行需要一次「真实会话 turn」承载交付（§7.2：交付步走既有的 enter+插件消息
// 机制，不新造会话事件）。宿主用内核公开的 agent.followup() 排一条 plugin 来源的
// marker 消息；桥接在 pre-step 识别 marker 后在同一 turn 内重入控制器执行恢复，
// 成功 enter+[交付消息] / 失败 reject（父模型不实施）。marker 文本即协议：
//   [MIXED_RESUME] run=<runId> choice=<continue|retry|answer>
export const RESUME_MARKER_PREFIX = '[MIXED_RESUME]'

/** 构造恢复 marker 消息文本（宿主 followup 用）。答案正文不进 marker，只落 run.pendingQuestions。 */
export function resumeMarkerText(runId, choice = 'continue') {
  return `${RESUME_MARKER_PREFIX} run=${runId} choice=${choice}`
}

/** 解析 marker 文本；非 marker 返回 null。 */
export function parseResumeMarker(text) {
  if (typeof text !== 'string') return null
  const m = text
    .trim()
    .match(/^(\[MIXED_RESUME\])\s+run=(run-[0-9a-f]+)\s+choice=(continue|retry|answer)\s*$/)
  if (!m) return null
  return { runId: m[2], choice: m[3] }
}
