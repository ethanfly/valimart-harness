/**
 * 首次安装引导：空库不播种演示账号，管理页 / 客户端走 /api/setup 创建初始管理员。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../src/index.js'

let gw
let base
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-setup-test-'))

before(async () => {
  gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: tmp,
    seedAdmin: false,
    seedUsers: [],
    company: { name: 'valimart harness', plan: '团队版', seats: 20 },
    upstreams: { mock: { kind: 'mock', label: 'Mock', models: [{ id: 'mock-echo', name: 'Mock Echo', priceCnyPerM: { input: 1, output: 2, cachedInput: 0.1 } }] } },
    channels: [],
    defaultModel: 'mock-echo',
    fetchReleases: async () => [],
  })
  base = await gw.listen()
})

after(async () => {
  await gw.close()
  fs.rmSync(tmp, { recursive: true, force: true })
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

test('seedAdmin:false 时空库不播种，GET /api/setup 提示需要引导', async () => {
  assert.equal(gw.db.listUsers().length, 0)
  const r = await api('GET', '/api/setup')
  assert.equal(r.status, 200)
  assert.equal(r.json.needsSetup, true)
  assert.ok(r.json.companyName)
})

test('POST /api/setup 创建公司与首个管理员，并直接登录；演示账号不会出现', async () => {
  const r = await api('POST', '/api/setup', {
    body: {
      companyName: '瓦力商贸',
      admin: { username: 'admin', displayName: '系统管理员', password: 'admin123456', department: '管理层' },
      colleagues: [{ username: 'alex', displayName: '阿乐', password: 'alex123456', role: 'employee', department: '内容部' }],
      device: 'test',
    },
  })
  assert.equal(r.status, 201, r.json.error?.message)
  assert.equal(r.json.user.username, 'admin')
  assert.equal(r.json.user.role, 'admin')
  assert.equal(r.json.user.seed, true)
  assert.ok(r.json.sessionToken)
  assert.ok(r.json.gatewayToken)
  assert.equal(r.json.company.name, '瓦力商贸')
  assert.equal(r.json.colleagues.length, 1)
  assert.equal(r.json.colleagues[0].username, 'alex')
  const names = gw.db.listUsers().map((u) => u.username).sort()
  assert.deepEqual(names, ['admin', 'alex'])
  assert.ok(!names.includes('boss'))
  assert.ok(!names.includes('emp-a'))
})

test('已经完成设置后 GET needsSetup=false，再次 POST 返回 409', async () => {
  const get = await api('GET', '/api/setup')
  assert.equal(get.json.needsSetup, false)
  const again = await api('POST', '/api/setup', {
    body: { companyName: 'X', admin: { username: 'other', password: 'other123' } },
  })
  assert.equal(again.status, 409)
  assert.equal(again.json.error.code, 'already_setup')
})

test('POST /api/setup 校验：空公司名、短密码、非法账号', async () => {
  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-setup-val-'))
  const extra = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: freshDir,
    seedAdmin: false,
    seedUsers: [],
    upstreams: { mock: { kind: 'mock', label: 'Mock', models: [{ id: 'mock-echo', name: 'Mock Echo', priceCnyPerM: { input: 0, output: 0, cachedInput: 0 } }] } },
    fetchReleases: async () => [],
  })
  const url = await extra.listen()
  try {
    const call = async (body) => {
      const r = await fetch(url + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: r.status, json: await r.json() }
    }
    assert.equal((await call({ companyName: '  ', admin: { username: 'a1', password: 'abcdef' } })).status, 400)
    assert.equal((await call({ companyName: 'C', admin: { username: 'a1', password: '123' } })).status, 400)
    assert.equal((await call({ companyName: 'C', admin: { username: '中文', password: 'abcdef' } })).status, 400)
    assert.equal((await call({ companyName: 'C', admin: { username: 'ok', password: 'abcdef', passwordConfirm: 'xxxxxx' } })).status, 400)
    assert.equal(extra.db.listUsers().length, 0, '校验失败不得留下半成品账号')
  } finally {
    await extra.close()
    fs.rmSync(freshDir, { recursive: true, force: true })
  }
})
