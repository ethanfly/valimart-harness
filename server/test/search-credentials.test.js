/**
 * 搜索供应商凭据端点：/api/search/anysearch 只回给已登录会话；未配置回 null；值不进其他状态接口。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../src/index.js'

let gw
let base
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-search-key-test-'))

before(async () => {
  gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: tmp,
    upstreams: { mock: { kind: 'mock', label: 'Mock', models: [{ id: 'mock-echo', name: 'Mock Echo', priceCnyPerM: { input: 1, output: 2, cachedInput: 0.1 } }] } },
    search: { anysearch: { apiKey: 'as_sk_company_key' } },
    defaultModel: 'mock-echo',
    quota: { anchor: '2026-08-31T17:45:21+08:00', weeklyCny: 100, byRole: { admin: 1000, employee: 100 } },
    fetchReleases: async () => [],
    fetchModels: async () => new Response(JSON.stringify({ error: 'no' }), { status: 404 }),
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
  const text = await r.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { text }
  }
  return { status: r.status, json }
}

test('未登录取搜索密钥 → 401', async () => {
  const r = await api('GET', '/api/search/anysearch')
  assert.equal(r.status, 401)
})

test('登录后取到公司配置的 AnySearch key；key 不出现在 /api/auth/me 等状态接口', async () => {
  const login = await api('POST', '/api/auth/login', { body: { username: 'boss', password: 'boss123456', device: 'test' } })
  assert.equal(login.status, 200)
  const token = login.json.sessionToken

  const r = await api('GET', '/api/search/anysearch', { token })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { anysearch: { apiKey: 'as_sk_company_key' } })

  const me = await api('GET', '/api/auth/me', { token })
  assert.equal(me.status, 200)
  assert.doesNotMatch(JSON.stringify(me.json), /as_sk_company_key/)
  const state = await api('POST', '/api/presence', { token, body: {} })
  assert.doesNotMatch(JSON.stringify(state.json), /as_sk_company_key/)
})

test('网关没配 key → 端点回 null（客户端留在匿名额度）', async () => {
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-search-key-test2-'))
  const gw2 = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: tmp2,
    upstreams: { mock: { kind: 'mock', label: 'Mock', models: [{ id: 'mock-echo', name: 'Mock Echo' }] } },
    defaultModel: 'mock-echo',
    quota: { anchor: '2026-08-31T17:45:21+08:00', weeklyCny: 100, byRole: { admin: 1000, employee: 100 } },
    fetchReleases: async () => [],
    fetchModels: async () => new Response(JSON.stringify({ error: 'no' }), { status: 404 }),
  })
  const base2 = await gw2.listen()
  try {
    const login = await fetch(`${base2}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'boss123456', device: 'test' }),
    }).then((x) => x.json())
    const r = await fetch(`${base2}/api/search/anysearch`, { headers: { authorization: `Bearer ${login.sessionToken}` } }).then((x) => x.json())
    assert.deepEqual(r, { anysearch: null })
  } finally {
    await gw2.close()
    fs.rmSync(tmp2, { recursive: true, force: true })
  }
})
