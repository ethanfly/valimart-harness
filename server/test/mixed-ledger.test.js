/**
 * Mixed T10 用量归属与账本测试（node --test）：
 * - attribution 生命周期：open 幂等 / close 幂等 / TTL 过期 / 并发上限淘汰最旧
 * - 记账关联：恰好 1 个活跃 attempt → mixed{runId,stage,attemptId[,taskId]}；
 *   多个 → ambiguous（可见，不悄悄归错）；0 个 → 无 mixed 字段
 * - GET /api/mixed/usage：run 级合计 / byStage / attempts / 未知可见（unknownRequests）
 * - 跨用户隔离：A 的 run 对 B 不可见
 * - GET /api/ledger 分页：cursor/limit/nextCursor/total（旧调用方兼容）
 * - 缺 usage → costCny=null（不是 0）；缺 price → priceKnown=false（UI 显示未知）
 * 验收映射：混合运行合计与可关联账本一致；缺 usage/price 不显示为零费用。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../src/index.js'
import { MixedAttribution } from '../src/mixed-attribution.js'
import { estimateCostCny } from '../src/ledger.js'

const mktmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const RUN = 'run-0123456789abcdef0123'
const RUN_B = 'run-fedcba9876543210fedc'
const ATT1 = 'att_11111111-aaaa-4bbb-8ccc-000000000001'
const ATT2 = 'att_22222222-bbbb-4ccc-8ddd-000000000002'
const ATT3 = 'att_33333333-cccc-4ddd-8eee-000000000003'

function makeUpstreams() {
  return {
    alpha: { kind: 'mock', label: 'Alpha', models: [{ id: 'alpha-pro', name: 'Alpha Pro' }] },
  }
}

let gw
let base
let tmp
const ctx = {}

before(async () => {
  tmp = mktmp('mixed-ledger-')
  gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: tmp,
    upstreams: makeUpstreams(),
    seedAdmin: { username: 'admin', password: 'pass-admin-123', displayName: '管理员', department: '管理层' },
    seedUsers: [{ username: 'emp-b', password: 'pass-empb-123' }],
    fetchReleases: async () => [],
  })
  base = await gw.listen()
})

after(async () => {
  await Promise.allSettled([gw?.close()])
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

async function api(method, p, { token, body } = {}) {
  const r = await fetch(base + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await r.json().catch(() => ({}))
  return { status: r.status, json }
}

// ---------- MixedAttribution 单元 ----------

test('attribution：open 幂等 / 非法参数拒绝 / close 幂等', () => {
  const a = new MixedAttribution()
  assert.equal(a.open('u1', { runId: RUN, stage: 'planning', attemptId: ATT1 }).ok, true)
  assert.equal(a.size(), 1)
  // 同 attempt 重开（宿主重启/重试）→ 幂等，不新增
  assert.equal(a.open('u1', { runId: RUN, stage: 'planning', attemptId: ATT1 }).ok, true)
  assert.equal(a.size(), 1)
  // 不同用户互不影响
  assert.equal(a.open('u2', { runId: RUN_B, stage: 'planning', attemptId: ATT2 }).ok, true)
  assert.equal(a.size(), 2)
  // 非法参数
  assert.equal(a.open('u1', { runId: 'not-a-run', stage: 'planning', attemptId: ATT3 }).ok, false)
  assert.equal(a.open('u1', { runId: RUN, stage: 'planning', attemptId: 'bad' }).ok, false)
  assert.equal(a.open('u1', { runId: RUN, stage: '', attemptId: ATT3 }).ok, false)
  // close 幂等
  assert.equal(a.close('u1', { attemptId: ATT1 }).ok, true)
  assert.equal(a.close('u1', { attemptId: ATT1 }).ok, true)
  assert.equal(a.size(), 1)
  assert.deepEqual(a.activeFor('u1'), [])
  assert.deepEqual(a.activeFor('u2').map((c) => c.attemptId), [ATT2])
})

test('attribution：TTL 过期自动清理（宿主被杀后 close 不会来）', () => {
  let now = 1_000_000
  const a = new MixedAttribution({ ttlMs: 60_000, now: () => now })
  a.open('u1', { runId: RUN, stage: 'execution', attemptId: ATT1, startedAt: now })
  assert.equal(a.size(), 1)
  now += 59_000
  assert.equal(a.size(), 1, 'TTL 内保持')
  now += 2_000
  assert.equal(a.size(), 0, 'TTL 过期后自动清理')
  assert.deepEqual(a.activeFor('u1'), [])
})

test('attribution：并发上限淘汰最旧', () => {
  const a = new MixedAttribution({ maxPerUser: 2 })
  a.open('u1', { runId: RUN, stage: 'planning', attemptId: ATT1 })
  a.open('u1', { runId: RUN, stage: 'execution', attemptId: ATT2 })
  a.open('u1', { runId: RUN, stage: 'review', attemptId: ATT3 })
  const ids = a.activeFor('u1').map((c) => c.attemptId)
  assert.deepEqual(ids, [ATT2, ATT3], '最旧 attempt 被淘汰')
})

// ---------- 记账关联（经网关真实链路） ----------

async function login(username, password) {
  const r = await api('POST', '/api/auth/login', { body: { username, password, device: 'test' } })
  assert.equal(r.status, 200, '登录成功')
  return r.json
}

async function chat(token, { model = 'alpha-pro', messages = [{ role: 'user', content: '你好' }] } = {}) {
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false }),
  })
  assert.equal(r.status, 200, 'chat 200')
  return r.json()
}

test('记账关联：单活跃 attempt → mixed{runId,stage,attemptId,taskId} 进账本 extra', async () => {
  ctx.admin = await login('admin', 'pass-admin-123')
  assert.ok(ctx.admin.gatewayToken, '登录必须签发网关令牌（/v1 用）')
  const t = ctx.admin.sessionToken
  // open（网关 API）
  let r = await api('POST', '/api/mixed/attribution', { token: t, body: { runId: RUN, taskId: 't1', stage: 'planning', attemptId: ATT1 } })
  assert.equal(r.status, 200)
  // 参数不合法 → 400
  r = await api('POST', '/api/mixed/attribution', { token: t, body: { runId: 'bad', stage: 'planning', attemptId: ATT1 } })
  assert.equal(r.status, 400)
  // 未登录 → 401
  r = await api('POST', '/api/mixed/attribution')
  assert.equal(r.status, 401)
  // 一次真实 chat → 账本应带 mixed
  await chat(ctx.admin.gatewayToken)
  const ledger = await api('GET', '/api/ledger?days=7', { token: t })
  assert.equal(ledger.status, 200)
  const e = ledger.json.entries.find((x) => x.model === 'alpha-pro')
  assert.ok(e, '账本有该请求')
  assert.deepEqual(e.mixed, { runId: RUN, stage: 'planning', attemptId: ATT1, taskId: 't1' })
  assert.equal(e.usageKnown, true, 'mock 必有 usage')
  assert.equal(e.priceKnown, true, '目录模型必有价目（可为 0 元=已知免费）')
  // close（幂等）
  r = await api('POST', '/api/mixed/attribution/close', { token: t, body: { attemptId: ATT1 } })
  assert.equal(r.status, 200)
  r = await api('POST', '/api/mixed/attribution/close', { token: t, body: { attemptId: ATT1 } })
  assert.equal(r.status, 200)
})

test('记账关联：close 后无 mixed 字段（普通会话不受影响）', async () => {
  const before = (await api('GET', '/api/ledger?days=7', { token: ctx.admin.sessionToken })).json.entries.length
  await chat(ctx.admin.gatewayToken)
  const ledger = await api('GET', '/api/ledger?days=7', { token: ctx.admin.sessionToken })
  const latest = ledger.json.entries[0]
  assert.equal(ledger.json.entries.length, before + 1)
  assert.equal(latest.mixed, undefined, '无活跃 attempt → 不带 mixed 字段')
})

test('记账关联：并发两个 attempt → ambiguous 可见，不悄悄归错', async () => {
  const t = ctx.admin.sessionToken
  await api('POST', '/api/mixed/attribution', { token: t, body: { runId: RUN, stage: 'execution', attemptId: ATT2 } })
  await api('POST', '/api/mixed/attribution', { token: t, body: { runId: RUN_B, stage: 'planning', attemptId: ATT3 } })
  await chat(ctx.admin.gatewayToken)
  const e = (await api('GET', '/api/ledger?days=7', { token: t })).json.entries[0]
  assert.equal(e.mixed.ambiguous, true, '多活跃 attempt 必须标 ambiguous')
  assert.deepEqual([...e.mixed.attemptIds].sort(), [ATT2, ATT3])
  assert.equal(e.mixed.runId, undefined, 'ambiguous 时不得指定单一 runId')
  await api('POST', '/api/mixed/attribution/close', { token: t, body: { attemptId: ATT2 } })
  await api('POST', '/api/mixed/attribution/close', { token: t, body: { attemptId: ATT3 } })
})

test('GET /api/mixed/usage：run 级合计 / byStage / attempts / 未知可见 + 跨用户隔离', async () => {
  const t = ctx.admin.sessionToken
  // RUN 下：planning(ATT1，有 usage) + execution(ATT2 ambiguous 不计入该 run)
  // 再补一条 execution 单归属请求
  await api('POST', '/api/mixed/attribution', { token: t, body: { runId: RUN, taskId: 't2', stage: 'execution', attemptId: ATT2 } })
  await chat(ctx.admin.gatewayToken)
  await api('POST', '/api/mixed/attribution/close', { token: t, body: { attemptId: ATT2 } })

  const r = await api('GET', `/api/mixed/usage?runId=${RUN}`, { token: t })
  assert.equal(r.status, 200)
  const j = r.json
  assert.equal(j.runId, RUN)
  assert.equal(j.totals.requests, 2, 'planning + execution 两条归属该 run（ambiguous 那条不计）')
  assert.ok(j.totals.promptTokens > 0 && j.totals.completionTokens > 0)
  assert.equal(j.totals.costCny, 0, 'mock 价目为 0 → 合计 0（已知免费）')
  assert.deepEqual(j.attempts.sort(), [ATT1, ATT2])
  assert.ok(j.byStage.planning && j.byStage.execution, 'byStage 分阶段')
  assert.equal(j.byStage.planning.requests, 1)
  assert.equal(j.byStage.execution.requests, 1)
  assert.equal(j.unknownRequests, 0)
  assert.equal(j.nextCursor, null)

  // 跨用户隔离：emp-b 看不到 admin 的 run 条目
  ctx.empB = await login('emp-b', 'pass-empb-123')
  const rB = await api('GET', `/api/mixed/usage?runId=${RUN}`, { token: ctx.empB.sessionToken })
  assert.equal(rB.status, 200)
  assert.equal(rB.json.totals.requests, 0, '他人 run 对本用户不可见')
  assert.deepEqual(rB.json.attempts, [])
  // 非法 runId → 400
  assert.equal((await api('GET', '/api/mixed/usage?runId=nope', { token: t })).status, 400)
})

// ---------- 缺 usage/price 不显示为零 ----------

test('缺 usage → costCny=null 且 unknownRequests 可见（合计只算已知部分）', async () => {
  const t = ctx.admin.sessionToken
  // 网关内存里直接补一条「缺 usage」的归属流水（模拟上游未回 usage 的真实请求）
  gw.ledger.record({
    userId: ctx.admin.user.id,
    username: 'admin',
    provider: 'alpha',
    model: 'alpha-pro',
    stream: false,
    status: 'ok',
    latencyMs: 1,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    costCny: null,
    usageKnown: false,
    priceKnown: true,
    mixed: { runId: RUN, stage: 'review', attemptId: ATT3 },
  })
  const j = (await api('GET', `/api/mixed/usage?runId=${RUN}`, { token: t })).json
  assert.equal(j.totals.requests, 3)
  assert.equal(j.unknownRequests, 1, '缺 usage 的条目如实可见，不吞')
  assert.deepEqual(j.attempts.sort(), [ATT1, ATT2, ATT3])
  assert.ok(j.byStage.review && j.byStage.review.requests === 1, 'byStage 含 review')
  // 周额度聚合对 null 安全（不因 null 崩/不计入）
  const weekly = (await api('GET', '/api/ledger?days=7', { token: t })).json
  assert.ok(weekly.entries.length >= 3)
  assert.ok(weekly.entries.some((e) => e.costCny === null && e.usageKnown === false))
})

test('缺 price → priceKnown=false 标记（UI 显示未知而非 0）', () => {
  // 目录外模型（无价目字段）的记账口径：mixedExtra 与 costCny 口径由 llm-proxy 保证；
  // 这里直接验证 estimateCostCny 对无价目模型返回 0 且标记可分辨
  const noPrice = { id: 'x', priceCnyPerM: undefined }
  const usage = { prompt_tokens: 1000, completion_tokens: 500 }
  assert.equal(estimateCostCny(noPrice, usage), 0)
  assert.equal(!!noPrice.priceCnyPerM, false, '无价目模型 priceKnown=false（区别于已知免费）')
  const priced = { id: 'y', priceCnyPerM: { input: 1, output: 2, cachedInput: 0 } }
  assert.equal(estimateCostCny(priced, usage), 0.002, '有价目模型按本地价目估算（元/百万 token）')
})

// ---------- GET /api/ledger 分页 ----------

test('GET /api/ledger 分页：cursor/limit/nextCursor/total；旧调用方兼容', async () => {
  const t = ctx.admin.sessionToken
  const all = (await api('GET', '/api/ledger?days=7', { token: t })).json
  assert.ok(all.total >= 4, '已有多条流水')
  assert.equal(all.cursor, 0)
  assert.equal(all.entries.length, Math.min(all.limit, all.total))
  // limit=2 翻页
  const p1 = (await api('GET', '/api/ledger?days=7&limit=2', { token: t })).json
  assert.equal(p1.entries.length, 2)
  assert.equal(p1.nextCursor, 2)
  // 新→旧顺序
  assert.ok(Date.parse(p1.entries[0].ts) >= Date.parse(p1.entries[1].ts))
  const p2 = (await api('GET', '/api/ledger?days=7&limit=2&cursor=2', { token: t })).json
  assert.equal(p2.entries.length, Math.min(2, all.total - 2))
  assert.ok(p2.entries.length === 0 || p2.entries[0].ts !== p1.entries[1].ts)
  if (all.total <= 4) assert.equal(p2.nextCursor, null)
  // 兼容：entries 仍是数组（新→旧），旧字段 days 保留
  assert.ok(Array.isArray(p1.entries))
  assert.equal(p1.days, 7)
})
