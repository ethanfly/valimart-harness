/**
 * Mixed 本机 API（T07）：/desk/api 下的 mixed 路由（配置 / 会话模式 / 运行状态 / 取消 / 恢复 / 重跑 / 证据）。
 *
 * 计划 §7.1：均经现有 /desk/api 同源与登录校验。本模块是纯可注入层（不依赖 HTTP 服务/内核），
 * 由 index.js 的 /desk/api 前缀处理器把 /mixed/* 与 /sessions/:id/mixed 转交给 handle()；
 * 测试直接构造 handle 入参（method/path/headers/req 流）断言 {status, body}。
 *
 * 安全（每请求，按序）：
 *  1) 同源：sec-fetch-site / origin-host 不匹配 → 403 bad_origin（与 /desk/api 外层同规则，纵深防御）；
 *  2) 登录：getIdentity() 未登录 → 401 unauthenticated；
 *  3) owner：登录但 ownerKey 未解析（网关实例 id 未同步）→ 503 owner_not_resolved；
 *  4) 请求体限额（默认 256KB）→ 413 body_too_large；非 JSON 内容类型 → 415；
 *  5) 归属：run 级读取一律 getRun(runId, {ownerKey})——跨账号/跨实例 ID 不可访问（403/404）。
 *
 * 语义要点：
 *  - 长任务不占 HTTP：cancel/resume/rerun 都是「持久化意图 + 立即 202 + 当前状态」，
 *    绝不 await run 收敛（收敛由控制器/桥接在 turn 内完成）。
 *  - 轮询：GET /mixed/runs/:id?afterRevision=N → revision 未前进 = unchanged（客户端不覆盖新状态）。
 *  - 证据：只按 evidenceId 受控读取（collector 边界校验），不接受客户端任意文件路径。
 */
import {
  MixedError,
  RUN_TERMINAL,
  RUN_RESUMABLE,
  RUN_CANCELLABLE,
  advanceRun,
  rerunRunIdOf,
} from './contracts.js'

const ROLES = ['planner', 'executor', 'reviewer']
const RESUME_CHOICES = new Set(['continue', 'retry'])
const EVIDENCE_KINDS = new Set(['record', 'stdout', 'stderr'])

/** 同源校验（与 index.js /desk/api 外层同规则；headers 全小写）。 */
export function originAllowed(headers = {}) {
  const secFetch = String(headers['sec-fetch-site'] ?? '')
  if (secFetch && !['same-origin', 'same-site', 'none'].includes(secFetch)) return false
  const origin = headers['origin']
  if (origin) {
    try {
      if (!headers['host'] || new URL(origin).host !== String(headers['host'])) return false
    } catch {
      return false
    }
  }
  return true
}

/** 请求体读取（限额 + JSON 校验）。POST/PUT/PATCH 用；超限 413，非 JSON 415，坏 JSON 400。 */
async function readJsonBody(req, maxBytes) {
  if (!req) return {}
  const ct = String(req.headers?.['content-type'] ?? req.contentType ?? '')
  if (ct && !ct.includes('application/json') && !ct.includes('text/json')) {
    throw Object.assign(new Error('请求体必须是 application/json'), { status: 415, code: 'bad_request' })
  }
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > maxBytes) throw Object.assign(new Error(`请求体超过 ${maxBytes} 字节限额`), { status: 413, code: 'body_too_large' })
    chunks.push(c)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400, code: 'bad_request' })
  }
}

function mixedErrorOut(err) {
  if (err instanceof MixedError) {
    return { status: err.httpStatus, body: { error: { message: err.message, code: err.code, retryable: err.retryable } } }
  }
  if (err && Number.isInteger(err.status)) {
    return { status: err.status, body: { error: { message: err.message, code: err.code ?? 'error', retryable: false } } }
  }
  return { status: 500, body: { error: { message: String(err?.message ?? err), code: 'internal', retryable: false } } }
}

/**
 * @param {object} deps
 * @param {object} deps.store 已 open 的 MixedStore
 * @param {() => ({loggedIn, ownerKey, ownerEpoch, userId} | null) | Promise<...>} deps.getIdentity 当前登录身份（可同步可异步）
 * @param {object} deps.modelRoutes ModelRoutes（网关目录快照 + 角色解析）
 * @param {Map} [deps.controllers] 活动 runId → MixedRunController（与会话桥接共享；cancel 用）
 * @param {{readEvidence(runId, evidenceId, {kind, offset, limit}): object}} [deps.evidence] EvidenceCollector
 * @param {string} [deps.profileId] profile id（rerun 派生用）
 * @param {(sessionId) => boolean} [deps.sessionExists] 会话归属校验（宿主侧：本机 profile 的会话）
 * @param {(sessionId) => Promise<{attached: boolean, reason?: string}>} [deps.attachAgent] 立即尝试挂载会话桥接（T08 生产运行）
 * @param {(sessionId) => void} [deps.onSessionInterested] 宿主保持桥接关注的通知（启用 Mixed/attach 时）
 * @param {(runId, request, ownerKey) => Promise<{started: boolean, reason?: string}>} [deps.onResume]
 *   T09 恢复触发：resume_requested 落盘后由宿主派发恢复 marker（agent 在线即 followup；
 *   离线留 pendingResume，agent 上线后宿主自动补发）。
 * @param {number} [deps.maxBodyBytes=262144] 请求体限额
  * @param {(runId) => Promise<object|null>} [deps.fetchRunUsage] T10 用量聚合（网关 /api/mixed/usage，5s 内存缓存）
 * @param {number} [deps.maxEvidenceBytes=131072] 单次证据读取上限
 * @param {object} [deps.logger]
 */
export function createMixedApi({
  store,
  getIdentity,
  modelRoutes,
  controllers,
  evidence,
  profileId,
  sessionExists = () => true,
  attachAgent = null,
  onSessionInterested = null,
  onResume = null,
  fetchRunUsage = null,
  maxBodyBytes = 256 * 1024,
  maxEvidenceBytes = 128 * 1024,
  logger = { warn: () => {}, error: () => {} },
}) {
  // T10 用量聚合内存缓存（面板 1s 轮询 → 网关 5s 一次）；null 也缓存（失败不重试风暴）
  const usageCache = new Map() // runId → { at, value }
  const USAGE_CACHE_MS = 5_000
  // 存储健康快照（2s 缓存）：写链挂起时 run 收敛不可落盘，UI 必须能独立看到降级状态
  let healthCache = { at: 0, value: null }
  const HEALTH_CACHE_MS = 2_000
  function storageHealth() {
    if (!store?.getHealth) return null
    if (healthCache.value && Date.now() - healthCache.at < HEALTH_CACHE_MS) return healthCache.value
    try {
      healthCache = { at: Date.now(), value: store.getHealth() }
    } catch {
      healthCache = { at: Date.now(), value: { healthy: false, writeLocked: { reason: 'health_read_failed' }, degradation: null } }
    }
    return healthCache.value
  }
  async function fetchUsageCached(runId) {
    if (!fetchRunUsage) return null
    const hit = usageCache.get(runId)
    if (hit && Date.now() - hit.at < USAGE_CACHE_MS) return hit.value
    let value = null
    try {
      value = await fetchRunUsage(runId)
    } catch {
      value = null
    }
    usageCache.set(runId, { at: Date.now(), value })
    if (usageCache.size > 64) {
      const oldest = [...usageCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) usageCache.delete(oldest[0])
    }
    return value
  }
  /**
   * 处理一个 mixed 路由请求。
   * @param {object} env {method, path, headers, req?}  path 为 /desk/api 之后的相对路径（可带 query）
   * @returns {Promise<{status: number, body: object}>}
   */
  async function handle({ method = 'GET', path, headers = {}, req } = {}) {
    try {
      // 1) 同源
      if (!originAllowed(headers)) return { status: 403, body: { error: { message: '跨站请求被拒绝', code: 'bad_origin' } } }
      // 2) 登录
      const identity = (await getIdentity?.()) ?? null
      if (!identity?.loggedIn) return { status: 401, body: { error: { message: '未登录公司网关', code: 'unauthenticated', retryable: false } } }
      // 3) owner 解析
      if (!identity.ownerKey) return { status: 503, body: { error: { message: 'owner 身份未解析（网关实例 id 未同步）', code: 'owner_not_resolved', retryable: true } } }
      const ownerKey = identity.ownerKey
      const ownerEpoch = Number.isInteger(identity.ownerEpoch) ? identity.ownerEpoch : 0

      const u = new URL(String(path ?? '/'), 'http://localhost')
      const rel = u.pathname
      const q = u.searchParams

      // ---------- 配置 ----------
      if (rel === '/mixed/config') {
        if (method === 'GET') return handleGetConfig(ownerKey)
        if (method === 'POST') return await handlePostConfig(ownerKey, ownerEpoch, req)
        return notAllowed()
      }

      // ---------- 会话 Mixed 模式 ----------
      const sm = rel.match(/^\/sessions\/([^/]+)\/mixed$/)
      if (sm) {
        const sessionId = decodeURIComponent(sm[1])
        if (method === 'GET') return handleSessionModeGet(sessionId, ownerKey)
        if (method === 'POST') return await handleSessionModePost(sessionId, ownerKey, ownerEpoch, req)
        return notAllowed()
      }

      // ---------- 会话桥接挂载 ping（T08：客户端打开会话/启用 Mixed 时立即尝试） ----------
      const at = rel.match(/^\/sessions\/([^/]+)\/mixed\/attach$/)
      if (at) {
        const sessionId = decodeURIComponent(at[1])
        if (method !== 'POST') return notAllowed()
        return await handleSessionAttach(sessionId, ownerKey)
      }

      // ---------- 运行列表 ----------
      if (rel === '/mixed/runs') {
        if (method === 'GET') return handleRunsList(ownerKey, q)
        return notAllowed()
      }

      // ---------- 运行详情（轮询：afterRevision）----------
      const dm = rel.match(/^\/mixed\/runs\/([^/]+)$/)
      if (dm) {
        if (method === 'GET') return await handleRunDetail(decodeURIComponent(dm[1]), ownerKey, q)
        return notAllowed()
      }

      // ---------- 取消 / 恢复 / 重跑 ----------
      const am = rel.match(/^\/mixed\/runs\/([^/]+)\/(cancel|resume|rerun)$/)
      if (am) {
        if (method !== 'POST') return notAllowed()
        const runId = decodeURIComponent(am[1])
        if (am[2] === 'cancel') return await handleCancel(runId, ownerKey, req)
        if (am[2] === 'resume') return await handleResume(runId, ownerKey, req)
        return await handleRerun(runId, ownerKey, ownerEpoch, req)
      }

      // ---------- 证据（受控读取）----------
      const em = rel.match(/^\/mixed\/runs\/([^/]+)\/evidence\/([^/]+)$/)
      if (em) {
        if (method !== 'GET') return notAllowed()
        return handleEvidence(decodeURIComponent(em[1]), decodeURIComponent(em[2]), ownerKey, q)
      }

      return { status: 404, body: { error: { message: `no mixed route ${method} ${rel}`, code: 'mixed_not_found' } } }
    } catch (err) {
      return mixedErrorOut(err)
    }
  }

  function notAllowed() {
    return { status: 405, body: { error: { message: '方法不允许', code: 'method_not_allowed', retryable: false } } }
  }

  // ---------- 配置 ----------

  function handleGetConfig(ownerKey) {
    const prefs = store.getPreferences(ownerKey)
    let snap = modelRoutes?.snapshot ?? null
    let catalogError = null
    if (!snap && typeof modelRoutes?.refresh === 'function') {
      // 目录未同步：GET 触发一次后台同步（失败不阻塞，诊断可见）
      modelRoutes.refresh().then(
        (s) => { snap = s },
        (e) => { catalogError = String(e?.message ?? e) },
      )
    }
    const problems = []
    if (prefs && snap) {
      try {
        problems.push(...modelRoutes.validateRunModels({ planner: prefs.planner, executor: prefs.executor, reviewer: prefs.reviewer }).problems)
      } catch {
        /* 目录快照不完整：诊断留空 */
      }
    }
    return {
      status: 200,
      body: {
        preferences: prefs
          ? { revision: prefs.revision, ownerEpoch: prefs.ownerEpoch, planner: prefs.planner, executor: prefs.executor, reviewer: prefs.reviewer, updatedAt: prefs.updatedAt }
          : null,
        catalog: snap
          ? { capabilitiesRevision: snap.capabilitiesRevision, fetchedAt: snap.fetchedAt, models: snap.rawModels, conflicts: snap.conflicts }
          : null,
        catalogError,
        diagnostics: { configured: !!(prefs?.planner && prefs.executor && prefs.reviewer), problems },
      },
    }
  }

  async function handlePostConfig(ownerKey, ownerEpoch, req) {
    const body = await readJsonBody(req, maxBodyBytes)
    for (const role of ROLES) {
      const route = body[role]
      if (!route || typeof route.catalogProvider !== 'string' || !route.catalogProvider || typeof route.modelId !== 'string' || !route.modelId) {
        throw new MixedError('bad_request', `缺少 ${role} 路由（需 {catalogProvider, modelId}）`)
      }
    }
    const resolved = {}
    for (const role of ROLES) resolved[role] = modelRoutes.resolveRole(role, body[role]) // 422：模型不存在/目录冲突
    const saved = await store.savePreferences(ownerKey, {
      planner: resolved.planner,
      executor: resolved.executor,
      reviewer: resolved.reviewer,
      ownerEpoch,
      expectedRevision: typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined,
    }) // 409：config_revision_conflict
    return {
      status: 200,
      body: { preferences: { revision: saved.revision, ownerEpoch: saved.ownerEpoch, planner: saved.planner, executor: saved.executor, reviewer: saved.reviewer, updatedAt: saved.updatedAt } },
    }
  }

  // ---------- 会话模式 ----------

  function activeRunOf(ownerKey, sessionId) {
    return store.listRuns({ ownerKey, sessionId, limit: 20 }).items.find((r) => !RUN_TERMINAL.has(r.status)) ?? null
  }

  function handleSessionModeGet(sessionId, ownerKey) {
    if (!sessionExists(sessionId)) throw new MixedError('session_not_found', `会话 ${sessionId} 不存在`)
    const rawMode = store.getSessionMode(sessionId) // 无过滤：判断归属
    if (rawMode && rawMode.ownerKey !== ownerKey) throw new MixedError('owner_mismatch', '该会话的 Mixed 模式属于其他账号')
    const mode = rawMode // 归属一致（或 null=未设置）
    const active = activeRunOf(ownerKey, sessionId)
    const prefs = store.getPreferences(ownerKey)
    return {
      status: 200,
      body: {
        sessionId,
        mode: mode ? { enabled: mode.enabled, revision: mode.revision, ownerEpoch: mode.ownerEpoch } : null,
        activeRun: active ? { runId: active.runId, status: active.status, revision: active.revision } : null,
        canToggle: !active,
        configured: !!(prefs?.planner && prefs.executor && prefs.reviewer),
        storage: storageHealth(),
      },
    }
  }

  async function handleSessionModePost(sessionId, ownerKey, ownerEpoch, req) {
    if (!sessionExists(sessionId)) throw new MixedError('session_not_found', `会话 ${sessionId} 不存在`)
    const body = await readJsonBody(req, maxBodyBytes)
    if (typeof body.enabled !== 'boolean') throw new MixedError('bad_request', 'enabled 必须是布尔值')
    const rawMode = store.getSessionMode(sessionId)
    if (rawMode && rawMode.ownerKey !== ownerKey) throw new MixedError('owner_mismatch', '该会话的 Mixed 模式属于其他账号')
    const active = activeRunOf(ownerKey, sessionId)
    if (active) throw new MixedError('run_not_idle', `会话有活动运行 ${active.runId}（${active.status}），先停止再切换`)
    const mode = await store.setSessionMode({
      sessionId,
      ownerKey,
      ownerEpoch,
      enabled: body.enabled,
      expectedRevision: typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined,
    }) // 409：config_revision_conflict
    let attached = null
    if (body.enabled && typeof attachAgent === 'function') {
      onSessionInterested?.(sessionId)
      try {
        attached = await attachAgent(sessionId)
      } catch (e) {
        logger.warn?.(`attach（启用 Mixed 后）失败: ${e.message}`)
        attached = { attached: false, reason: 'attach_failed' }
      }
    }
    return { status: 200, body: { mode: { enabled: mode.enabled, revision: mode.revision, ownerEpoch: mode.ownerEpoch }, attached } }
  }

  /** 桥接挂载 ping：幂等；agent 未上线时 reason=agent_not_live（轮询兜底会再试）。 */
  async function handleSessionAttach(sessionId, ownerKey) {
    if (!sessionExists(sessionId)) throw new MixedError('session_not_found', `会话 ${sessionId} 不存在`)
    const rawMode = store.getSessionMode(sessionId)
    if (rawMode && rawMode.ownerKey !== ownerKey) throw new MixedError('owner_mismatch', '该会话的 Mixed 模式属于其他账号')
    onSessionInterested?.(sessionId)
    if (typeof attachAgent !== 'function') return { status: 200, body: { sessionId, attached: false, reason: 'runtime_unavailable' } }
    const result = await attachAgent(sessionId)
    return { status: 200, body: { sessionId, ...result } }
  }

  // ---------- 运行 ----------

  function runSummary(r) {
    // 列表限定返回字段（不暴露 events/evidence/attempts 明细；详情走单 run 路由）
    return {
      runId: r.runId,
      status: r.status,
      revision: r.revision,
      eventSeq: r.eventSeq,
      goal: r.goal,
      sessionId: r.sessionId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      planVersions: (r.planVersions ?? []).map((p) => ({ version: p.version, tasks: p.tasks })),
      tasks: (r.tasks ?? []).map((t) => ({ taskId: t.taskId, title: t.title, status: t.status })),
      error: r.error ? { code: r.error.code } : null,
      ...(r.retryOfRunId ? { rerun: { parentRunId: r.retryOfRunId, rerunRequestId: r.rerunRequestId ?? null } } : {}),
    }
  }

  function handleRunsList(ownerKey, q) {
    const limit = Math.min(Math.max(Number(q.get('limit') ?? 50) || 50, 1), 100)
    const cursor = Number(q.get('cursor') ?? 0) || 0
    const { items, nextCursor } = store.listRuns({ ownerKey, sessionId: q.get('sessionId') ?? undefined, cursor, limit })
    return { status: 200, body: { items: items.map(runSummary), nextCursor } }
  }

  function getOwnedRun(runId, ownerKey) {
    const run = store.getRun(runId, { ownerKey }) // 跨 owner → MixedError owner_mismatch(403)
    if (!run) throw new MixedError('run_not_found', `run ${runId} 不存在或不属于当前 owner`)
    return run
  }

  async function handleRunDetail(runId, ownerKey, q) {
    const run = getOwnedRun(runId, ownerKey)
    const after = Number(q.get('afterRevision') ?? 0) || 0
    // 轮询：revision 未前进 → unchanged（客户端不得用旧响应覆盖新状态）
    if (after > 0 && run.revision <= after) {
      return { status: 200, body: { changed: false, runId, status: run.status, revision: run.revision } }
    }
    return {
      status: 200,
      body: {
        changed: true,
        runId,
        status: run.status,
        revision: run.revision,
        eventSeq: run.eventSeq,
        stageGeneration: run.stageGeneration,
        goal: run.goal,
        sessionId: run.sessionId,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        workspace: run.workspace,
        // T10 用量（网关账本关联）：null = 归属未启用/网关不可达（面板不显示用量块，不显示 0）
        usage: await fetchUsageCached(runId),
        // 存储健康：写链挂起/写失败时 healthy=false + 降级标记（面板横幅提示；磁盘 run 状态可能滞后）
        storage: storageHealth(),
        // T08 面板：run 创建时的角色模型快照（运行中固定，不因设置保存变化）
        models: run.models
          ? {
              planner: { catalogProvider: run.models.planner.catalogProvider, modelId: run.models.planner.modelId },
              executor: { catalogProvider: run.models.executor.catalogProvider, modelId: run.models.executor.modelId },
              reviewer: { catalogProvider: run.models.reviewer.catalogProvider, modelId: run.models.reviewer.modelId },
            }
          : null,
        planVersions: run.planVersions ?? [],
        tasks: run.tasks ?? [],
        attempts: (run.attempts ?? []).map((a) => ({
          attemptId: a.attemptId,
          stage: a.stage,
          taskId: a.taskId ?? null,
          planVersion: a.planVersion,
          stopReason: a.stopReason ?? null,
          startedAt: a.startedAt,
          endedAt: a.endedAt ?? null,
          usage: a.usage ?? null,
          // T08 面板「实际模型」：派发时角色路由快照（宿主解析，规划器不能选）
          model: a.route ? { catalogProvider: a.route.catalogProvider, modelId: a.route.modelId } : null,
        })),
        reviewRounds: (run.reviewRounds ?? []).map((r) => ({
          roundId: r.roundId,
          planVersion: r.planVersion,
          evidenceManifestHash: r.evidenceManifestHash,
          verdict: r.result?.verdict ?? null,
          startedAt: r.startedAt,
          endedAt: r.endedAt ?? null,
          // T08 面板「审核发现」：验收项判定 + findings（含返修指令）
          result: r.result ?? null,
        })),
        evidence: (run.evidence ?? []).map((e) => ({
          evidenceId: e.evidenceId,
          type: e.type,
          producer: e.producer,
          invalidated: e.invalidated,
          truncated: e.truncated,
          size: e.size ?? null,
        })),
        // 事件按 eventSeq 去重：只回 after 之后的增量
        events: (run.events ?? []).filter((e) => e.eventSeq > after),
        queuedInputs: run.queuedInputs ?? [],
        pendingQuestions: run.pendingQuestions ?? [],
        error: run.error ?? null,
        ...(run.retryOfRunId ? { rerun: { parentRunId: run.retryOfRunId, rerunRequestId: run.rerunRequestId ?? null } } : {}),
      },
    }
  }

  async function handleCancel(runId, ownerKey, req) {
    await readJsonBody(req, maxBodyBytes) // 消耗请求体（可为空）
    const run = getOwnedRun(runId, ownerKey)
    const controller = controllers?.get?.(runId)
    if (controller) {
      // 活动控制器：持久化取消意图 + 级联 abort（不等待收敛——收敛在 turn 内完成）
      await controller.requestStop('user-stop')
    } else if (!RUN_TERMINAL.has(run.status)) {
      // 孤儿 run（本宿主无活动控制器，如宿主重启后遗留）：直接收敛 cancelled
      if (RUN_CANCELLABLE.has(run.status)) {
        await store.updateRun(runId, (c) =>
          advanceRun(c, {
            ownerKey: c.ownerKey,
            ownerEpoch: c.ownerEpoch,
            to: 'cancelling',
            cancelling: true,
            event: { type: 'cancel_requested', summary: '停止（无活动控制器，直接收敛）' },
          }),
        )
      }
      const mid = store.getRun(runId, { ownerKey })
      if (mid && mid.status === 'cancelling') {
        await store.updateRun(runId, (c) =>
          advanceRun(c, {
            ownerKey: c.ownerKey,
            ownerEpoch: c.ownerEpoch,
            to: 'cancelled',
            event: { type: 'status_changed', summary: '已停止：无活动控制器，直接收敛' },
          }),
        )
      }
    }
    const cur = store.getRun(runId, { ownerKey })
    return { status: 202, body: { runId, status: cur?.status ?? run.status, accepted: true } }
  }

  async function handleResume(runId, ownerKey, req) {
    const run = getOwnedRun(runId, ownerKey)
    const body = await readJsonBody(req, maxBodyBytes)
    if (!RUN_RESUMABLE.has(run.status)) {
      throw new MixedError('run_not_in_status', `仅 ${[...RUN_RESUMABLE].join('/')} 可恢复，当前 ${run.status}`)
    }
    const expected = typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined
    if (expected !== undefined && run.revision !== expected) {
      throw new MixedError('run_revision_conflict', `run revision=${run.revision} 与预期 ${expected} 不符`)
    }
    // 恢复选择 / 补充输入
    let request
    let answeredPairs = []
    if (run.status === 'waiting_input') {
      if (Array.isArray(body.answers) && body.answers.length) {
        answeredPairs = body.answers.map((a) => ({ questionId: a?.questionId, answer: a?.answer }))
      } else if (typeof body.questionId === 'string' && body.questionId) {
        if (typeof body.answer !== 'string') throw new MixedError('question_mismatch', '缺少 answer（回答文本）')
        answeredPairs = [{ questionId: body.questionId, answer: body.answer }]
      } else {
        throw new MixedError('question_mismatch', 'waiting_input 恢复必须携带 questionId+answer（或 answers[]）')
      }
      const pending = run.pendingQuestions ?? []
      for (const pair of answeredPairs) {
        if (typeof pair.questionId !== 'string' || !pair.questionId) throw new MixedError('question_mismatch', 'answers 含空 questionId')
        if (typeof pair.answer !== 'string') throw new MixedError('question_mismatch', `问题 ${pair.questionId} 缺少 answer`)
        const q = pending.find((x) => x.questionId === pair.questionId)
        if (!q) throw new MixedError('question_mismatch', `questionId=${pair.questionId} 不是当前待答问题`)
      }
      request = { kind: 'answer', questionId: answeredPairs[0].questionId, answer: answeredPairs[0].answer, answers: answeredPairs }
    } else {
      const choice = body.choice ?? 'continue'
      if (!RESUME_CHOICES.has(choice)) throw new MixedError('bad_request', `未知恢复选择: ${choice}（可用: ${[...RESUME_CHOICES].join('/')}）`)
      request = { kind: choice }
    }
    // 先对账：写链内复查状态/revision，再落 resume_requested + pendingResume（旧代际/状态已变 → 409）。
    const markerResume = request.kind === 'continue' || request.kind === 'retry' || request.kind === 'answer'
    await store.updateRun(runId, (c) => {
      if (!RUN_RESUMABLE.has(c.status)) throw new MixedError('run_not_in_status', `状态已变为 ${c.status}，不可恢复`)
      if (expected !== undefined && c.revision !== expected) throw new MixedError('run_revision_conflict', `run revision=${c.revision} 与预期 ${expected} 不符（对账失败）`)
      const now = new Date().toISOString()
      const byId = new Map(answeredPairs.map((a) => [a.questionId, a.answer]))
      return advanceRun(c, {
        ownerKey: c.ownerKey,
        ownerEpoch: c.ownerEpoch,
        event: { type: 'resume_requested', summary: `恢复: ${request.kind}${request.questionId ? ` question=${request.questionId}` : ''}` },
        patch: {
          ...(markerResume ? { pendingResume: { kind: request.kind, at: now } } : {}),
          ...(byId.size
            ? {
                pendingQuestions: (c.pendingQuestions ?? []).map((q) =>
                  byId.has(q.questionId) ? { ...q, answer: byId.get(q.questionId), answeredAt: now } : q,
                ),
              }
            : {}),
        },
      })
    })
    // T09 恢复触发：agent 在线 → followup marker（桥接 pre-step 重入执行）；离线 → 留 pendingResume
    let resumeInfo = null
    if (typeof onResume === 'function') {
      try {
        resumeInfo = await onResume(runId, request, ownerKey)
      } catch (e) {
        resumeInfo = { started: false, reason: `onResume 触发失败: ${e.message}` }
        logger.warn?.(`onResume 失败（${runId}）: ${e.message}`)
      }
    }
    const cur = store.getRun(runId, { ownerKey })
    return {
      status: 202,
      body: { runId, status: cur.status, resumeRequest: request, accepted: true, ...(resumeInfo ? { resume: resumeInfo } : {}) },
    }
  }

  /** 原产物与验收快照（重跑防「把重跑误作重置文件」）。 */
  function buildRerunSnapshot(parent) {
    const lines = [`[重跑快照] 本 run 是 ${parent.runId} 的重跑（非文件重置）：工作区已有产物，规划时以现有产物为输入。`]
    const lastPlan = (parent.planVersions ?? []).at(-1)
    if (lastPlan) {
      lines.push(`上一计划 v${lastPlan.version} 验收项：`)
      for (const a of lastPlan.acceptance ?? []) lines.push(`- ${a.id}: ${a.description}`)
    }
    const lastRound = (parent.reviewRounds ?? []).at(-1)
    if (lastRound?.result) lines.push(`上一审核结论: ${lastRound.result.verdict} — ${lastRound.result.summary}`)
    for (const e of parent.evidence ?? []) {
      if (e.type === 'file-manifest' || e.type === 'verification') {
        lines.push(`证据 ${e.evidenceId}: ${e.type}（指纹 ${String(e.fingerprint).slice(0, 12)}…${e.invalidated ? '，已作废' : ''}）`)
      }
    }
    return lines.join('\n')
  }

  async function handleRerun(parentRunId, ownerKey, ownerEpoch, req) {
    const parent = getOwnedRun(parentRunId, ownerKey)
    const body = await readJsonBody(req, maxBodyBytes)
    const rerunRequestId = typeof body.rerunRequestId === 'string' ? body.rerunRequestId.trim() : ''
    if (!rerunRequestId) throw new MixedError('bad_request', '缺少 rerunRequestId（幂等键）')
    if (RUN_CANCELLABLE.has(parent.status)) {
      throw new MixedError('run_not_idle', `仅静止运行（succeeded/blocked/cancelled）可重跑，当前 ${parent.status}`)
    }
    const prefs = store.getPreferences(ownerKey)
    if (!prefs?.planner || !prefs?.executor || !prefs?.reviewer) throw new MixedError('mixed_not_configured', 'Mixed 三路由配置不齐全')
    if (typeof body.configRevision === 'number' && prefs.revision !== body.configRevision) {
      throw new MixedError('config_revision_conflict', `配置 revision=${prefs.revision} 与预期 ${body.configRevision} 不符（设置已被改动，请刷新）`)
    }
    // 幂等：同一次重跑请求（原 runId + rerunRequestId）重试 → 同一新 run
    const newRunId = rerunRunIdOf(parentRunId, rerunRequestId)
    const existing = store.getRun(newRunId, { ownerKey })
    if (existing) return { status: 200, body: { runId: newRunId, parentRunId, status: existing.status, created: false } }
    const snapshot = buildRerunSnapshot(parent)
    const { run } = await store.claimRun({
      runId: newRunId,
      ownerKey,
      ownerEpoch,
      profileId: profileId ?? parent.profileId,
      sessionId: parent.sessionId,
      sourceMessageId: `rerun:${parentRunId}:${rerunRequestId}`,
      submissionKey: `sub-rerun:${newRunId}`,
      workspace: { canonicalPath: parent.workspace.canonicalPath, baselineId: 'pending' },
      models: { planner: prefs.planner, executor: prefs.executor, reviewer: prefs.reviewer },
      policy: { maxRepairRounds: 2, maxReplans: 1 },
      goal: parent.goal,
      inputRefs: [...(parent.inputRefs ?? []), { kind: 'text', messageId: `rerun-snapshot:${parentRunId}`, text: snapshot }],
      rerunRequestId,
      retryOfRunId: parentRunId,
    })
    logger.warn?.(`mixed rerun: ${parentRunId} → ${run.runId}（${rerunRequestId}）`)
    return { status: 202, body: { runId: run.runId, parentRunId, status: run.status, created: true } }
  }

  // ---------- 证据（受控读取：只认 evidenceId，边界由 collector 再校验）----------

  function handleEvidence(runId, evidenceId, ownerKey, q) {
    getOwnedRun(runId, ownerKey) // 归属校验（证据属于 run，不跨账号）
    if (!evidence?.readEvidence) {
      throw new MixedError('evidence_unavailable', '证据接口未初始化')
    }
    const kind = EVIDENCE_KINDS.has(q.get('kind')) ? q.get('kind') : 'record'
    const offset = Number(q.get('offset') ?? 0) || 0
    const limit = Math.min(Math.max(Number(q.get('limit') ?? 8000) || 8000, 1), maxEvidenceBytes)
    return { status: 200, body: evidence.readEvidence(runId, evidenceId, { kind, offset, limit }) }
  }

  return { handle, originAllowed }
}
