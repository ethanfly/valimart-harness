/**
 * T08 交付物：mixed-host 生产桥接运行测试（真实 createMixedHost + 真实存储栈）。
 *
 * 覆盖计划 §7.2/T08 装配边界（生产桥接实例化）：
 * - attach 前置条件：未启用 Mixed / agent 未上线 / 身份未解析 → 明确 reason（不假装有）；
 * - 挂载幂等：同 agent 重复 attach 不重复注册钩子；
 * - agent 重建：ensureBridges 自动重挂新 agent、卸旧桥；
 * - 模式关闭：ensureBridges 卸载桥接；
 * - agent 消失（宿主异常/会话关闭，§5.4）：活动 run 收敛
 *   planning/executing… → interrupted；queued → blocked(host_interrupted, retryable)；
 * - close()：活动 run 收敛 + 桥接卸载 + 存储关闭（不悬挂）；
 * - API：POST /sessions/:id/mixed/attach（200 {attached, reason?}；未启用 mode_disabled）。
 *
 * 内核侧注入 fake AgentRegistry（get/list）与 fake agent（ctx.on 记录钩子）——
 * 生产 get(sessionId) 语义来自 dsh-agent AgentRegistry（README "Live agents"）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createMixedHost } from '../../plugins/desk-host/lib/mixed/host.js'
import { computeOwnerKey } from '../../plugins/desk-host/lib/mixed/owner.js'
import { submissionKeyOf, runIdOf, advanceRun } from '../../plugins/desk-host/lib/mixed/contracts.js'

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

function makeFakeAgent() {
  const hooks = []
  return {
    hooks,
    ctx: {
      on: (event, _fn) => {
        hooks.push(event)
        return () => {
          const i = hooks.indexOf(event)
          if (i >= 0) hooks.splice(i, 1)
        }
      },
    },
  }
}

function makeRegistry() {
  const live = new Map()
  return {
    live,
    get: (sid) => live.get(sid),
    list: () => [...live.values()],
  }
}

function makeHost(t, { agents, subagents = { start: async () => { throw new Error('no spawn in host tests') } } }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-host-'))
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })
  const host = createMixedHost({
    stateDir: path.join(root, 'desk'),
    getLogin: () => ({ loggedIn: true, user: { id: 'u1', username: 'alice' } }),
    fetchCatalog: async () => structuredClone(CATALOG),
    gatewayInstanceId: () => 'gi-test',
    profileId: 'p-test',
    sessionExists: () => true,
    agents,
    subagents,
    sessionCwd: () => path.join(root, 'ws'),
    providerIdOf: (route) => `desk-gateway-${route.catalogProvider}`,
    ensureBridgeMs: 600000, // 测试手动 ensureBridges()
    logger: QUIET,
  })
  t.after(async () => {
    await host.close().catch(() => {})
  })
  return { root, host }
}

const OWNER_KEY = computeOwnerKey({ gatewayInstanceId: 'gi-test', userId: 'u1', profileId: 'p-test' })

/** 启用/关闭会话模式（与 API 路径一致：同时通知宿主保持关注）。 */
async function enableMode(host, sessionId, enabled = true) {
  await host.store.setSessionMode({ sessionId, ownerKey: OWNER_KEY, ownerEpoch: 0, enabled })
  if (enabled) host.interested.add(sessionId)
}

async function claimRun(store, { sessionId = 's1', messageId = 'm1', statusPath = [] } = {}) {
  const submissionKey = submissionKeyOf({ ownerKey: OWNER_KEY, profileId: 'p-test', sessionId, sourceMessageId: messageId })
  const runId = runIdOf(submissionKey)
  const { run } = await store.claimRun({
    runId,
    ownerKey: OWNER_KEY,
    ownerEpoch: 0,
    profileId: 'p-test',
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
  return run
}

function toReq(body) {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const stream = Readable.from([buf])
  stream.contentType = 'application/json'
  return stream
}

test('attach：未启用 Mixed → mode_disabled（不挂载）', async (t) => {
  const registry = makeRegistry()
  const { host } = makeHost(t, { agents: registry })
  const agent = makeFakeAgent()
  registry.live.set('s1', agent)
  await host.open()
  const res = await host.attachAgent('s1')
  assert.deepEqual(res, { attached: false, reason: 'mode_disabled' })
  assert.equal(agent.hooks.length, 0)
  assert.equal(host.attached.size, 0)
})

test('attach：agent 未上线 → agent_not_live（不挂载，轮询兜底再试）', async (t) => {
  const registry = makeRegistry()
  const { host } = makeHost(t, { agents: registry })
  await host.open()
  await enableMode(host, 's1')
  const res = await host.attachAgent('s1')
  assert.deepEqual(res, { attached: false, reason: 'agent_not_live' })
  // agent 上线后 ensureBridges 自动挂载
  const agent = makeFakeAgent()
  registry.live.set('s1', agent)
  await host.ensureBridges()
  assert.deepEqual(agent.hooks.sort(), ['agent/pre-step', 'agent/request'])
  assert.equal(host.attached.get('s1').agent, agent)
})

test('attach：成功挂载且幂等（不重复注册钩子）', async (t) => {
  const registry = makeRegistry()
  const { host } = makeHost(t, { agents: registry })
  await host.open()
  await enableMode(host, 's1')
  const agent = makeFakeAgent()
  registry.live.set('s1', agent)
  const r1 = await host.attachAgent('s1')
  const r2 = await host.attachAgent('s1')
  assert.deepEqual(r1, { attached: true })
  assert.deepEqual(r2, { attached: true })
  assert.deepEqual(agent.hooks.sort(), ['agent/pre-step', 'agent/request'])
})

test('agent 重建：ensureBridges 重挂新 agent 并卸旧桥', async (t) => {
  const registry = makeRegistry()
  const { host } = makeHost(t, { agents: registry })
  await host.open()
  await enableMode(host, 's1')
  const a1 = makeFakeAgent()
  registry.live.set('s1', a1)
  await host.attachAgent('s1')
  assert.equal(a1.hooks.length, 2)
  // 内核 dispose 旧 agent 后为同会话创建新 agent
  registry.live.delete('s1')
  const a2 = makeFakeAgent()
  registry.live.set('s1', a2)
  await host.ensureBridges()
  assert.equal(a1.hooks.length, 0, '旧 agent 钩子已卸')
  assert.deepEqual(a2.hooks.sort(), ['agent/pre-step', 'agent/request'])
})

test('模式关闭：ensureBridges 卸载桥接', async (t) => {
  const registry = makeRegistry()
  const { host } = makeHost(t, { agents: registry })
  await host.open()
  await enableMode(host, 's1')
  const agent = makeFakeAgent()
  registry.live.set('s1', agent)
  await host.attachAgent('s1')
  assert.equal(agent.hooks.length, 2)
  await enableMode(host, 's1', false)
  await host.ensureBridges()
  assert.equal(agent.hooks.length, 0)
  assert.equal(host.attached.size, 0)
})

test('agent 消失：planning run → interrupted（§5.4 不悬挂）', async (t) => {
  const registry = makeRegistry()
  const { host } = makeHost(t, { agents: registry })
  await host.open()
  await enableMode(host, 's1')
  const agent = makeFakeAgent()
  registry.live.set('s1', agent)
  await host.attachAgent('s1')
  const run = await claimRun(host.store, { sessionId: 's1', statusPath: ['planning'] })
  registry.live.delete('s1') // 会话 agent 被销毁
  await host.ensureBridges()
  assert.equal(agent.hooks.length, 0)
  assert.equal(host.attached.size, 0)
  const cur = host.store.getRun(run.runId)
  assert.equal(cur.status, 'interrupted')
  assert.equal(cur.error?.code, 'host_interrupted')
  assert.ok(cur.events.some((e) => e.type === 'interrupted' || e.summary?.includes('agent')))
})

test('agent 消失：queued run → blocked(host_interrupted, retryable)', async (t) => {
  const registry = makeRegistry()
  const { host } = makeHost(t, { agents: registry })
  await host.open()
  await enableMode(host, 's1')
  const agent = makeFakeAgent()
  registry.live.set('s1', agent)
  await host.attachAgent('s1')
  const run = await claimRun(host.store, { sessionId: 's1' }) // 停在 queued
  registry.live.delete('s1')
  await host.ensureBridges()
  const cur = host.store.getRun(run.runId)
  assert.equal(cur.status, 'blocked')
  assert.equal(cur.error?.code, 'host_interrupted')
  assert.equal(cur.error?.retryable, true)
})

test('close()：executing run 收敛 interrupted + 存储关闭', async (t) => {
  const registry = makeRegistry()
  const { root, host } = makeHost(t, { agents: registry })
  await host.open()
  await enableMode(host, 's1')
  const agent = makeFakeAgent()
  registry.live.set('s1', agent)
  await host.attachAgent('s1')
  const run = await claimRun(host.store, { sessionId: 's1', statusPath: ['planning', 'executing'] })
  await host.close()
  assert.equal(host.store, null)
  assert.equal(agent.hooks.length, 0)
  // close 的收敛已落盘：重开同目录存储验证
  const { MixedStore } = await import('../../plugins/desk-host/lib/mixed/store.js')
  const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json')
  const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain')
  const stateDir = path.join(root, 'desk')
  const storageRoot = path.join(root, 'storages')
  const backend = new JsonStorageBackend(storageRoot)
  const facility = new DomainFacility(
    { storage: { backend: { get: (n) => (n === 'json' ? backend : undefined) } }, logger: { warn: () => {}, error: () => {} }, emit: () => {} },
    { backend: 'json', routes: {} },
  )
  const s2 = new MixedStore({ stateDir, storageRoot, hostId: `desk-${process.pid}`, ownershipTtlMs: 15000, logger: QUIET })
  await s2.open(facility)
  t.after(() => s2.close().catch(() => {}))
  const cur = s2.getRun(run.runId)
  assert.equal(cur.status, 'interrupted')
  assert.equal(cur.error?.code, 'host_interrupted')
})

test('API：POST /sessions/:id/mixed/attach → 200 {attached, reason?}', async (t) => {
  const registry = makeRegistry()
  const { host } = makeHost(t, { agents: registry })
  const api = await host.ready()
  // 未启用 → mode_disabled
  let r = await api.handle({ method: 'POST', path: '/sessions/s1/mixed/attach', headers: {}, req: null })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { sessionId: 's1', attached: false, reason: 'mode_disabled' })
  // 启用 + agent 上线 → attached
  await enableMode(host, 's1')
  registry.live.set('s1', makeFakeAgent())
  r = await api.handle({ method: 'POST', path: '/sessions/s1/mixed/attach', headers: {}, req: null })
  assert.equal(r.status, 200)
  assert.equal(r.body.attached, true)
  // GET 不允许
  r = await api.handle({ method: 'GET', path: '/sessions/s1/mixed/attach', headers: {}, req: null })
  assert.equal(r.status, 405)
})

test('API：POST /sessions/:id/mixed 启用 → 响应带 attached 结果', async (t) => {
  const registry = makeRegistry()
  const { host } = makeHost(t, { agents: registry })
  const api = await host.ready()
  // agent 已在线：启用即挂载
  registry.live.set('s2', makeFakeAgent())
  const r = await api.handle({
    method: 'POST',
    path: '/sessions/s2/mixed',
    headers: {},
    req: toReq({ enabled: true, ownerEpoch: 0 }),
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.mode.enabled, true)
  assert.equal(r.body.attached?.attached, true)
})
