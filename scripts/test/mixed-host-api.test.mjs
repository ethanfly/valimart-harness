/**
 * T07 交付物：mixed-host-api 测试（本机 API：配置/会话模式/运行状态/取消/恢复/重跑/证据）。
 *
 * 覆盖计划 T07 验收：
 * - 无登录不可操作（401）；
 * - 跨账号 ID 不可访问（run/会话模式/证据 → 403，列表只含本 owner）；
 * - stale revision 返回 409（config/会话模式/resume/rerun 四条写路径）；
 * - API 不等待模型完成（cancel 立即 202 + cancelling，收敛由控制器异步完成；rerun 立即返回 queued run）。
 *
 * 宿主侧用真实 mixed-store（内核真实存储栈）+ 真实 ModelRoutes + 真实 EvidenceCollector；
 * 身份/控制器/会话归属可注入。不起 HTTP 服务：直接调 handle({method, path, headers, req})。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MixedStore } from '../../plugins/desk-host/lib/mixed/store.js'
import { MixedError, advanceRun, submissionKeyOf, runIdOf, RUN_TERMINAL } from '../../plugins/desk-host/lib/mixed/contracts.js'
import { ModelRoutes } from '../../plugins/desk-host/lib/mixed/model-routes.js'
import { EvidenceCollector } from '../../plugins/desk-host/lib/mixed/evidence.js'
import { createMixedApi } from '../../plugins/desk-host/lib/mixed/host-api.js'

const QUIET = { warn: () => {}, error: () => {}, info: () => {} }
const MODELS = {
  planner: { catalogProvider: 'deepseek', modelId: 'p1', runtimeModelId: 'p1', capabilities: { planner: true, executor: true, reviewer: true }, capabilitiesRevision: 'rev-abc' },
  executor: { catalogProvider: 'xai', modelId: 'e1', runtimeModelId: 'e1', capabilities: { planner: false, executor: true, reviewer: true }, capabilitiesRevision: 'rev-abc' },
  reviewer: { catalogProvider: 'deepseek', modelId: 'v1', runtimeModelId: 'v1', capabilities: { planner: false, executor: false, reviewer: true }, capabilitiesRevision: 'rev-abc' },
}

function makeStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-api-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const stateDir = path.join(root, 'desk')
  const storageRoot = path.join(root, 'storages')
  const backend = new JsonStorageBackend(storageRoot)
  const ctx = {
    storage: { backend: { get: (n) => (n === 'json' ? backend : undefined) } },
    logger: { warn: () => {}, error: () => {} },
    emit: () => {},
  }
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  const store = new MixedStore({ stateDir, storageRoot, hostId: 'host-api', ownershipTtlMs: 15000, logger: QUIET })
  return { root, store, facility }
}

async function makeModelRoutes() {
  const routes = new ModelRoutes({
    fetchCatalog: async () => ({
      gatewayInstanceId: 'gi-test',
      capabilitiesRevision: 'rev-1',
      conflicts: [{ modelId: 'clash', kind: 'provider-collision' }],
      models: [
        { id: 'deepseek-v4-pro', provider: 'deepseek', contextWindow: 200000, tools: true },
        { id: 'grok-4.6', provider: 'xai', tools: true, input: ['text'] },
        { id: 'deepseek-v4-flash', provider: 'deepseek', contextWindow: 100000, tools: false, input: ['text'] },
        { id: 'clash', provider: 'xai', tools: true, input: ['text'] },
      ],
    }),
  })
  await routes.refresh()
  return routes
}

async function claimRun(store, { ownerKey = 'owner:A', ownerEpoch = 0, messageId = 'm1', sessionId = 'sess-1', workspace = 'E:\\ws' } = {}) {
  const submissionKey = submissionKeyOf({ ownerKey, profileId: 'desk-host', sessionId, sourceMessageId: messageId })
  const runId = runIdOf(submissionKey)
  const { run } = await store.claimRun({
    runId,
    ownerKey,
    ownerEpoch,
    profileId: 'desk-host',
    sessionId,
    sourceMessageId: messageId,
    submissionKey,
    workspace: { canonicalPath: workspace, baselineId: 'b-1' },
    models: structuredClone(MODELS),
    policy: { maxRepairRounds: 2, maxReplans: 1 },
    goal: '目标',
    inputRefs: [{ kind: 'text', messageId, text: '目标' }],
  })
  return run
}

function toReq(body, contentType = 'application/json') {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const stream = Readable.from([buf])
  stream.contentType = contentType
  return stream
}

function makeApi({ store, modelRoutes, identity, controllers = new Map(), evidence, sessions = new Set(['sess-1', 'sess-2']), maxBodyBytes = 256 * 1024 }) {
  return createMixedApi({
    store,
    getIdentity: () => identity,
    modelRoutes,
    controllers,
    evidence,
    profileId: 'desk-host',
    sessionExists: (sid) => sessions.has(sid),
    maxBodyBytes,
    logger: QUIET,
  })
}

const A = { loggedIn: true, ownerKey: 'owner:A', ownerEpoch: 0, userId: 'u1' }
const B = { loggedIn: true, ownerKey: 'owner:B', ownerEpoch: 0, userId: 'u2' }

/** 推进 run 到某状态（沿合法迁移）。 */
async function setRunStatus(store, runId, status) {
  const path = { queued: [], planning: ['planning'], executing: ['planning', 'executing'], reviewing: ['planning', 'executing', 'reviewing'], blocked: ['planning', 'executing', 'blocked'], waiting_input: ['planning', 'waiting_input'], cancelled: ['planning', 'executing', 'cancelling', 'cancelled'] }[status]
  let cur = store.getRun(runId)
  for (const to of path) {
    const cancelling = to === 'cancelling'
    cur = await store.updateRun(runId, (c) =>
      advanceRun(c, { ownerKey: c.ownerKey, ownerEpoch: c.ownerEpoch, to, cancelling, event: { type: 'status_changed', summary: `test→${to}` } }),
    )
  }
  return cur
}

// ---------- 验收：无登录不可操作 ----------

test('API：未登录（401）与 owner 未解析（503）——全部 mixed 路由不可用', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const modelRoutes = await makeModelRoutes()

  const anon = makeApi({ store: env.store, modelRoutes, identity: null })
  for (const [method, p] of [['GET', '/mixed/config'], ['POST', '/mixed/config'], ['GET', '/sessions/sess-1/mixed'], ['POST', '/sessions/sess-1/mixed'], ['GET', '/mixed/runs'], ['GET', '/mixed/runs/run-x'], ['POST', '/mixed/runs/run-x/cancel'], ['POST', '/mixed/runs/run-x/resume'], ['POST', '/mixed/runs/run-x/rerun'], ['GET', '/mixed/runs/run-x/evidence/ev-1']]) {
    const r = await anon.handle({ method, path: p, headers: {}, req: method === 'GET' ? null : toReq({}) })
    assert.equal(r.status, 401, `${method} ${p} 应 401`)
    assert.equal(r.body.error.code, 'unauthenticated')
  }

  const noOwner = makeApi({ store: env.store, modelRoutes, identity: { loggedIn: true, ownerKey: null, ownerEpoch: 0 } })
  const r2 = await noOwner.handle({ method: 'GET', path: '/mixed/config', headers: {} })
  assert.equal(r2.status, 503)
  assert.equal(r2.body.error.code, 'owner_not_resolved')
})

// ---------- 验收：跨账号 ID 不可访问 ----------

test('API：跨账号 run/会话模式/证据不可访问（403），列表只含本 owner', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const modelRoutes = await makeModelRoutes()
  const apiA = makeApi({ store: env.store, modelRoutes, identity: A })
  const apiB = makeApi({ store: env.store, modelRoutes, identity: B })

  const runA = await claimRun(env.store, { ownerKey: A.ownerKey, messageId: 'mA', sessionId: 'sess-2' })
  // A 配置会话模式（sess-1 无活动运行）
  const mode = await apiA.handle({ method: 'POST', path: '/sessions/sess-1/mixed', headers: {}, req: toReq({ enabled: true }) })
  assert.equal(mode.status, 200)

  // B 访问 A 的 run → 403
  for (const [method, p] of [['GET', `/mixed/runs/${runA.runId}`], ['POST', `/mixed/runs/${runA.runId}/cancel`], ['POST', `/mixed/runs/${runA.runId}/resume`], ['POST', `/mixed/runs/${runA.runId}/rerun`], ['GET', `/mixed/runs/${runA.runId}/evidence/ev-x`]]) {
    const r = await apiB.handle({ method, path: p, headers: {}, req: method === 'GET' ? null : toReq({}) })
    assert.equal(r.status, 403, `B ${method} ${p} 应 403`)
    assert.equal(r.body.error.code, 'owner_mismatch')
  }
  // B 的列表看不到 A 的 run
  const listB = await apiB.handle({ method: 'GET', path: '/mixed/runs', headers: {} })
  assert.equal(listB.status, 200)
  assert.ok(!listB.body.items.some((i) => i.runId === runA.runId), 'B 列表不含 A 的 run')
  // B 看/改 A 的会话模式 → 403
  const modeGet = await apiB.handle({ method: 'GET', path: '/sessions/sess-1/mixed', headers: {} })
  assert.equal(modeGet.status, 403)
  const modeSet = await apiB.handle({ method: 'POST', path: '/sessions/sess-1/mixed', headers: {}, req: toReq({ enabled: false }) })
  assert.equal(modeSet.status, 403)
  // A 自己的会话模式仍然有效（未被 B 影响）
  const modeGetA = await apiA.handle({ method: 'GET', path: '/sessions/sess-1/mixed', headers: {} })
  assert.equal(modeGetA.body.mode.enabled, true)
})

// ---------- 验收：stale revision → 409（四条写路径）----------

test('API：stale revision 返回 409（config / 会话模式 / resume / rerun）', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const modelRoutes = await makeModelRoutes()
  const api = makeApi({ store: env.store, modelRoutes, identity: A })

  // 1) config
  const good = { planner: { catalogProvider: 'deepseek', modelId: 'deepseek-v4-pro' }, executor: { catalogProvider: 'xai', modelId: 'grok-4.6' }, reviewer: { catalogProvider: 'deepseek', modelId: 'deepseek-v4-flash' } }
  const c1 = await api.handle({ method: 'POST', path: '/mixed/config', headers: {}, req: toReq(good) })
  assert.equal(c1.status, 200)
  assert.equal(c1.body.preferences.revision, 1)
  const c2 = await api.handle({ method: 'POST', path: '/mixed/config', headers: {}, req: toReq({ ...good, expectedRevision: 7 }) })
  assert.equal(c2.status, 409, 'config 旧 revision 应 409')
  assert.equal(c2.body.error.code, 'config_revision_conflict')

  // 2) 会话模式
  const m1 = await api.handle({ method: 'POST', path: '/sessions/sess-1/mixed', headers: {}, req: toReq({ enabled: true }) })
  assert.equal(m1.status, 200)
  const m2 = await api.handle({ method: 'POST', path: '/sessions/sess-1/mixed', headers: {}, req: toReq({ enabled: false, expectedRevision: 9 }) })
  assert.equal(m2.status, 409)

  // 3) resume
  const runR = await claimRun(env.store, { ownerKey: A.ownerKey, messageId: 'mR' })
  await setRunStatus(env.store, runR.runId, 'blocked')
  const revR = env.store.getRun(runR.runId).revision
  const rStale = await api.handle({ method: 'POST', path: `/mixed/runs/${runR.runId}/resume`, headers: {}, req: toReq({ expectedRevision: revR + 5 }) })
  assert.equal(rStale.status, 409, 'resume 旧 revision 应 409')
  assert.equal(rStale.body.error.code, 'run_revision_conflict')

  // 4) rerun（configRevision 与当前偏好不符）
  const runD = await claimRun(env.store, { ownerKey: A.ownerKey, messageId: 'mD' })
  await setRunStatus(env.store, runD.runId, 'blocked')
  const rStale2 = await api.handle({ method: 'POST', path: `/mixed/runs/${runD.runId}/rerun`, headers: {}, req: toReq({ rerunRequestId: 'rr-1', configRevision: 99 }) })
  assert.equal(rStale2.status, 409, 'rerun 旧 configRevision 应 409')
  assert.equal(rStale2.body.error.code, 'config_revision_conflict')
})

// ---------- 配置读写（catalog / 能力 / 冲突）----------

test('API：config 读写（公司目录可选、冲突模型 422、缺角色 400、规范化返回）', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const modelRoutes = await makeModelRoutes()
  const api = makeApi({ store: env.store, modelRoutes, identity: A })

  const g = await api.handle({ method: 'GET', path: '/mixed/config', headers: {} })
  assert.equal(g.status, 200)
  assert.equal(g.body.preferences, null)
  assert.ok(g.body.catalog.models.length >= 3, '目录模型列表')
  assert.equal(g.body.catalog.capabilitiesRevision, 'rev-1')

  // 合法三角色 → 200（解析出 runtimeModelId + capabilitiesRevision）
  const good = { planner: { catalogProvider: 'deepseek', modelId: 'deepseek-v4-pro' }, executor: { catalogProvider: 'xai', modelId: 'grok-4.6' }, reviewer: { catalogProvider: 'deepseek', modelId: 'deepseek-v4-flash' } }
  const p = await api.handle({ method: 'POST', path: '/mixed/config', headers: {}, req: toReq(good) })
  assert.equal(p.status, 200)
  assert.equal(p.body.preferences.planner.runtimeModelId, 'deepseek-v4-pro')
  assert.equal(p.body.preferences.executor.modelId, 'grok-4.6')
  assert.equal(p.body.preferences.reviewer.capabilities.reviewer, true)

  // 公司目录内模型可为任意角色保存（启发式不再拦规划器）
  const anyRole = { ...good, planner: { catalogProvider: 'xai', modelId: 'grok-4.6' } }
  const p2 = await api.handle({ method: 'POST', path: '/mixed/config', headers: {}, req: toReq(anyRole) })
  assert.equal(p2.status, 200, '公司目录模型应可保存为规划器')
  assert.equal(p2.body.preferences.planner.modelId, 'grok-4.6')
  assert.equal(p2.body.preferences.planner.capabilities.planner, true)

  // 冲突模型（provider 碰撞）→ 422
  const badClash = { ...good, executor: { catalogProvider: 'xai', modelId: 'clash' } }
  const p3 = await api.handle({ method: 'POST', path: '/mixed/config', headers: {}, req: toReq(badClash) })
  assert.equal(p3.status, 422)
  assert.match(p3.body.error.message, /碰撞|重名/)

  // 目录外模型 → 422
  const badMissing = { ...good, reviewer: { catalogProvider: 'openai', modelId: 'gpt-nope' } }
  const p4 = await api.handle({ method: 'POST', path: '/mixed/config', headers: {}, req: toReq(badMissing) })
  assert.equal(p4.status, 422)

  // 缺角色 → 400
  const p5 = await api.handle({ method: 'POST', path: '/mixed/config', headers: {}, req: toReq({ planner: good.planner, executor: good.executor }) })
  assert.equal(p5.status, 400)
  assert.equal(p5.body.error.code, 'bad_request')

  // 再读：preferences 已落盘（第二次成功保存把规划器换成 grok）
  const g2 = await api.handle({ method: 'GET', path: '/mixed/config', headers: {} })
  assert.equal(g2.body.preferences.revision, 2)
  assert.equal(g2.body.preferences.planner.modelId, 'grok-4.6')
  assert.equal(g2.body.diagnostics.configured, true)
  assert.deepEqual(g2.body.diagnostics.problems, [])
})

// ---------- 会话模式 ----------

test('API：会话模式（未设置/切换/活动运行互斥/未知会话 404）', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const modelRoutes = await makeModelRoutes()
  const api = makeApi({ store: env.store, modelRoutes, identity: A, sessions: new Set(['sess-1', 'sess-2', 'sess-3']) })

  const g0 = await api.handle({ method: 'GET', path: '/sessions/sess-1/mixed', headers: {} })
  assert.equal(g0.status, 200)
  assert.equal(g0.body.mode, null)
  assert.equal(g0.body.canToggle, true)

  const s1 = await api.handle({ method: 'POST', path: '/sessions/sess-1/mixed', headers: {}, req: toReq({ enabled: true }) })
  assert.equal(s1.status, 200)
  assert.equal(s1.body.mode.revision, 1)

  // 活动运行 → 互斥 409
  const runBusy = await claimRun(env.store, { ownerKey: A.ownerKey, messageId: 'mBusy', sessionId: 'sess-2' })
  await setRunStatus(env.store, runBusy.runId, 'executing')
  const busy = await api.handle({ method: 'POST', path: '/sessions/sess-2/mixed', headers: {}, req: toReq({ enabled: true }) })
  assert.equal(busy.status, 409, '活动运行中不可切换')
  assert.equal(busy.body.error.code, 'run_not_idle')
  const gBusy = await api.handle({ method: 'GET', path: '/sessions/sess-2/mixed', headers: {} })
  assert.equal(gBusy.body.activeRun.runId, runBusy.runId)
  assert.equal(gBusy.body.canToggle, false)

  // 旧 blocked 父 run + 更新的 succeeded 重跑：activeRun 不得把旧失败再当成当前活动
  const parentBlocked = await claimRun(env.store, { ownerKey: A.ownerKey, messageId: 'mOldFail', sessionId: 'sess-3' })
  await setRunStatus(env.store, parentBlocked.runId, 'blocked')
  const childOk = await claimRun(env.store, { ownerKey: A.ownerKey, messageId: 'mRerunOk', sessionId: 'sess-3' })
  await setRunStatus(env.store, childOk.runId, 'executing')
  await env.store.updateRun(childOk.runId, (c) => advanceRun(c, { ownerKey: c.ownerKey, ownerEpoch: c.ownerEpoch, to: 'reviewing', event: { type: 'status_changed', summary: '→reviewing' } }))
  await env.store.updateRun(childOk.runId, (c) => advanceRun(c, { ownerKey: c.ownerKey, ownerEpoch: c.ownerEpoch, to: 'finalizing', event: { type: 'status_changed', summary: '→finalizing' } }))
  await env.store.updateRun(childOk.runId, (c) => advanceRun(c, { ownerKey: c.ownerKey, ownerEpoch: c.ownerEpoch, to: 'succeeded', event: { type: 'status_changed', summary: '→succeeded' } }))
  const gAfter = await api.handle({ method: 'GET', path: '/sessions/sess-3/mixed', headers: {} })
  assert.equal(gAfter.body.activeRun, null, '更新的重跑已成功时，旧 blocked 不再占 activeRun')
  assert.equal(gAfter.body.canToggle, true)

  // 最新一条仍是 blocked（规划失败）→ 仍作为可恢复活动 run
  const onlyFail = await claimRun(env.store, { ownerKey: A.ownerKey, messageId: 'mOnlyFail', sessionId: 'sess-1' })
  await setRunStatus(env.store, onlyFail.runId, 'blocked')
  const gFail = await api.handle({ method: 'GET', path: '/sessions/sess-1/mixed', headers: {} })
  assert.equal(gFail.body.activeRun.runId, onlyFail.runId)
  assert.equal(gFail.body.canToggle, false)

  // enabled 非布尔 → 400
  const bad = await api.handle({ method: 'POST', path: '/sessions/sess-1/mixed', headers: {}, req: toReq({ enabled: 'yes' }) })
  assert.equal(bad.status, 400)

  // 未知会话 → 404
  const g404 = await api.handle({ method: 'GET', path: '/sessions/sess-none/mixed', headers: {} })
  assert.equal(g404.status, 404)
  assert.equal(g404.body.error.code, 'session_not_found')
})

// ---------- 运行列表（分页 + 字段限定）----------

test('API：runs 列表分页 + sessionId 过滤 + 限定字段（无 events/evidence）', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const modelRoutes = await makeModelRoutes()
  const api = makeApi({ store: env.store, modelRoutes, identity: A })

  await claimRun(env.store, { ownerKey: A.ownerKey, messageId: 'l1', sessionId: 'sess-1' })
  await claimRun(env.store, { ownerKey: A.ownerKey, messageId: 'l2', sessionId: 'sess-1' })
  await claimRun(env.store, { ownerKey: A.ownerKey, messageId: 'l3', sessionId: 'sess-2' })
  await claimRun(env.store, { ownerKey: B.ownerKey, messageId: 'l4', sessionId: 'sess-1' }) // 他 owner

  const page1 = await api.handle({ method: 'GET', path: '/mixed/runs?limit=2', headers: {} })
  assert.equal(page1.status, 200)
  assert.equal(page1.body.items.length, 2)
  assert.equal(page1.body.nextCursor, 2)
  const page2 = await api.handle({ method: 'GET', path: '/mixed/runs?limit=2&cursor=2', headers: {} })
  assert.equal(page2.body.items.length, 1)
  assert.equal(page2.body.nextCursor, null)

  const bySession = await api.handle({ method: 'GET', path: '/mixed/runs?sessionId=sess-2', headers: {} })
  assert.equal(bySession.body.items.length, 1)
  assert.equal(bySession.body.items[0].sessionId, 'sess-2')

  // 字段限定：列表项无 events/evidence/attempts 明细
  for (const item of page1.body.items) {
    assert.equal(item.events, undefined)
    assert.equal(item.evidence, undefined)
    assert.equal(item.attempts, undefined)
    assert.ok('runId' in item && 'status' in item && 'revision' in item)
    assert.ok('goal' in item, '列表必须带 goal（横幅不能只靠详情）')
    assert.ok('error' in item)
    assert.ok('pendingResume' in item)
    assert.ok('lastReview' in item, '列表必须带 lastReview，终态横幅才能显示审核原因')
  }
})

// ---------- 运行详情 + afterRevision 轮询 ----------

test('API：run 详情增量（afterRevision 未前进 = unchanged；事件按 eventSeq 去重）', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const modelRoutes = await makeModelRoutes()
  const api = makeApi({ store: env.store, modelRoutes, identity: A })

  const run = await claimRun(env.store, { ownerKey: A.ownerKey, messageId: 'mP' })
  await setRunStatus(env.store, run.runId, 'executing') // +2 事件
  const rev = env.store.getRun(run.runId).revision

  const full = await api.handle({ method: 'GET', path: `/mixed/runs/${run.runId}`, headers: {} })
  assert.equal(full.status, 200)
  assert.equal(full.body.changed, true)
  assert.equal(full.body.revision, rev)
  assert.ok(full.body.events.length >= 3, 'claimed + 2 次状态迁移')
  assert.equal(full.body.events[0].eventSeq, 1)

  // afterRevision = 当前 revision → unchanged（轮询不重复拉取）
  const unchanged = await api.handle({ method: 'GET', path: `/mixed/runs/${run.runId}?afterRevision=${rev}`, headers: {} })
  assert.equal(unchanged.body.changed, false)
  assert.equal(unchanged.body.revision, rev)

  // afterRevision = 1 → 只回 eventSeq > 1 的事件
  const inc = await api.handle({ method: 'GET', path: `/mixed/runs/${run.runId}?afterRevision=1`, headers: {} })
  assert.equal(inc.body.changed, true)
  assert.ok(inc.body.events.every((e) => e.eventSeq > 1))
  assert.equal(inc.body.events.length, full.body.events.length - 1)

  // 不存在的 run → 404
  const nf = await api.handle({ method: 'GET', path: '/mixed/runs/run-nope', headers: {} })
  assert.equal(nf.status, 404)
  assert.equal(nf.body.error.code, 'run_not_found')
})

// ---------- 取消（幂等 + 立即 202 + 不等待收敛）----------

test('API：cancel 立即 202 + cancelling（不等待模型/收敛完成）；孤儿 run 直接收敛；幂等', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const modelRoutes = await makeModelRoutes()

  // 活动 run：控制器收敛很慢（模拟模型还在跑）——API 必须立即返回
  let converged = false
  const runActive = await claimRun(env.store, { ownerKey: A.ownerKey, messageId: 'mC1' })
  await setRunStatus(env.store, runActive.runId, 'executing')
  const controllers = new Map()
  controllers.set(runActive.runId, {
    requestStop: async () => {
      const cur = env.store.getRun(runActive.runId)
      if (cur.status === 'cancelling' || cur.status === 'cancelled') return // 幂等（与真实控制器一致）
      await env.store.updateRun(runActive.runId, (c) =>
        advanceRun(c, { ownerKey: c.ownerKey, ownerEpoch: c.ownerEpoch, to: 'cancelling', cancelling: true, event: { type: 'cancel_requested', summary: 'user-stop' } }),
      )
      const timer = setTimeout(() => {
        converged = true
        env.store.updateRun(runActive.runId, (c) =>
          advanceRun(c, { ownerKey: c.ownerKey, ownerEpoch: c.ownerEpoch, to: 'cancelled', event: { type: 'status_changed', summary: '收敛（慢）' } }),
        ).catch(() => {})
      }, 400)
      timer.unref?.()
    },
  })
  const api = makeApi({ store: env.store, modelRoutes, identity: A, controllers })

  const t0 = Date.now()
  const c1 = await api.handle({ method: 'POST', path: `/mixed/runs/${runActive.runId}/cancel`, headers: {}, req: toReq({}) })
  const dt = Date.now() - t0
  assert.equal(c1.status, 202, 'cancel 立即 202')
  assert.equal(c1.body.accepted, true)
  assert.equal(c1.body.status, 'cancelling', '意图已落盘，收敛尚在进行')
  assert.equal(converged, false, '响应时收敛尚未完成（API 未等待）')
  assert.ok(dt < 400, `API 不应等待收敛（${dt}ms）`)

  // 幂等：再次 cancel → 仍 202
  const c2 = await api.handle({ method: 'POST', path: `/mixed/runs/${runActive.runId}/cancel`, headers: {}, req: toReq({}) })
  assert.equal(c2.status, 202)

  // 等收敛完成 → 再次 cancel 仍 202（终态幂等）
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(converged, true)
  const c3 = await api.handle({ method: 'POST', path: `/mixed/runs/${runActive.runId}/cancel`, headers: {}, req: toReq({}) })
  assert.equal(c3.status, 202)
  assert.equal(c3.body.status, 'cancelled')

  // 孤儿 run（无控制器）→ 直接收敛 cancelled
  const runOrphan = await claimRun(env.store, { ownerKey: A.ownerKey, messageId: 'mC2' })
  await setRunStatus(env.store, runOrphan.runId, 'executing')
  const apiNoCtrl = makeApi({ store: env.store, modelRoutes, identity: A, controllers: new Map() })
  const o1 = await apiNoCtrl.handle({ method: 'POST', path: `/mixed/runs/${runOrphan.runId}/cancel`, headers: {}, req: toReq({}) })
  assert.equal(o1.status, 202)
  assert.equal(o1.body.status, 'cancelled', '孤儿 run 直接收敛')

  // 不存在 → 404
  const nf = await apiNoCtrl.handle({ method: 'POST', path: '/mixed/runs/run-nope/cancel', headers: {}, req: toReq({}) })
  assert.equal(nf.status, 404)
})

// ---------- 恢复（状态/revision 校验 + 对账落事件）----------

test('API：resume 仅 blocked/interrupted/waiting_input；对账落 resume_requested；非法 409', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const modelRoutes = await makeModelRoutes()
  const api = makeApi({ store: env.store, modelRoutes, identity: A })

  // blocked → 202 + 事件
  const runB = await claimRun(env.store, { ownerKey: A.ownerKey, messageId: 'mR1' })
  await setRunStatus(env.store, runB.runId, 'blocked')
  const rev = env.store.getRun(runB.runId).revision
  const r1 = await api.handle({ method: 'POST', path: `/mixed/runs/${runB.runId}/resume`, headers: {}, req: toReq({ choice: 'continue', expectedRevision: rev }) })
  assert.equal(r1.status, 202)
  assert.equal(r1.body.resumeRequest.kind, 'continue')
  const rec = env.store.getRun(runB.runId)
  assert.ok(rec.events.some((e) => e.type === 'resume_requested'), 'resume_requested 事件已落盘')
  const detail = await api.handle({ method: 'GET', path: `/mixed/runs/${runB.runId}`, headers: {} })
  assert.equal(detail.body.pendingResume?.kind, 'continue', '面板要能看见 pendingResume，否则点恢复后仍像没响应')
  const listed = await api.handle({ method: 'GET', path: `/mixed/runs?sessionId=${runB.sessionId}`, headers: {} })
  const row = listed.body.items.find((it) => it.runId === runB.runId)
  assert.equal(row?.pendingResume?.kind, 'continue', '列表摘要也要带 pendingResume，横幅不能只靠详情')

  // executing（非可恢复态）→ 409
  const runE = await claimRun(env.store, { ownerKey: A.ownerKey, messageId: 'mR2' })
  await setRunStatus(env.store, runE.runId, 'executing')
  const r2 = await api.handle({ method: 'POST', path: `/mixed/runs/${runE.runId}/resume`, headers: {}, req: toReq({}) })
  assert.equal(r2.status, 409)
  assert.equal(r2.body.error.code, 'run_not_in_status')

  // waiting_input 必须带 questionId + answer，且 questionId 必须是宿主分配的待答问题
  const runW = await claimRun(env.store, { ownerKey: A.ownerKey, messageId: 'mR3' })
  await setRunStatus(env.store, runW.runId, 'waiting_input')
  await env.store.updateRun(runW.runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      event: { type: 'test_patch', summary: 'seed pendingQuestions' },
      patch: { pendingQuestions: [{ questionId: 'q1', text: '目标平台？' }] },
    }),
  )
  const r3 = await api.handle({ method: 'POST', path: `/mixed/runs/${runW.runId}/resume`, headers: {}, req: toReq({}) })
  assert.equal(r3.status, 409)
  assert.equal(r3.body.error.code, 'question_mismatch')
  const r4 = await api.handle({ method: 'POST', path: `/mixed/runs/${runW.runId}/resume`, headers: {}, req: toReq({ questionId: 'q1', answer: '选 B' }) })
  assert.equal(r4.status, 202)
  assert.equal(r4.body.resumeRequest.kind, 'answer')

  // 未知 choice → 400
  const r5 = await api.handle({ method: 'POST', path: `/mixed/runs/${runB.runId}/resume`, headers: {}, req: toReq({ choice: 'fly' }) })
  assert.equal(r5.status, 400)
})

// ---------- 重跑（幂等 + 静止限定 + 快照）----------

test('API：rerun 幂等（同 rerunRequestId 同一新 run）；仅静止运行；携带原产物/验收快照', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const modelRoutes = await makeModelRoutes()
  const api = makeApi({ store: env.store, modelRoutes, identity: A })
  const good = { planner: { catalogProvider: 'deepseek', modelId: 'deepseek-v4-pro' }, executor: { catalogProvider: 'xai', modelId: 'grok-4.6' }, reviewer: { catalogProvider: 'deepseek', modelId: 'deepseek-v4-flash' } }
  await api.handle({ method: 'POST', path: '/mixed/config', headers: {}, req: toReq(good) })

  // 父 run：succeeded（带验收/证据快照来源）
  const parent = await claimRun(env.store, { ownerKey: A.ownerKey, messageId: 'mP1' })
  await env.store.updateRun(parent.runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      to: 'planning',
      event: { type: 'status_changed', summary: '→planning' },
      patch: { planVersions: [{ version: 1, goal: c.goal, acceptance: [{ id: 'a1', description: 'check 通过', checkable: true }], tasks: ['t1'] }] },
    }),
  )
  // 手动推进到终态（已在 planning：→executing→reviewing→finalizing→succeeded）
  await env.store.updateRun(parent.runId, (c) => advanceRun(c, { ownerKey: c.ownerKey, ownerEpoch: c.ownerEpoch, to: 'executing', event: { type: 'status_changed', summary: '→executing' } }))
  await env.store.updateRun(parent.runId, (c) => advanceRun(c, { ownerKey: c.ownerKey, ownerEpoch: c.ownerEpoch, to: 'reviewing', event: { type: 'status_changed', summary: '→reviewing' } }))
  await env.store.updateRun(parent.runId, (c) => advanceRun(c, { ownerKey: c.ownerKey, ownerEpoch: c.ownerEpoch, to: 'finalizing', event: { type: 'status_changed', summary: '→finalizing' } }))
  await env.store.updateRun(parent.runId, (c) => advanceRun(c, { ownerKey: c.ownerKey, ownerEpoch: c.ownerEpoch, to: 'succeeded', event: { type: 'status_changed', summary: '→succeeded' } }))

  // 活动 run 不可重跑 → 409
  const runLive = await claimRun(env.store, { ownerKey: A.ownerKey, messageId: 'mP2' })
  await setRunStatus(env.store, runLive.runId, 'executing')
  const live = await api.handle({ method: 'POST', path: `/mixed/runs/${runLive.runId}/rerun`, headers: {}, req: toReq({ rerunRequestId: 'rr-x' }) })
  assert.equal(live.status, 409)
  assert.equal(live.body.error.code, 'run_not_idle')

  // 缺 rerunRequestId → 400
  const noKey = await api.handle({ method: 'POST', path: `/mixed/runs/${parent.runId}/rerun`, headers: {}, req: toReq({}) })
  assert.equal(noKey.status, 400)

  // 正常重跑 → 202 + 新 queued run
  const x1 = await api.handle({ method: 'POST', path: `/mixed/runs/${parent.runId}/rerun`, headers: {}, req: toReq({ rerunRequestId: 'rr-1' }) })
  assert.equal(x1.status, 202)
  assert.equal(x1.body.created, true)
  assert.equal(x1.body.parentRunId, parent.runId)
  const child = env.store.getRun(x1.body.runId)
  assert.equal(child.status, 'queued')
  assert.equal(child.retryOfRunId, parent.runId)
  assert.equal(child.rerunRequestId, 'rr-1')
  assert.equal(child.sessionId, parent.sessionId)
  assert.equal(child.workspace.canonicalPath, parent.workspace.canonicalPath)
  // 快照进 inputRefs
  const snapRef = child.inputRefs.find((r) => r.messageId === `rerun-snapshot:${parent.runId}`)
  assert.ok(snapRef, '重跑快照 inputRef 存在')
  assert.match(snapRef.text, /重跑快照/)
  assert.match(snapRef.text, /a1: check 通过/, '携带原验收项')
  // API 未等待执行：无控制器被创建
  assert.ok(!RUN_TERMINAL.has(child.status))

  // 幂等：同 rerunRequestId 重试 → 同一新 run（created:false）
  const x2 = await api.handle({ method: 'POST', path: `/mixed/runs/${parent.runId}/rerun`, headers: {}, req: toReq({ rerunRequestId: 'rr-1' }) })
  assert.equal(x2.status, 200)
  assert.equal(x2.body.created, false)
  assert.equal(x2.body.runId, x1.body.runId)

  // 不同 rerunRequestId → 不同新 run
  const x3 = await api.handle({ method: 'POST', path: `/mixed/runs/${parent.runId}/rerun`, headers: {}, req: toReq({ rerunRequestId: 'rr-2' }) })
  assert.equal(x3.body.created, true)
  assert.notEqual(x3.body.runId, x1.body.runId)

  // 未配置三角色（换 owner 无配置）→ 409 mixed_not_configured
  const apiB = makeApi({ store: env.store, modelRoutes, identity: B })
  const runB = await claimRun(env.store, { ownerKey: B.ownerKey, messageId: 'mP3' })
  await setRunStatus(env.store, runB.runId, 'blocked')
  const nc = await apiB.handle({ method: 'POST', path: `/mixed/runs/${runB.runId}/rerun`, headers: {}, req: toReq({ rerunRequestId: 'rr-b' }) })
  assert.equal(nc.status, 409)
  assert.equal(nc.body.error.code, 'mixed_not_configured')
})

// ---------- 证据（受控读取）----------

test('API：证据只按 evidenceId 受控读取（真实 collector）；未知 id 422；跨 owner 403', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const modelRoutes = await makeModelRoutes()
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-api-ws-'))
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }))
  fs.writeFileSync(path.join(ws, 'a.txt'), 'A')
  const collector = new EvidenceCollector({ storageRoot: env.root, store: env.store, logger: QUIET })
  const api = makeApi({ store: env.store, modelRoutes, identity: A, evidence: collector })

  const run = await claimRun(env.store, { ownerKey: A.ownerKey, messageId: 'mE', workspace: ws })
  await collector.collectBaseline(env.store, run)
  const ev = env.store.getRun(run.runId).evidence[0]
  assert.equal(ev.type, 'baseline')

  // record 读取
  const r = await api.handle({ method: 'GET', path: `/mixed/runs/${run.runId}/evidence/${ev.evidenceId}`, headers: {} })
  assert.equal(r.status, 200)
  assert.equal(r.body.evidenceId, ev.evidenceId)
  assert.match(r.body.content, /a\.txt/, '基线 JSON 内容（含清单文件）')
  // 越界/不存在：evidenceId 是唯一入口
  assert.equal((await api.handle({ method: 'GET', path: `/mixed/runs/${run.runId}/evidence/${ev.evidenceId}?kind=stdout`, headers: {} })).status, 422, '基线证据无 stdout 文件')

  // 未知 evidenceId → 422（evidence_invalid）
  const nf = await api.handle({ method: 'GET', path: `/mixed/runs/${run.runId}/evidence/ev_no_such`, headers: {} })
  assert.equal(nf.status, 422)
  assert.equal(nf.body.error.code, 'evidence_invalid')

  // 跨 owner → 403
  const apiB = makeApi({ store: env.store, modelRoutes, identity: B, evidence: collector })
  const cross = await apiB.handle({ method: 'GET', path: `/mixed/runs/${run.runId}/evidence/${ev.evidenceId}`, headers: {} })
  assert.equal(cross.status, 403)

  // 客户端无法请求任意文件路径：evidenceId 是唯一入口（伪造路径样 id → 不存在 422）
  const evil = await api.handle({ method: 'GET', path: `/mixed/runs/${run.runId}/evidence/${encodeURIComponent('..\\..\\evil.txt')}`, headers: {} })
  assert.equal(evil.status, 422)
})

// ---------- 安全杂项：同源 / 限额 / 方法 ----------

test('API：跨站 403、请求体超限 413、非 JSON 415、方法不允许 405、未知路由 404', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const modelRoutes = await makeModelRoutes()
  const api = makeApi({ store: env.store, modelRoutes, identity: A, maxBodyBytes: 64 })

  // 跨站
  const cross = await api.handle({ method: 'GET', path: '/mixed/config', headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(cross.status, 403)
  assert.equal(cross.body.error.code, 'bad_origin')
  const crossOrigin = await api.handle({ method: 'GET', path: '/mixed/config', headers: { origin: 'http://evil.example', host: '127.0.0.1:3470' } })
  assert.equal(crossOrigin.status, 403)
  // same-origin 放行
  const same = await api.handle({ method: 'GET', path: '/mixed/config', headers: { 'sec-fetch-site': 'same-origin' } })
  assert.equal(same.status, 200)

  // 超限（maxBodyBytes=64）
  const big = 'x'.repeat(500)
  const over = await api.handle({ method: 'POST', path: '/mixed/config', headers: {}, req: toReq(JSON.stringify({ planner: big })) })
  assert.equal(over.status, 413)
  assert.equal(over.body.error.code, 'body_too_large')

  // 非 JSON 内容类型
  const plain = await api.handle({ method: 'POST', path: '/mixed/config', headers: {}, req: toReq('text=1', 'text/plain') })
  assert.equal(plain.status, 415)

  // 方法不允许
  const m405 = await api.handle({ method: 'DELETE', path: '/mixed/config', headers: {} })
  assert.equal(m405.status, 405)

  // 未知路由
  const nf = await api.handle({ method: 'GET', path: '/mixed/unknown', headers: {} })
  assert.equal(nf.status, 404)
})
