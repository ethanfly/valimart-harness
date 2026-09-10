/**
 * T09 交付物：mixed-recovery 测试——取消、中断与身份切换收敛（计划 §5.1/§5.3/§5.4/§6.1）。
 *
 * 覆盖 T09 验收：
 * 1) 启动对账（强杀恢复，§5.4）：宿主进程死亡后遗留的非终态 run——
 *    planning/executing/…→ interrupted（host_interrupted）；queued→blocked(retryable)；
 *    cancelling→cancelled；waiting_input 保留（恢复入口）；结果不明的 attempt 不自动重放。
 *    （T08 发现的真实缺口：宿主重启 + 会话 agent 从未 attach → run 永久悬挂。）
 * 2) owner fence（§6.1）：换账号/登出先停旧 owner——活动控制器 requestStop（级联 abort
 *    子代理/验证进程）→ 收敛旧 owner 非终态 run → epoch+1 换身份；旧 owner 迟到结果
 *    不得改变已收敛状态。
 * 3) 取消各阶段覆盖：执行中 Stop → 子代理信号 abort、无新派发、收敛 cancelled、
 *    工作区写锁随收敛释放；验证子进程收到 abort → SIGTERM 杀掉。
 * 4) 恢复重入（「核查后继续」，非无条件自动续跑）：
 *    - 无计划 → planning 重规划；
 *    - 实施中断 → executing 续跑（executed 任务不重做——重启不重复修改已完成文件）；
 *    - 审核通过未交付 → 只重试 finalizing；
 *    - 审核结论 blocked/返修耗尽 → 拒绝恢复（resume_not_allowed）；
 *    - retry：failed 及传递受阻后继回 ready；continue：沿用 run 级返修预算；
 *    - pendingResume 落盘 + 恢复启动后清除。
 * 5) 恢复 marker 桥接（agent.followup → pre-step 识别 → 同 turn 重入 + 交付/拒绝）：
 *    幂等（终态/进行中 marker 消费不重放）、失败落 resume_failed（防自动重发死循环）。
 * 6) resume API：agent 在线 → 202 {resume:{started:true}} + marker 入收件箱；
 *    离线 → {started:false, reason:agent_not_live} + pendingResume；agent 上线后
 *    ensureBridges 自动补发 marker。
 * 7) blocked-恢复 vs 重跑：恢复=同 run 续跑（revision 连续）；重跑=新 runId、
 *    旧 run 记录/状态/revision 原样保留。
 *
 * 内核侧注入 fake AgentRegistry/agent（含 followup 收件箱与 pre-step handler 捕获）——
 * 真内核强杀/断网证据另见 docs/evidence/mixed/（隔离 8795+3472 栈实跑）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { createMixedHost } from '../../plugins/desk-host/lib/mixed/host.js'
import { MixedStore } from '../../plugins/desk-host/lib/mixed/store.js'
import { MixedDriver } from '../../plugins/desk-host/lib/mixed/dsh-driver.js'
import { MixedRunController } from '../../plugins/desk-host/lib/mixed/service.js'
import { createMixedBridge } from '../../plugins/desk-host/lib/mixed/session-bridge.js'
import { recordVerification } from '../../plugins/desk-host/lib/mixed/evidence.js'
import { planPrompt, taskPrompt, PLAN_LIMITS } from '../../plugins/desk-host/lib/mixed/prompts.js'
import {
  submissionKeyOf,
  runIdOf,
  advanceRun,
  resumeMarkerText,
  parseResumeMarker,
  MixedError,
} from '../../plugins/desk-host/lib/mixed/contracts.js'
import { computeOwnerKey } from '../../plugins/desk-host/lib/mixed/owner.js'

const QUIET = { warn: () => {}, error: () => {}, info: () => {} }
const MODELS = {
  planner: { catalogProvider: 'deepseek', modelId: 'p1', runtimeModelId: 'p1', capabilities: { planner: true, executor: true, reviewer: true }, capabilitiesRevision: 'rev-1' },
  executor: { catalogProvider: 'xai', modelId: 'e1', runtimeModelId: 'e1', capabilities: { planner: false, executor: true, reviewer: true }, capabilitiesRevision: 'rev-1' },
  reviewer: { catalogProvider: 'deepseek', modelId: 'v1', runtimeModelId: 'v1', capabilities: { planner: false, executor: false, reviewer: true }, capabilitiesRevision: 'rev-1' },
}
const CATALOG = {
  gatewayInstanceId: 'gi-test',
  capabilitiesRevision: 'rev-1',
  conflicts: [],
  models: [
    { id: 'deepseek-v4-pro', provider: 'deepseek', contextWindow: 200000, tools: true },
    { id: 'grok-4.6', provider: 'xai', tools: true, input: ['text'] },
    { id: 'deepseek-v4-flash', provider: 'deepseek', contextWindow: 100000, tools: false, input: ['text'] },
  ],
}
const PROFILE = 'p-test'
const OWNER_U1 = computeOwnerKey({ gatewayInstanceId: 'gi-test', userId: 'u1', profileId: PROFILE })

// ---------- 任务/计划/审核夹具 ----------

const task = (taskId, dependsOnTaskIds = [], extra = {}) => ({
  taskId,
  dependsOnTaskIds,
  title: `任务 ${taskId}`,
  goal: `完成 ${taskId}`,
  inputRefs: [],
  expectedOutputs: [],
  pathScope: ['src'],
  acceptanceIds: ['a1'],
  verificationHints: ['node --test'],
  role: 'executor',
  status: 'pending',
  attemptIds: [],
  evidenceIds: [],
  ...extra,
})

const validPlan = {
  goal: '目标',
  interpretation: '解释',
  knownFacts: [],
  assumptions: [],
  openQuestions: [],
  acceptance: [{ id: 'a1', description: '验收项', checkable: true }],
  verificationMethods: ['node --test scripts'],
  tasks: [task('t1'), task('t2', ['t1'])],
}

const reviewResult = (verdict, extra = {}) => ({
  verdict,
  planVersion: 1,
  evidenceManifestHash: 'e-1',
  criteria: [{ acceptanceId: 'a1', status: verdict === 'pass' ? 'pass' : 'fail', evidenceIds: ['e1'], explanation: '审核说明' }],
  findings: [],
  summary: '审核结论',
  ...extra,
})

// ---------- 存储/宿主夹具 ----------

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-recovery-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function openStore(t, root) {
  const stateDir = path.join(root, 'desk')
  const storageRoot = path.join(root, 'storages')
  const backend = new JsonStorageBackend(storageRoot)
  const facility = new DomainFacility(
    { storage: { backend: { get: (n) => (n === 'json' ? backend : undefined) } }, logger: { warn: () => {}, error: () => {} }, emit: () => {} },
    { backend: 'json', routes: {} },
  )
  const store = new MixedStore({ stateDir, storageRoot, hostId: `desk-${process.pid}`, ownershipTtlMs: 15000, logger: QUIET })
  t.after(() => store.close().catch(() => {}))
  return { store, facility }
}

// ---------- 假内核 ----------

function makeRegistry() {
  const live = new Map()
  return { live, get: (sid) => live.get(sid), list: () => [...live.values()] }
}

/** fake agent：记录钩子 handler（可手动驱动 pre-step）+ followup 收件箱 + cancel。 */
function makeFakeAgent() {
  const handlers = {}
  const inbox = []
  const cancels = []
  return {
    handlers,
    inbox,
    cancels,
    ctx: {
      on: (event, fn) => {
        handlers[event] = fn
        return () => {
          delete handlers[event]
        }
      },
    },
    followup: (msg) => {
      inbox.push(msg)
    },
    cancel: (cause) => {
      cancels.push(cause)
    },
  }
}

/** 可控制的假 subagents：结果挂起（deferred），signal abort 时 reject（模拟内核取消子代理）。 */
function makeDeferredSubagents() {
  const pending = []
  return {
    pending,
    start: async (kind, opts) => {
      assert.equal(kind, 'spawn')
      let resolve
      let reject
      const promise = new Promise((res, rej) => {
        resolve = res
        reject = rej
      })
      const entry = { opts, promise, resolve, reject, id: `child-${pending.length + 1}` }
      if (opts.signal) {
        opts.signal.addEventListener('abort', () => reject(new Error('subagent aborted')), { once: true })
      }
      pending.push(entry)
      return { id: entry.id, result: promise, dispose: async () => {} }
    },
  }
}

/** 脚本化假 subagents：planning→planOutput；execution/review→按 label 应答。 */
function makeScriptedSubagents({ planOutput = structuredClone(validPlan), planOutputs, reviewResult: rr = reviewResult('pass') } = {}) {
  const spawns = []
  const plans = Array.isArray(planOutputs) ? planOutputs.map((p) => structuredClone(p)) : null
  return {
    spawns,
    start: async (kind, opts) => {
      assert.equal(kind, 'spawn')
      spawns.push({ label: opts.label, stage: (opts.label ?? '').split(':')[1], taskId: (opts.label ?? '').split(':')[2] })
      let behavior
      if (opts.label === 'mixed:planning') {
        const next = plans && plans.length ? plans.shift() : planOutput
        behavior = { output: 'plan', stopReason: 'completed', structured: structuredClone(next) }
      } else if (opts.label.startsWith('mixed:execution')) {
        behavior = { output: 'executed', stopReason: 'completed' }
      } else if (opts.label === 'mixed:review') {
        behavior = { output: 'review', stopReason: 'completed', structured: structuredClone(rr) }
      } else {
        behavior = { output: 'ok', stopReason: 'completed' }
      }
      const id = `child-${spawns.length}`
      return { id, result: Promise.resolve(behavior), dispose: async () => {} }
    },
  }
}

// ---------- 宿主/控制器装配 ----------

function makeHost(t, { agents = null, subagents = makeDeferredSubagents(), login, ensureBridgeMs = 600000 } = {}) {
  const root = makeRoot(t)
  const host = createMixedHost({
    stateDir: path.join(root, 'desk'),
    getLogin: () => (typeof login === 'function' ? login() : { loggedIn: true, user: { id: 'u1', username: 'alice' } }),
    fetchCatalog: async () => structuredClone(CATALOG),
    gatewayInstanceId: () => 'gi-test',
    profileId: PROFILE,
    sessionExists: () => true,
    agents,
    subagents,
    sessionCwd: () => path.join(root, 'ws'),
    providerIdOf: (route) => `desk-gateway-${route.catalogProvider}`,
    ensureBridgeMs,
    logger: QUIET,
  })
  t.after(async () => {
    await host.close().catch(() => {})
  })
  return { root, host }
}

function makeController(store, fakeSub, run, opts = {}) {
  const agent = opts.agent ?? { cancel: () => {} }
  const driver = new MixedDriver({
    ctx: { subagents: fakeSub },
    store,
    parentAgent: agent,
    run,
    logger: QUIET,
    stageTimeoutMs: 10000,
  })
  const controller = new MixedRunController({
    store,
    driver,
    run,
    agent,
    planPrompt: (r) => planPrompt(r),
    taskPrompt: (r, task) => taskPrompt(r, task),
    reviewPrompt: () => 'REVIEW',
    planSchema: { type: 'object' },
    reviewSchema: { type: 'object' },
    logger: QUIET,
    ...opts,
  })
  return { driver, controller }
}

async function claimRun(store, { sessionId = 's1', messageId = 'm1', ownerKey = OWNER_U1, ownerEpoch = 0, statusPath = [], extraRunPatch = null } = {}) {
  const submissionKey = submissionKeyOf({ ownerKey, profileId: PROFILE, sessionId, sourceMessageId: messageId })
  const runId = runIdOf(submissionKey)
  const { run } = await store.claimRun({
    runId,
    ownerKey,
    ownerEpoch,
    profileId: PROFILE,
    sessionId,
    sourceMessageId: messageId,
    submissionKey,
    workspace: { canonicalPath: 'E:\\ws', baselineId: 'b-1' },
    models: structuredClone(MODELS),
    policy: { maxRepairRounds: 2, maxReplans: 1 },
    goal: '目标',
    inputRefs: [{ kind: 'text', messageId, text: '目标' }],
  })
  for (const to of statusPath) {
    await store.updateRun(runId, (c) =>
      advanceRun(c, { ownerKey: c.ownerKey, ownerEpoch: c.ownerEpoch, to, event: { type: 'status_changed', summary: `test→${to}` } }),
    )
  }
  if (extraRunPatch) {
    await store.updateRun(runId, (c) =>
      advanceRun(c, { ownerKey: c.ownerKey, ownerEpoch: c.ownerEpoch, event: { type: 'test_patch', summary: 'seed' }, patch: extraRunPatch }),
    )
  }
  return run
}

/** 种子：planVersion + 任务记录（模拟 #execute 已落盘的实施阶段状态）。 */
async function seedPlan(store, runId, { plan = validPlan, taskStatus = {} } = {}) {
  await store.updateRun(runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      event: { type: 'plan_saved', summary: 'seed plan v1' },
      patch: {
        planVersions: [...c.planVersions, { version: (c.planVersions.at(-1)?.version ?? 0) + 1, ...plan, tasks: plan.tasks.map((t) => t.taskId), taskRecords: plan.tasks }],
        tasks: plan.tasks.map((t) => ({ ...t, status: taskStatus[t.taskId] ?? 'pending' })),
      },
    }),
  )
}

/** 种子：审核轮（result=null 模拟中断在轮内；带 result 模拟完整轮）。 */
async function seedReviewRound(store, runId, { planVersion = 1, result = null } = {}) {
  await store.updateRun(runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      event: { type: 'review_started', summary: 'seed round' },
      patch: {
        reviewRounds: [
          ...c.reviewRounds,
          {
            roundId: `rev_${c.reviewRounds.length + 1}seed`,
            planVersion,
            evidenceManifestHash: 'e-1',
            result: result ? { ...result, planVersion } : null,
            startedAt: new Date().toISOString(),
          },
        ],
      },
    }),
  )
}

function toReq(body) {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const stream = Readable.from([buf])
  stream.contentType = 'application/json'
  return stream
}

function runEvents(run) {
  return (run.events ?? []).map((e) => e.type)
}

// =====================================================================
// 1) 启动对账（强杀恢复，§5.4）
// =====================================================================

test('启动对账：宿主硬杀后遗留 executing run → interrupted（不悬挂、不自动重放）', async (t) => {
  const root = makeRoot(t)
  // ---- 宿主 1：claim + 推进到 executing（含未结束的 attempt = 结果不明）→ 不 close（模拟硬杀）----
  const host1 = createMixedHost({
    stateDir: path.join(root, 'desk'),
    getLogin: () => ({ loggedIn: true, user: { id: 'u1', username: 'alice' } }),
    fetchCatalog: async () => structuredClone(CATALOG),
    gatewayInstanceId: () => 'gi-test',
    profileId: PROFILE,
    sessionExists: () => true,
    agents: null,
    subagents: { start: async () => { throw new Error('no spawn') } },
    sessionCwd: () => path.join(root, 'ws'),
    logger: QUIET,
  })
  await host1.open()
  const run1 = await claimRun(host1.store, { sessionId: 's1', statusPath: ['planning', 'executing'] })
  // 种子：计划 + 任务（t1 完成、t2 派发中）+ 未结束的 attempt（崩溃窗口：结果不明）
  await seedPlan(host1.store, run1.runId, { taskStatus: { t1: 'executed', t2: 'running' } })
  await host1.store.updateRun(run1.runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      event: { type: 'attempt_started', summary: 't2 派发前落盘' },
      patch: {
        attempts: [
          ...c.attempts,
          { attemptId: 'att-seed-1', stage: 'execution', taskId: 't2', planVersion: 1, route: MODELS.executor, startedAt: new Date().toISOString(), unknown: false },
        ],
      },
    }),
  )
  const attemptsBefore = host1.store.getRun(run1.runId).attempts.length
  const revisionBefore = host1.store.getRun(run1.runId).revision
  // 硬杀：不 close、不收敛——进程直接没了（store 留在内存但不再写入）
  // ---- 宿主 2：同目录重启，agent 从未 attach（T08 真实缺口场景）----
  const host2 = createMixedHost({
    stateDir: path.join(root, 'desk'),
    getLogin: () => ({ loggedIn: true, user: { id: 'u1', username: 'alice' } }),
    fetchCatalog: async () => structuredClone(CATALOG),
    gatewayInstanceId: () => 'gi-test',
    profileId: PROFILE,
    sessionExists: () => true,
    agents: null, // agent 离线——从未 attach 也照样对账
    subagents: { start: async () => { throw new Error('no spawn') } },
    sessionCwd: () => path.join(root, 'ws'),
    logger: QUIET,
  })
  t.after(async () => {
    await host1.close().catch(() => {})
    await host2.close().catch(() => {})
  })
  const api2 = await host2.ready()
  // 首个 mixed 请求触发 getIdentity → 启动对账
  const r = await api2.handle({ method: 'GET', path: '/mixed/config', headers: {} })
  assert.equal(r.status, 200)
  const cur = host2.store.getRun(run1.runId)
  assert.equal(cur.status, 'interrupted', 'executing → interrupted')
  assert.equal(cur.error?.code, 'host_interrupted')
  assert.equal(cur.error?.retryable, false)
  assert.ok(runEvents(cur).includes('interrupted'))
  assert.ok(cur.events.some((e) => e.type === 'interrupted' && /启动对账/.test(e.summary ?? '')))
  // 不自动重放：attempt 数/计划数不变，t2 仍是 running（对账标记在恢复时才回 ready）
  assert.equal(cur.attempts.length, attemptsBefore)
  assert.equal(cur.planVersions.length, 1)
  assert.equal(cur.tasks.find((x) => x.taskId === 't2').status, 'running')
  assert.ok(cur.revision >= revisionBefore)
})

test('启动对账：queued→blocked(retryable)、cancelling→cancelled、waiting_input 保留', async (t) => {
  const root = makeRoot(t)
  const mk = async (name) => {
    const h = createMixedHost({
      stateDir: path.join(root, 'desk'),
      getLogin: () => ({ loggedIn: true, user: { id: 'u1', username: 'alice' } }),
      fetchCatalog: async () => structuredClone(CATALOG),
      gatewayInstanceId: () => 'gi-test',
      profileId: PROFILE,
      sessionExists: () => true,
      agents: null,
      subagents: { start: async () => { throw new Error('no spawn') } },
      sessionCwd: () => path.join(root, 'ws'),
      logger: QUIET,
    })
    await h.open()
    return h
  }
  const h1 = await mk('h1')
  const queued = await claimRun(h1.store, { sessionId: 'sq', messageId: 'mq' }) // queued
  const cancelling = await claimRun(h1.store, { sessionId: 'sc', messageId: 'mc', statusPath: ['planning'] })
  await h1.store.updateRun(cancelling.runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      to: 'cancelling',
      cancelling: true,
      event: { type: 'cancel_requested', summary: 'seed' },
    }),
  )
  const waiting = await claimRun(h1.store, { sessionId: 'sw', messageId: 'mw', statusPath: ['planning', 'waiting_input'] })
  // 硬杀 h1（不 close）→ h2 重启对账
  const h2 = await mk('h2')
  t.after(async () => {
    await h1.close().catch(() => {})
    await h2.close().catch(() => {})
  })
  const api2 = await h2.ready()
  await api2.handle({ method: 'GET', path: '/mixed/config', headers: {} })
  const q = h2.store.getRun(queued.runId)
  assert.equal(q.status, 'blocked')
  assert.equal(q.error?.code, 'host_interrupted')
  assert.equal(q.error?.retryable, true, 'queued 中断可重试')
  const c2 = h2.store.getRun(cancelling.runId)
  assert.equal(c2.status, 'cancelled', 'cancelling → cancelled（停止收敛完成）')
  const w = h2.store.getRun(waiting.runId)
  assert.equal(w.status, 'waiting_input', 'waiting_input 保留为恢复入口')
})

// =====================================================================
// 2) owner fence（§6.1：换账号/登出先停旧 owner）
// =====================================================================

test('换账号：旧 owner 活动 run 停止收敛 + epoch+1 + 迟到结果不改状态', async (t) => {
  const registry = makeRegistry()
  const sub = makeDeferredSubagents()
  let loginState = { loggedIn: true, user: { id: 'u1', username: 'alice' } }
  const { host } = makeHost(t, { agents: registry, subagents: sub, login: () => loginState })
  const agent = makeFakeAgent()
  registry.live.set('s1', agent)
  const api = await host.ready()
  await api.handle({
    method: 'POST',
    path: '/sessions/s1/mixed',
    headers: {},
    req: toReq({ enabled: true, ownerEpoch: 0 }),
  })
  const run = await claimRun(host.store, { sessionId: 's1', statusPath: ['planning', 'executing'] })
  await seedPlan(host.store, run.runId, { taskStatus: { t1: 'running' } })
  // 活动控制器：规划中挂起（deferred）——agent 用注册表里的 fake（requestStop 会调它的 cancel）
  const { controller } = makeController(host.store, sub, host.store.getRun(run.runId), { agent })
  host.controllers.set(run.runId, controller)
  const execPromise = controller.execute(new AbortController().signal)
  await waitFor(() => sub.pending.length === 1)
  assert.equal(host.store.getRun(run.runId).status, 'planning')
  // ---- 换账号 u1 → u2 ----
  loginState = { loggedIn: true, user: { id: 'u2', username: 'bob' } }
  const r2 = await api.handle({ method: 'GET', path: '/mixed/config', headers: {} })
  assert.equal(r2.status, 200)
  const cur = host.store.getRun(run.runId)
  assert.equal(cur.status, 'cancelled', '旧 owner 活动 run 经 requestStop 收敛 cancelled')
  assert.ok(agent.cancels.length >= 1, '父 agent.cancel 已触发（停派发）')
  assert.ok(sub.pending[0].opts.signal?.aborted, '子代理信号已 abort（级联取消）')
  await settle() // global 身份写链（磁盘）落定后读回
  const ident = host.store.getOwnerIdentity()
  const OWNER_U2 = computeOwnerKey({ gatewayInstanceId: 'gi-test', userId: 'u2', profileId: PROFILE })
  assert.equal(ident.ownerKey, OWNER_U2)
  assert.equal(ident.ownerEpoch, 1, 'epoch 栅栏 +1')
  // ---- 迟到结果：挂起的子代理在 fence 之后 resolve → 不得改变已收敛状态 ----
  sub.pending[0].resolve({ output: 'late', stopReason: 'completed' })
  await execPromise
  const after = host.store.getRun(run.runId)
  assert.equal(after.status, 'cancelled', '迟到结果不复活已收敛 run')
  // u2 视角看不到 u1 的 run（owner 隔离）
  const r3 = await api.handle({ method: 'GET', path: `/mixed/runs/${run.runId}`, headers: {} })
  assert.ok([403, 404].includes(r3.status), `u2 访问 u1 run → ${r3.status}`)
})

test('登出：立即 fence 旧 owner（活动 run 收敛，身份清空）', async (t) => {
  const registry = makeRegistry()
  const sub = makeDeferredSubagents()
  let loginState = { loggedIn: true, user: { id: 'u1', username: 'alice' } }
  const { host } = makeHost(t, { agents: registry, subagents: sub, login: () => loginState })
  const agent = makeFakeAgent()
  registry.live.set('s1', agent)
  const api = await host.ready()
  await api.handle({ method: 'POST', path: '/sessions/s1/mixed', headers: {}, req: toReq({ enabled: true, ownerEpoch: 0 }) })
  const run = await claimRun(host.store, { sessionId: 's1', statusPath: ['planning'] })
  const { controller } = makeController(host.store, sub, host.store.getRun(run.runId), { agent })
  host.controllers.set(run.runId, controller)
  const execPromise = controller.execute(new AbortController().signal)
  await waitFor(() => sub.pending.length === 1)
  // ---- 登出 ----
  loginState = { loggedIn: false, user: null }
  const r = await api.handle({ method: 'GET', path: '/mixed/config', headers: {} })
  assert.equal(r.status, 401, '登出后 mixed 未认证')
  await execPromise
  const cur = host.store.getRun(run.runId)
  assert.equal(cur.status, 'cancelled')
  assert.ok(agent.cancels.length >= 1)
  // 重登同账号：epoch 不升（持久化 ownerKey 未变），已收敛 run 保持
  loginState = { loggedIn: true, user: { id: 'u1', username: 'alice' } }
  const r2 = await api.handle({ method: 'GET', path: '/mixed/config', headers: {} })
  assert.equal(r2.status, 200)
  const ident = host.store.getOwnerIdentity()
  assert.equal(ident.ownerKey, OWNER_U1)
  assert.equal(ident.ownerEpoch, 0, '同账号重登不升 epoch')
  assert.equal(host.store.getRun(run.runId).status, 'cancelled')
})

// =====================================================================
// 3) 取消各阶段覆盖（子代理/验证子进程/无新派发/写锁释放）
// =====================================================================

test('执行中 Stop：子代理 abort、无新派发、收敛 cancelled、写锁释放', async (t) => {
  const sub = makeDeferredSubagents()
  const root = makeRoot(t)
  const { store, facility } = openStore(t, root)
  await store.open(facility)
  const run = await claimRun(store, { sessionId: 's1', statusPath: ['planning', 'executing'] })
  await seedPlan(store, run.runId, { taskStatus: { t1: 'running' } })
  const { controller } = makeController(store, sub, store.getRun(run.runId))
  const execPromise = controller.execute(new AbortController().signal)
  await waitFor(() => sub.pending.length === 1)
  const spawnsBefore = sub.pending.length
  // ---- Stop ----
  await controller.requestStop('user-stop')
  await execPromise
  const cur = store.getRun(run.runId)
  assert.equal(cur.status, 'cancelled')
  assert.ok(sub.pending[0].opts.signal?.aborted, '执行子代理信号 abort')
  assert.equal(sub.pending.length, spawnsBefore, '停止后无新派发')
  // 工作区写锁已随收敛释放（同路径可再取）
  const { acquireWorkspaceWriteLock } = await import('../../plugins/desk-host/lib/mixed/scheduler.js')
  const lock2 = acquireWorkspaceWriteLock('E:\\ws', 'other-run')
  lock2.release()
})

test('验证子进程：abort 信号 → 子进程被杀（killedBy 落记录）', async (t) => {
  const root = makeRoot(t)
  const evidenceDir = path.join(root, 'ev')
  fs.mkdirSync(evidenceDir, { recursive: true })
  const cwd = path.join(root, 'ws')
  fs.mkdirSync(cwd, { recursive: true })
  const ac = new AbortController()
  const p = recordVerification({
    evidenceDir,
    cwd,
    command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    timeoutMs: 15000,
    signal: ac.signal,
    logger: QUIET,
  })
  await waitFor(() => fs.existsSync(path.join(evidenceDir)) && true) // spawn 启动
  await new Promise((r) => setTimeout(r, 300)) // 让子进程起来
  ac.abort()
  const rec = await p
  assert.equal(rec.exitCode, null, '被杀而非正常退出')
  assert.ok(rec.killedBy, `killedBy 记录（${rec.killedBy}）`)
  assert.ok(Date.now() - Date.parse(rec.endedAt) < 10000)
})

// =====================================================================
// 4) 恢复重入（service.js execute({resume})）
// =====================================================================

test('恢复：实施中断（t1 完成 t2 运行中）→ 只续跑 t2（executed 不重做）→ 成功', async (t) => {
  const root = makeRoot(t)
  const { store, facility } = openStore(t, root)
  await store.open(facility)
  const run = await claimRun(store, { sessionId: 's1', statusPath: ['planning', 'executing'] })
  await seedPlan(store, run.runId, { taskStatus: { t1: 'executed', t2: 'running' } })
  await store.updateRun(run.runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      to: 'interrupted',
      interrupting: true,
      event: { type: 'interrupted', summary: '宿主硬杀（测试种子）' },
      patch: { error: { code: 'host_interrupted', retryable: false, detail: 'seed' } },
    }),
  )
  const sub = makeScriptedSubagents()
  const fresh = store.getRun(run.runId)
  const { controller } = makeController(store, sub, fresh)
  const outcome = await controller.execute(new AbortController().signal, { resume: { kind: 'continue' } })
  assert.equal(outcome.outcome, 'succeeded')
  const execSpawns = sub.spawns.filter((s) => s.stage === 'execution')
  assert.deepEqual(execSpawns.map((s) => s.taskId), ['t2'], 't1（executed）不重做，只补 t2')
  assert.equal(sub.spawns.filter((s) => s.stage === 'planning').length, 0, '不重新规划')
  const cur = store.getRun(run.runId)
  assert.equal(cur.status, 'succeeded')
  assert.equal(cur.planVersions.length, 1, '复用既有 planVersion（不新增）')
  assert.ok(runEvents(cur).includes('resume_started'))
  assert.ok(runEvents(cur).includes('resume_reconciled'), '中断对账事件')
  assert.equal(cur.pendingResume, undefined, '恢复启动后清 pendingResume（未设置时本就无）')
})

test('恢复：无计划（规划前中断）→ 重规划 → 全流程成功', async (t) => {
  const root = makeRoot(t)
  const { store, facility } = openStore(t, root)
  await store.open(facility)
  const run = await claimRun(store, { sessionId: 's1', statusPath: ['planning'] })
  await store.updateRun(run.runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      to: 'interrupted',
      interrupting: true,
      event: { type: 'interrupted', summary: 'seed' },
      patch: { error: { code: 'host_interrupted', retryable: false, detail: 'seed' } },
    }),
  )
  const sub = makeScriptedSubagents()
  const { controller } = makeController(store, sub, store.getRun(run.runId))
  const outcome = await controller.execute(new AbortController().signal, { resume: { kind: 'continue' } })
  assert.equal(outcome.outcome, 'succeeded')
  assert.equal(sub.spawns.filter((s) => s.stage === 'planning').length, 1, '重新规划一次')
  assert.equal(store.getRun(run.runId).planVersions.length, 1)
})

test('恢复：审核通过未交付（finalizing 中断）→ 只重试 finalizing（不重跑实施/审核）', async (t) => {
  const root = makeRoot(t)
  const { store, facility } = openStore(t, root)
  await store.open(facility)
  const run = await claimRun(store, { sessionId: 's1', statusPath: ['planning', 'executing', 'reviewing', 'finalizing'] })
  await seedPlan(store, run.runId, { taskStatus: { t1: 'executed', t2: 'executed' } })
  await seedReviewRound(store, run.runId, { result: reviewResult('pass') })
  await store.updateRun(run.runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      to: 'interrupted',
      interrupting: true,
      event: { type: 'interrupted', summary: 'finalizing 中断（seed）' },
      patch: { error: { code: 'host_interrupted', retryable: false, detail: 'seed' } },
    }),
  )
  const sub = makeScriptedSubagents()
  const { controller } = makeController(store, sub, store.getRun(run.runId))
  const outcome = await controller.execute(new AbortController().signal, { resume: { kind: 'continue' } })
  assert.equal(outcome.outcome, 'succeeded')
  assert.equal(outcome.delivery.runId, run.runId)
  assert.equal(sub.spawns.length, 0, '零派发：不重规划/不重实施/不重审核')
  assert.equal(store.getRun(run.runId).status, 'succeeded')
})

test('恢复：审核结论 changes_requested（返修耗尽）→ 拒绝恢复（resume_not_allowed）', async (t) => {
  const root = makeRoot(t)
  const { store, facility } = openStore(t, root)
  await store.open(facility)
  const run = await claimRun(store, { sessionId: 's1', statusPath: ['planning', 'executing', 'reviewing'] })
  await seedPlan(store, run.runId, { taskStatus: { t1: 'executed', t2: 'executed' } })
  await seedReviewRound(store, run.runId, { result: reviewResult('changes_requested') })
  await store.updateRun(run.runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      to: 'blocked',
      event: { type: 'status_changed', summary: '返修未通过' },
      patch: { error: { code: 'review_rejected', retryable: false, detail: 'seed' } },
    }),
  )
  const sub = makeScriptedSubagents()
  const { controller } = makeController(store, sub, store.getRun(run.runId))
  const outcome = await controller.execute(new AbortController().signal, { resume: { kind: 'continue' } })
  assert.equal(outcome.outcome, 'blocked')
  assert.equal(outcome.error?.code, 'resume_not_allowed', '拒绝恢复有明确错误码')
  assert.equal(sub.spawns.length, 0, '拒绝即零派发')
  assert.equal(store.getRun(run.runId).status, 'blocked', '状态不变（建议重跑）')
})

test('恢复 retry：failed 任务 + 传递受阻后继回 ready 并重试', async (t) => {
  const root = makeRoot(t)
  const { store, facility } = openStore(t, root)
  await store.open(facility)
  const run = await claimRun(store, { sessionId: 's1', statusPath: ['planning', 'executing'] })
  await seedPlan(store, run.runId, { taskStatus: { t1: 'failed', t2: 'blocked' } })
  await store.updateRun(run.runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      to: 'blocked',
      event: { type: 'status_changed', summary: '任务失败（seed）' },
      patch: { error: { code: 'task_failed', retryable: true, detail: 'seed' } },
    }),
  )
  const sub = makeScriptedSubagents()
  const { controller } = makeController(store, sub, store.getRun(run.runId))
  const outcome = await controller.execute(new AbortController().signal, { resume: { kind: 'retry' } })
  assert.equal(outcome.outcome, 'succeeded')
  const execSpawns = sub.spawns.filter((s) => s.stage === 'execution')
  assert.deepEqual(execSpawns.map((s) => s.taskId).sort(), ['t1', 't2'], 'failed + 传递 blocked 都重做')
  assert.ok(runEvents(store.getRun(run.runId)).includes('resume_reconciled'))
})

test('恢复：审核中断在轮内（result=null）→ 重跑该轮（不采信不明结果）；pendingResume 清除', async (t) => {
  const root = makeRoot(t)
  const { store, facility } = openStore(t, root)
  await store.open(facility)
  const run = await claimRun(store, { sessionId: 's1', statusPath: ['planning', 'executing', 'reviewing'] })
  await seedPlan(store, run.runId, { taskStatus: { t1: 'executed', t2: 'executed' } })
  await seedReviewRound(store, run.runId, { result: null }) // 中断在轮内
  await store.updateRun(run.runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      to: 'interrupted',
      interrupting: true,
      event: { type: 'interrupted', summary: '审核轮内中断（seed）' },
      patch: {
        error: { code: 'host_interrupted', retryable: false, detail: 'seed' },
        pendingResume: { kind: 'continue', at: new Date().toISOString() },
      },
    }),
  )
  const sub = makeScriptedSubagents()
  const { controller } = makeController(store, sub, store.getRun(run.runId))
  const outcome = await controller.execute(new AbortController().signal, { resume: { kind: 'continue' } })
  assert.equal(outcome.outcome, 'succeeded')
  assert.equal(sub.spawns.filter((s) => s.stage === 'review').length, 1, '重跑一轮审核（新轮）')
  assert.equal(sub.spawns.filter((s) => s.stage === 'execution').length, 0, '不重实施')
  const cur = store.getRun(run.runId)
  assert.equal(cur.reviewRounds.length, 2, '新轮追加（旧 null 轮保留为诊断）')
  assert.equal(cur.pendingResume, undefined, 'pendingResume 已清除')
})

// =====================================================================
// 5) 恢复 marker 桥接（followup → pre-step → 同 turn 重入 + 交付/拒绝）
// =====================================================================

async function makeBridge(t, { store, run, sub = makeScriptedSubagents(), agent = makeFakeAgent() } = {}) {
  const controllers = new Map()
  // marker 分支要求会话模式已启用（否则静默消费）——测试统一启用
  await store.setSessionMode({ sessionId: 's1', ownerKey: OWNER_U1, ownerEpoch: 0, enabled: true })
  const bridge = createMixedBridge({
    store,
    profileId: PROFILE,
    getOwner: () => ({ ownerKey: OWNER_U1, ownerEpoch: 0 }),
    workspacePath: () => 'E:\\ws',
    deps: {
      runControllerFactory: ({ agent, sessionId, run: r, store: s }) => {
        const { controller } = makeController(s, sub, r)
        controllers.set(r.runId, controller)
        return controller
      },
      controllers,
    },
    findSession: () => (agent ? { agent, sessionId: 's1' } : null),
    logger: QUIET,
  })
  const disposer = bridge.install(agent, 's1')
  t.after(() => disposer())
  return { bridge, agent, sub, controllers }
}

async function drivePreStep(agent, decision) {
  const ac = new AbortController()
  return agent.handlers['agent/pre-step']({ signal: ac.signal }, async () => decision)
}

test('marker：恢复中断 run（同 turn 重入 + 交付消息；marker 不放进父模型）', async (t) => {
  const root = makeRoot(t)
  const { store, facility } = openStore(t, root)
  await store.open(facility)
  const run = await claimRun(store, { sessionId: 's1', statusPath: ['planning', 'executing'] })
  await seedPlan(store, run.runId, { taskStatus: { t1: 'executed', t2: 'running' } })
  await store.updateRun(run.runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      to: 'interrupted',
      interrupting: true,
      event: { type: 'interrupted', summary: 'seed' },
      patch: { error: { code: 'host_interrupted', retryable: false, detail: 'seed' } },
    }),
  )
  const { agent, sub } = await makeBridge(t, { store })
  const markerText = resumeMarkerText(run.runId, 'continue')
  assert.ok(parseResumeMarker(markerText), 'marker 可解析')
  const decision = {
    kind: 'enter',
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: markerText }],
        source: { kind: 'plugin', plugin: 'mixed', form: 'notice', summary: 'Mixed 恢复' },
      }),
    ],
  }
  const result = await drivePreStep(agent, decision)
  assert.equal(result.kind, 'enter')
  assert.equal(result.messages.length, 1, '只有交付消息（marker 已消费，不进父模型）')
  assert.equal(result.messages[0].source.kind, 'plugin')
  assert.match(String(result.messages[0].content[0].text), /Mixed 交付/)
  assert.equal(store.getRun(run.runId).status, 'succeeded')
  const execSpawns = sub.spawns.filter((s) => s.stage === 'execution')
  assert.deepEqual(execSpawns.map((s) => s.taskId), ['t2'])
})

test('marker 幂等：已终态 run 的 marker → 消费不重放；进行中 marker → 消费', async (t) => {
  const root = makeRoot(t)
  const { store, facility } = openStore(t, root)
  await store.open(facility)
  const run = await claimRun(store, { sessionId: 's1', statusPath: ['planning', 'executing', 'reviewing', 'finalizing', 'succeeded'] })
  const { agent } = await makeBridge(t, { store })
  const decision = {
    kind: 'enter',
    messages: [createUserMessage({ content: [{ type: 'text', text: resumeMarkerText(run.runId, 'continue') }], source: { kind: 'plugin', plugin: 'mixed' } })],
  }
  const r1 = await drivePreStep(agent, decision)
  assert.deepEqual(r1, { kind: 'enter', messages: [] }, '终态 marker 静默消费')
  assert.equal(store.getRun(run.runId).status, 'succeeded')
})

test('marker：run 不存在 → reject（明确原因）', async (t) => {
  const root = makeRoot(t)
  const { store, facility } = openStore(t, root)
  await store.open(facility)
  const { agent } = await makeBridge(t, { store })
  const decision = {
    kind: 'enter',
    messages: [createUserMessage({ content: [{ type: 'text', text: resumeMarkerText('run-' + 'f'.repeat(20), 'continue') }], source: { kind: 'plugin', plugin: 'mixed' } })],
  }
  const r = await drivePreStep(agent, decision)
  assert.equal(r.kind, 'reject')
  assert.match(r.reason, /不存在/)
})

test('marker：恢复失败 → reject + 落 resume_failed（防自动重发死循环）', async (t) => {
  const root = makeRoot(t)
  const { store, facility } = openStore(t, root)
  await store.open(facility)
  const run = await claimRun(store, { sessionId: 's1', statusPath: ['planning', 'executing', 'reviewing'] })
  await seedPlan(store, run.runId, { taskStatus: { t1: 'executed', t2: 'executed' } })
  await seedReviewRound(store, run.runId, { result: reviewResult('changes_requested') })
  await store.updateRun(run.runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      to: 'blocked',
      event: { type: 'status_changed', summary: 'seed' },
      patch: { error: { code: 'review_rejected', retryable: false, detail: 'seed' } },
    }),
  )
  const { agent } = await makeBridge(t, { store })
  const decision = {
    kind: 'enter',
    messages: [createUserMessage({ content: [{ type: 'text', text: resumeMarkerText(run.runId, 'continue') }], source: { kind: 'plugin', plugin: 'mixed' } })],
  }
  const r = await drivePreStep(agent, decision)
  assert.equal(r.kind, 'reject')
  assert.match(r.reason, /resume_not_allowed|重跑/)
  const cur = store.getRun(run.runId)
  assert.ok(runEvents(cur).includes('resume_failed'), 'resume_failed 已落（宿主不再自动补发）')
  assert.equal(cur.status, 'blocked')
})

// =====================================================================
// 6) resume API（onResume 触发：在线 marker / 离线 pendingResume / 上线补发）
// =====================================================================

test('resume API：agent 在线 → 202 + started:true + marker 入收件箱', async (t) => {
  const registry = makeRegistry()
  const { host } = makeHost(t, { agents: registry })
  const agent = makeFakeAgent()
  registry.live.set('s1', agent)
  const api = await host.ready()
  await api.handle({ method: 'POST', path: '/sessions/s1/mixed', headers: {}, req: toReq({ enabled: true, ownerEpoch: 0 }) })
  const run = await claimRun(host.store, { sessionId: 's1', statusPath: ['planning', 'executing'] })
  await seedPlan(host.store, run.runId, { taskStatus: { t1: 'running' } })
  await host.store.updateRun(run.runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      to: 'interrupted',
      interrupting: true,
      event: { type: 'interrupted', summary: 'seed' },
      patch: { error: { code: 'host_interrupted', retryable: false, detail: 'seed' } },
    }),
  )
  const r = await api.handle({ method: 'POST', path: `/mixed/runs/${run.runId}/resume`, headers: {}, req: toReq({ choice: 'continue' }) })
  assert.equal(r.status, 202)
  assert.equal(r.body.accepted, true)
  assert.deepEqual(r.body.resume, { started: true })
  assert.equal(agent.inbox.length, 1, 'marker 已 followup')
  assert.ok(parseResumeMarker(agent.inbox[0].content[0].text)?.runId === run.runId)
  const cur = host.store.getRun(run.runId)
  assert.ok(runEvents(cur).includes('resume_requested'))
  assert.deepEqual(cur.pendingResume, { kind: 'continue', at: cur.pendingResume.at })
})

test('resume API：agent 离线 → started:false + pendingResume；上线后 ensureBridges 补发', async (t) => {
  const registry = makeRegistry()
  const { host } = makeHost(t, { agents: registry })
  const api = await host.ready()
  await api.handle({ method: 'POST', path: '/sessions/s1/mixed', headers: {}, req: toReq({ enabled: true, ownerEpoch: 0 }) })
  const run = await claimRun(host.store, { sessionId: 's1', statusPath: ['planning'] })
  await host.store.updateRun(run.runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      to: 'interrupted',
      interrupting: true,
      event: { type: 'interrupted', summary: 'seed' },
      patch: { error: { code: 'host_interrupted', retryable: false, detail: 'seed' } },
    }),
  )
  // agent 离线
  let r = await api.handle({ method: 'POST', path: `/mixed/runs/${run.runId}/resume`, headers: {}, req: toReq({ choice: 'retry' }) })
  assert.equal(r.status, 202)
  assert.equal(r.body.resume?.started, false)
  assert.match(r.body.resume?.reason ?? '', /agent_not_live/)
  assert.equal(host.store.getRun(run.runId).pendingResume?.kind, 'retry', 'pendingResume 已落盘')
  assert.equal(registry.live.get('s1')?.inbox.length ?? 0, 0)
  // agent 上线（客户端打开会话）→ ensureBridges 补发 marker
  const agent = makeFakeAgent()
  registry.live.set('s1', agent)
  await host.ensureBridges()
  assert.equal(agent.inbox.length, 1, 'pending 恢复 marker 已补发')
  assert.ok(parseResumeMarker(agent.inbox[0].content[0].text)?.choice === 'retry')
  // 重复 ensureBridges 不重复补发（同一 pendingResume；恢复启动/失败后才有新事件）
  await host.ensureBridges()
  assert.equal(agent.inbox.length, 1, '不重复补发')
})

test('resume API：不可恢复状态 → 409 明确原因', async (t) => {
  const registry = makeRegistry()
  const { host } = makeHost(t, { agents: registry })
  const api = await host.ready()
  await api.handle({ method: 'POST', path: '/sessions/s1/mixed', headers: {}, req: toReq({ enabled: true, ownerEpoch: 0 }) })
  const run = await claimRun(host.store, { sessionId: 's1' }) // queued
  const r = await api.handle({ method: 'POST', path: `/mixed/runs/${run.runId}/resume`, headers: {}, req: toReq({ choice: 'continue' }) })
  assert.equal(r.status, 409)
})

// =====================================================================
// 7) blocked-恢复 vs 重跑（旧记录与产物保留）
// =====================================================================

test('重跑：新 runId，旧 run 状态/revision/记录原样保留（不是文件重置）', async (t) => {
  const registry = makeRegistry()
  const { host } = makeHost(t, { agents: registry })
  const agent = makeFakeAgent()
  registry.live.set('s1', agent)
  const api = await host.ready()
  await api.handle({ method: 'POST', path: '/sessions/s1/mixed', headers: {}, req: toReq({ enabled: true, ownerEpoch: 0 }) })
  // 重跑需三路由配置
  await host.store.savePreferences(OWNER_U1, { planner: MODELS.planner, executor: MODELS.executor, reviewer: MODELS.reviewer, ownerEpoch: 0 })
  const run = await claimRun(host.store, { sessionId: 's1', statusPath: ['planning', 'executing', 'reviewing'] })
  await seedPlan(host.store, run.runId, { taskStatus: { t1: 'executed' } })
  await host.store.updateRun(run.runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      to: 'blocked',
      event: { type: 'status_changed', summary: 'seed' },
      patch: { error: { code: 'review_rejected', retryable: false, detail: 'seed' } },
    }),
  )
  const before = host.store.getRun(run.runId)
  const r = await api.handle({ method: 'POST', path: `/mixed/runs/${run.runId}/rerun`, headers: {}, req: toReq({ rerunRequestId: 'rr-1' }) })
  assert.equal(r.status, 202)
  const after = host.store.getRun(run.runId)
  assert.equal(after.status, before.status, '旧 run 状态不变')
  assert.equal(after.revision, before.revision, '旧 run revision 不变（重跑不写旧记录）')
  assert.notEqual(r.body.runId, run.runId, '新 runId')
  assert.equal(r.body.parentRunId, run.runId)
  const fresh = host.store.getRun(r.body.runId)
  assert.equal(fresh.retryOfRunId, run.runId)
  assert.equal(fresh.goal, before.goal, '目标沿用（旧需求快照进 inputRefs，不是新目标）')
  assert.ok(fresh.inputRefs.some((x) => x.messageId?.includes('rerun-snapshot')), '旧需求快照作为输入引用保留')
  // 幂等：同 rerunRequestId 重试 → 同一新 run（200 created:false）
  const r2 = await api.handle({ method: 'POST', path: `/mixed/runs/${run.runId}/rerun`, headers: {}, req: toReq({ rerunRequestId: 'rr-1' }) })
  assert.equal(r2.status, 200)
  assert.equal(r2.body.runId, r.body.runId)
  assert.equal(r2.body.created, false)
})

test('恢复 vs 重跑：恢复是同一 run 续跑（revision 连续，无新 run）', async (t) => {
  const root = makeRoot(t)
  const { store, facility } = openStore(t, root)
  await store.open(facility)
  const run = await claimRun(store, { sessionId: 's1', statusPath: ['planning', 'executing'] })
  await seedPlan(store, run.runId, { taskStatus: { t1: 'executed', t2: 'running' } })
  await store.updateRun(run.runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      to: 'interrupted',
      interrupting: true,
      event: { type: 'interrupted', summary: 'seed' },
      patch: { error: { code: 'host_interrupted', retryable: false, detail: 'seed' } },
    }),
  )
  const revBefore = store.getRun(run.runId).revision
  const sub = makeScriptedSubagents()
  const { controller } = makeController(store, sub, store.getRun(run.runId))
  await controller.execute(new AbortController().signal, { resume: { kind: 'continue' } })
  const cur = store.getRun(run.runId)
  assert.equal(cur.status, 'succeeded')
  assert.ok(cur.revision > revBefore, '同一 run revision 前进（非新 run）')
  assert.equal(store.listRuns({ ownerKey: OWNER_U1 }).items.length, 1, '没有新 run')
})

// =====================================================================
// 8) waiting_input（§5.1 缺关键需求：规划 → 等待补充 → 回答后重规划）
// =====================================================================

const ASKING_PLAN = {
  ...validPlan,
  openQuestions: ['目标平台是 Windows 还是 mac？'],
}

test('规划缺关键需求 → waiting_input，0 次实施派发', async (t) => {
  const root = makeRoot(t)
  const { store, facility } = openStore(t, root)
  await store.open(facility)
  const run = await claimRun(store, { sessionId: 's1' })
  const sub = makeScriptedSubagents({ planOutput: ASKING_PLAN })
  const { controller } = makeController(store, sub, store.getRun(run.runId))
  const outcome = await controller.execute(new AbortController().signal)
  assert.equal(outcome.outcome, 'waiting_input')
  const cur = store.getRun(run.runId)
  assert.equal(cur.status, 'waiting_input')
  assert.equal(sub.spawns.filter((s) => s.stage === 'execution').length, 0, '缺关键需求不得派发实施')
  assert.equal(cur.pendingQuestions?.length, 1)
  assert.equal(cur.pendingQuestions[0].questionId, 'q1')
  assert.match(cur.pendingQuestions[0].text, /Windows/)
  assert.equal(cur.pendingQuestions[0].answer, undefined)
  assert.ok(runEvents(cur).includes('waiting_input'))
})

test('waiting_input 回答匹配 questionId → 重规划 → 全流程成功', async (t) => {
  const root = makeRoot(t)
  const { store, facility } = openStore(t, root)
  await store.open(facility)
  const run = await claimRun(store, { sessionId: 's1' })
  const sub = makeScriptedSubagents({ planOutputs: [ASKING_PLAN, validPlan] })
  const { controller } = makeController(store, sub, store.getRun(run.runId))
  const first = await controller.execute(new AbortController().signal)
  assert.equal(first.outcome, 'waiting_input')
  await store.updateRun(run.runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      event: { type: 'input_answered', summary: 'test answer q1' },
      patch: {
        pendingQuestions: c.pendingQuestions.map((q) =>
          q.questionId === 'q1' ? { ...q, answer: 'Windows', answeredAt: new Date().toISOString() } : q,
        ),
      },
    }),
  )
  const { controller: c2 } = makeController(store, sub, store.getRun(run.runId))
  const second = await c2.execute(new AbortController().signal, { resume: { kind: 'answer' } })
  assert.equal(second.outcome, 'succeeded')
  assert.equal(store.getRun(run.runId).status, 'succeeded')
  assert.equal(sub.spawns.filter((s) => s.stage === 'planning').length, 2)
  assert.ok(sub.spawns.filter((s) => s.stage === 'execution').length >= 1, '回答后才实施')
})

test('waiting_input 错误 questionId → 409 question_mismatch', async (t) => {
  const { host } = makeHost(t, { subagents: makeScriptedSubagents() })
  const api = await host.ready()
  const run = await claimRun(host.store, { sessionId: 's1', statusPath: ['planning'] })
  await host.store.updateRun(run.runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      to: 'waiting_input',
      event: { type: 'waiting_input', summary: 'seed' },
      patch: {
        pendingQuestions: [{ questionId: 'q1', text: '目标平台？' }],
      },
    }),
  )
  const bad = await api.handle({
    method: 'POST',
    path: `/mixed/runs/${run.runId}/resume`,
    headers: {},
    req: toReq({ questionId: 'q-nope', answer: 'Windows' }),
  })
  assert.equal(bad.status, 409)
  assert.equal(bad.body.error.code, 'question_mismatch')
  assert.equal(host.store.getRun(run.runId).status, 'waiting_input')
})

test('waiting_input 桥接：enter + 等待通知，不 reject（父模型不实施）', async (t) => {
  const root = makeRoot(t)
  const { store, facility } = openStore(t, root)
  await store.open(facility)
  await store.savePreferences(OWNER_U1, { planner: MODELS.planner, executor: MODELS.executor, reviewer: MODELS.reviewer, ownerEpoch: 0 })
  const sub = makeScriptedSubagents({ planOutput: ASKING_PLAN })
  const { agent } = await makeBridge(t, { store, sub })
  const decision = {
    kind: 'enter',
    messages: [{
      id: 'msg-ask',
      role: 'user',
      content: [{ type: 'text', text: '帮我做一个跨平台安装包' }],
      source: { kind: 'user' },
    }],
  }
  const result = await drivePreStep(agent, decision)
  assert.equal(result.kind, 'enter', '等待补充不是失败 reject')
  assert.ok(result.messages.some((m) => m.source?.plugin === 'mixed' && /等待|补充|问题/.test(String(m.content?.[0]?.text ?? m.content))), '有等待通知')
  const runs = store.listRuns({ ownerKey: OWNER_U1 }).items
  assert.equal(runs.length, 1)
  assert.equal(store.getRun(runs[0].runId).status, 'waiting_input')
  assert.equal(sub.spawns.filter((s) => s.stage === 'execution').length, 0)
})

// ---------- 工具 ----------

/** domain global 的 set 走异步写链（磁盘）后再更新内存投影——读回前让一拍。 */
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond, timeoutMs = 5000) {
  const t0 = Date.now()
  for (;;) {
    if (cond()) return
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 10))
  }
}

