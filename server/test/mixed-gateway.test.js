/**
 * Mixed T02 网关闭环测试（node --test）：
 * - 登录/me/心跳返回稳定 gatewayInstanceId（与 /health 一致）
 * - /api/mixed/catalog：鉴权、runtimeModelId、角色能力、conflicts
 * - 验收口径：A/B 账号隔离、同名公司不同实例、重复模型 ID 分流可选、模型下架
 * - 重复模型 ID 的两个网关实例共用一份上游配置工厂
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../src/index.js'
import { modelCatalog } from '../src/config.js'
import { buildCatalogIndex } from '../src/model-resolver.js'
import { computeOwnerKey, ownerIdentityChanged, nextOwnerEpoch, fenceStaleRuns } from '../../plugins/desk-host/lib/mixed/owner.js'

const mktmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))

function makeUpstreams() {
  return {
    alpha: { kind: 'mock', label: 'Alpha', models: [{ id: 'alpha-pro', name: 'Alpha Pro' }, { id: 'alpha-fast', name: 'Alpha Fast' }] },
    beta: { kind: 'mock', label: 'Beta', models: [{ id: 'beta-pro', name: 'Beta Pro' }] },
  }
}

let gwA
let gwB
let baseA
let baseB
let tmpA
let tmpB

before(async () => {
  tmpA = mktmp('mixed-gw-a-')
  tmpB = mktmp('mixed-gw-b-')
  gwA = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: tmpA,
    upstreams: makeUpstreams(),
    seedAdmin: { username: 'admin-a', password: 'pass-aaaa-123', displayName: '管理员', department: '管理层' },
    seedUsers: [{ username: 'emp-a', password: 'pass-aaaa-123' }],
    fetchReleases: async () => [],
  })
  // B：同公司（同 seed）不同实例（不同 dataDir → 不同 instance-id）
  gwB = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: tmpB,
    upstreams: makeUpstreams(),
    seedAdmin: { username: 'admin-a', password: 'pass-aaaa-123', displayName: '管理员', department: '管理层' },
    seedUsers: [{ username: 'emp-a', password: 'pass-aaaa-123' }],
    fetchReleases: async () => [],
  })
  baseA = await gwA.listen()
  baseB = await gwB.listen()
})

after(async () => {
  await Promise.allSettled([gwA?.close(), gwB?.close()])
  for (const t of [tmpA, tmpB]) if (t) fs.rmSync(t, { recursive: true, force: true })
})

async function api(base, method, p, { token, body } = {}) {
  const r = await fetch(base + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await r.json().catch(() => ({}))
  return { status: r.status, json }
}

const ctx = {}

test('登录返回稳定 gatewayInstanceId，与 /health 一致', async () => {
  const login = await api(baseA, 'POST', '/api/auth/login', { body: { username: 'admin-a', password: 'pass-aaaa-123', device: 'test' } })
  assert.equal(login.status, 200)
  assert.ok(login.json.gatewayInstanceId, '登录响应必须携带 gatewayInstanceId')
  assert.match(login.json.gatewayInstanceId, /^[0-9a-f-]{36}$/)
  ctx.admin = login.json
  const health = await api(baseA, 'GET', '/health')
  assert.equal(health.json.instanceId, login.json.gatewayInstanceId)
})

test('me 与心跳也返回 gatewayInstanceId（老客户端兼容：只增字段）', async () => {
  const me = await api(baseA, 'GET', '/api/auth/me', { token: ctx.admin.sessionToken })
  assert.equal(me.status, 200)
  assert.equal(me.json.gatewayInstanceId, ctx.admin.gatewayInstanceId)
  assert.ok(me.json.user.id && me.json.company.models.length, '老字段保持不变')
  const pres = await api(baseA, 'POST', '/api/presence', { token: ctx.admin.sessionToken, body: {} })
  assert.equal(pres.status, 200)
  assert.equal(pres.json.gatewayInstanceId, ctx.admin.gatewayInstanceId)
  assert.ok(pres.json.modelsSignature, 'modelsSignature 保持不变')
})

test('/api/mixed/catalog：未登录 401；登录后可用且与目录索引一致', async () => {
  const anon = await api(baseA, 'GET', '/api/mixed/catalog')
  assert.equal(anon.status, 401)
  const cat = await api(baseA, 'GET', '/api/mixed/catalog', { token: ctx.admin.sessionToken })
  assert.equal(cat.status, 200)
  assert.equal(cat.json.gatewayInstanceId, ctx.admin.gatewayInstanceId)
  assert.ok(cat.json.capabilitiesRevision.startsWith('rev-'))
  // 基线 config.json 的上游会合并进来（与其他网关测试同一口径）：只断言本测试注入的模型在场、无冲突
  const ids = cat.json.models.map((m) => m.id)
  for (const id of ['alpha-fast', 'alpha-pro', 'beta-pro']) assert.ok(ids.includes(id), `catalog 应包含 ${id}`)
  assert.deepEqual(cat.json.conflicts, [], '基线目录 + 注入目录不得产生重复/碰撞')
  const pro = cat.json.models.find((m) => m.id === 'alpha-pro')
  assert.equal(pro.runtimeModelId, 'alpha-pro')
  assert.equal(pro.provider, 'alpha')
  assert.ok(pro.mixedRoles && typeof pro.mixedRoles.planner === 'boolean')
  // 修订号必须等于目录索引计算值（单一权威）
  const index = buildCatalogIndex(modelCatalog(gwA.cfg))
  assert.equal(index.capabilitiesRevision, cat.json.capabilitiesRevision)
})

test('A/B 账号隔离：同实例两账号 → ownerKey 不同；账号不变 → epoch 不变', async () => {
  const emp = await api(baseA, 'POST', '/api/auth/login', { body: { username: 'emp-a', password: 'pass-aaaa-123', device: 'test' } })
  assert.equal(emp.status, 200)
  ctx.emp = emp.json
  const profileId = 'profile-test'
  const kAdmin = computeOwnerKey({ gatewayInstanceId: ctx.admin.gatewayInstanceId, userId: ctx.admin.user.id, profileId })
  const kEmp = computeOwnerKey({ gatewayInstanceId: ctx.emp.gatewayInstanceId, userId: ctx.emp.user.id, profileId })
  assert.ok(kAdmin && kEmp && kAdmin !== kEmp, '同实例不同账号必须不同 ownerKey')
  // 实例或账号任一变化 → identity changed → epoch+1
  assert.equal(ownerIdentityChanged({ gatewayInstanceId: ctx.admin.gatewayInstanceId, userId: ctx.admin.user.id }, { gatewayInstanceId: ctx.admin.gatewayInstanceId, userId: ctx.emp.user.id }), true)
  assert.equal(ownerIdentityChanged({ gatewayInstanceId: 'x', userId: '1' }, { gatewayInstanceId: 'x', userId: '1' }), false)
  assert.deepEqual(nextOwnerEpoch(3, false), { epoch: 3, fenced: false })
  assert.deepEqual(nextOwnerEpoch(3, true), { epoch: 4, fenced: true })
  // fence：旧 owner/旧 epoch 的未终结 run 被标记
  const stale = fenceStaleRuns(
    [
      { runId: 'r1', ownerKey: kAdmin, ownerEpoch: 4, status: 'executing' },
      { runId: 'r2', ownerKey: kEmp, ownerEpoch: 4, status: 'executing' },
      { runId: 'r3', ownerKey: kEmp, ownerEpoch: 3, status: 'succeeded' },
    ],
    { ownerKey: kEmp, ownerEpoch: 4 },
  )
  assert.deepEqual(stale.map((r) => r.runId), ['r1'])
})

test('同名公司不同实例：同账号同 profile → gatewayInstanceId 不同 → ownerKey 不同', async () => {
  const loginB = await api(baseB, 'POST', '/api/auth/login', { body: { username: 'admin-a', password: 'pass-aaaa-123', device: 'test' } })
  assert.equal(loginB.status, 200)
  assert.notEqual(loginB.json.gatewayInstanceId, ctx.admin.gatewayInstanceId, '不同实例必须不同 gatewayInstanceId')
  const kA = computeOwnerKey({ gatewayInstanceId: ctx.admin.gatewayInstanceId, userId: ctx.admin.user.id, profileId: 'profile-test' })
  const kB = computeOwnerKey({ gatewayInstanceId: loginB.json.gatewayInstanceId, userId: ctx.admin.user.id, profileId: 'profile-test' })
  assert.notEqual(kA, kB, '同名账号不同实例必须不同 ownerKey')
})

test('重复模型 ID：两个上游同 id → 后出现的分流为 id--provider，两边都可选', async () => {
  const gwDup = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: mktmp('mixed-gw-dup-'),
    upstreams: {
      alpha: { kind: 'mock', label: 'Alpha', models: [{ id: 'shared-model', name: 'A' }] },
      beta: { kind: 'mock', label: 'Beta', models: [{ id: 'shared-model', name: 'B' }] },
      solo: { kind: 'mock', label: 'Solo', models: [{ id: 'solo-model', name: 'S' }] },
    },
    seedAdmin: { username: 'admin-d', password: 'pass-dup-123', displayName: '管理员', department: '管理层' },
    fetchReleases: async () => [],
  })
  try {
    const baseD = await gwDup.listen()
    const login = await api(baseD, 'POST', '/api/auth/login', { body: { username: 'admin-d', password: 'pass-dup-123', device: 'test' } })
    const cat = await api(baseD, 'GET', '/api/mixed/catalog', { token: login.json.sessionToken })
    assert.equal(cat.status, 200)
    const ids = cat.json.models.map((m) => m.id)
    assert.ok(ids.includes('shared-model'), '先出现的上游保留原 id')
    assert.ok(ids.includes('shared-model--beta'), '后出现的上游分流，避免选择器两边都丢')
    assert.ok(!cat.json.conflicts.some((c) => c.kind === 'duplicate-modelId'), '分流后不再标 duplicate-modelId')
    assert.ok(ids.includes('solo-model'), '无冲突模型保持可选')
  } finally {
    await gwDup.close()
  }
})

test('模型下架：目录变化 → capabilitiesRevision 变化（客户端据此明确失效已存路由）', async () => {
  const cat1 = await api(baseA, 'GET', '/api/mixed/catalog', { token: ctx.admin.sessionToken })
  // 运行中从目录移除一个模型（模拟管理员下架），目录函数读 cfg.upstreams，直接改内存目录即可
  const beta = gwA.cfg.upstreams.beta
  const removed = beta.models.shift()
  try {
    const cat2 = await api(baseA, 'GET', '/api/mixed/catalog', { token: ctx.admin.sessionToken })
    assert.notEqual(cat2.json.capabilitiesRevision, cat1.json.capabilitiesRevision, '下架模型必须改变修订号')
    assert.ok(!cat2.json.models.some((m) => m.id === removed.id))
  } finally {
    beta.models.unshift(removed)
  }
})
