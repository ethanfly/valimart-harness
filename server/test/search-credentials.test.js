/**
 * 搜索供应商凭据：/api/search/anysearch 只回给已登录会话；管理页可设置/清除，且绝不回显 key。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../src/index.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-search-key-test-'))
let gw
let base
let token

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
  const login = await api('POST', '/api/auth/login', { body: { username: 'boss', password: 'boss123456', device: 'test' } })
  token = login.json.sessionToken
})

after(async () => {
  await gw.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function api(method, p, { token: t = token, body } = {}) {
  const r = await fetch(base + p, {
    method,
    headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
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
  const r = await api('GET', '/api/search/anysearch', { token: null })
  assert.equal(r.status, 401)
})

test('登录后取到公司配置的 AnySearch key；key 不出现在 /api/auth/me 等状态接口', async () => {
  const r = await api('GET', '/api/search/anysearch')
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { anysearch: { apiKey: 'as_sk_company_key' } })

  const me = await api('GET', '/api/auth/me')
  assert.equal(me.status, 200)
  assert.doesNotMatch(JSON.stringify(me.json), /as_sk_company_key/)
  const state = await api('POST', '/api/presence', { body: {} })
  assert.doesNotMatch(JSON.stringify(state.json), /as_sk_company_key/)
})

test('管理页端点：员工不可见；管理员只见状态与来源，不回显 key', async () => {
  const emp = await api('POST', '/api/auth/login', { body: { username: 'emp-a', password: 'emp123456', device: 'test' } })
  const empToken = emp.json.sessionToken
  const denied = await api('GET', '/api/admin/search', { token: empToken })
  assert.equal(denied.status, 403)
  const deniedPut = await api('PUT', '/api/admin/search/anysearch', { token: empToken, body: { apiKey: 'as_sk_hack' } })
  assert.equal(deniedPut.status, 403)

  const view = await api('GET', '/api/admin/search')
  assert.equal(view.status, 200)
  assert.deepEqual(view.json, { anysearch: { configured: true, source: 'config', sourceLabel: '服务端配置 / 环境变量' } })
  assert.doesNotMatch(JSON.stringify(view.json), /as_sk_/)
})

test('管理页保存 → 立即覆盖配置值下发给员工；清除 → 回退到配置值', async () => {
  const saved = await api('PUT', '/api/admin/search/anysearch', { body: { apiKey: '  as_sk_from_admin_page  ' } })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.json, { anysearch: { configured: true, source: 'admin-page', sourceLabel: '管理页设置' } })
  assert.doesNotMatch(JSON.stringify(saved.json), /as_sk_from_admin_page/)

  const employee = await api('GET', '/api/search/anysearch')
  assert.deepEqual(employee.json, { anysearch: { apiKey: 'as_sk_from_admin_page' } })

  const cleared = await api('PUT', '/api/admin/search/anysearch', { body: { apiKey: '' } })
  assert.deepEqual(cleared.json, { anysearch: { configured: true, source: 'config', sourceLabel: '服务端配置 / 环境变量' } })
  const back = await api('GET', '/api/search/anysearch')
  assert.deepEqual(back.json, { anysearch: { apiKey: 'as_sk_company_key' } })
})

test('key 里带空白字符 → 400，且不改动已保存的值', async () => {
  const bad = await api('PUT', '/api/admin/search/anysearch', { body: { apiKey: 'as_sk_bad key' } })
  assert.equal(bad.status, 400)
  const view = await api('GET', '/api/admin/search')
  assert.equal(view.json.anysearch.source, 'config')
})

test('管理页 HTML 带搜索密钥卡片与保存入口', async () => {
  const r = await fetch(base + '/admin')
  const html = await r.text()
  assert.equal(r.status, 200)
  assert.match(html, /id="searchkey"/)
  assert.match(html, /\/api\/admin\/search\/anysearch/)
  assert.match(html, /搜索密钥/)
})

test('网关没配 key → 端点回 null；管理页保存后员工立刻拿到，清除后回 null', async () => {
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
  const call = async (method, p, { body, t } = {}) => {
    const r = await fetch(base2 + p, {
      method,
      headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: r.status, json: await r.json().catch(() => ({})) }
  }
  try {
    const login = await call('POST', '/api/auth/login', { body: { username: 'boss', password: 'boss123456', device: 'test' } })
    const t = login.json.sessionToken
    assert.deepEqual((await call('GET', '/api/search/anysearch', { t })).json, { anysearch: null })
    assert.deepEqual((await call('GET', '/api/admin/search', { t })).json, { anysearch: { configured: false, source: null, sourceLabel: null } })

    await call('PUT', '/api/admin/search/anysearch', { t, body: { apiKey: 'as_sk_only_ui' } })
    assert.deepEqual((await call('GET', '/api/search/anysearch', { t })).json, { anysearch: { apiKey: 'as_sk_only_ui' } })

    await call('PUT', '/api/admin/search/anysearch', { t, body: { apiKey: '' } })
    assert.deepEqual((await call('GET', '/api/search/anysearch', { t })).json, { anysearch: null })
  } finally {
    await gw2.close()
    fs.rmSync(tmp2, { recursive: true, force: true })
  }
})
