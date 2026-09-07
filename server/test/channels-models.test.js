import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../src/index.js'

let fake
let fakeUrl
let hits = []
let gw
let base
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-channels-models-'))

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
}

async function api(method, p, { token, body } = {}) {
  const r = await fetch(base + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await r.json().catch(() => ({}))
  return { status: r.status, json }
}

before(async () => {
  fake = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url })
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'acme-large', context_window: 180000 }, { id: 'acme-fast' }] }))
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const key = req.headers.authorization
      if (key === 'Bearer key-exhausted') {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'quota exceeded' } }))
        return
      }
      if (key === 'Bearer key-ok') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'from-2' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }))
        return
      }
      res.writeHead(401)
      res.end('no')
    })
  })
  fakeUrl = await listen(fake)
  gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: tmp,
    seedUsers: [],
    upstreams: {},
    channels: [{ id: 'acme', label: 'Acme', kind: 'key', baseUrl: `${fakeUrl}/v1`, hint: 'acme-large' }],
    defaultModel: 'acme-large',
    fetchReleases: async () => [],
    fetchModels: (url, opts) => fetch(url, opts),
  })
  base = await gw.listen()
})

after(async () => {
  await gw.close()
  fake.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('自定义端点 + 自动拉模型 + 上下文/思考强度', async () => {
  const login = await api('POST', '/api/auth/login', { body: { username: 'boss', password: 'boss123456', device: 'test' } })
  assert.equal(login.status, 200)
  const token = login.json.sessionToken
  const created = await api('POST', '/api/channels', {
    token,
    body: { label: '自建', baseUrl: `${fakeUrl}/v1`, credential: 'key-ok', models: 'custom-large', reasoningEfforts: ['low', 'high'], contextWindow: 123456 },
  })
  assert.equal(created.status, 200, created.json.error?.message)
  assert.equal(created.json.channel.custom, true)
  assert.ok(created.json.channel.models.includes('custom-large'))
  const me = await api('GET', '/api/auth/me', { token })
  const model = me.json.company.models.find((m) => m.id === 'custom-large')
  assert.ok(model)
  assert.equal(model.contextWindow, 123456)
  assert.deepEqual(model.reasoningEfforts, ['low', 'high'])
})

test('已接入通道可编辑模型与上下文，不改凭据', async () => {
  const login = await api('POST', '/api/auth/login', { body: { username: 'boss', password: 'boss123456', device: 'test' } })
  const token = login.json.sessionToken
  const list = await api('GET', '/api/channels', { token })
  const custom = list.json.channels.find((c) => c.custom && c.connected)
  assert.ok(custom, '应先有一条已接入的自定义通道')
  const credBefore = gw.channels.store.load().items[custom.id].credential

  const edited = await api('PATCH', `/api/channels/${custom.id}`, {
    token,
    body: { models: 'custom-mini, custom-large', contextWindow: 64000 },
  })
  assert.equal(edited.status, 200, edited.json.error?.message)
  assert.ok(edited.json.channel.models.includes('custom-mini'))
  assert.ok(edited.json.channel.models.includes('custom-large'))
  const detail = edited.json.channel.modelDetails.find((m) => m.id === 'custom-mini')
  assert.equal(detail?.contextWindow, 64000)
  assert.equal(gw.channels.store.load().items[custom.id].credential, credBefore)

  const me = await api('GET', '/api/auth/me', { token })
  const model = me.json.company.models.find((m) => m.id === 'custom-mini')
  assert.ok(model)
  assert.equal(model.contextWindow, 64000)

  const empty = await api('PATCH', `/api/channels/${custom.id}`, { token, body: { models: '' } })
  assert.equal(empty.status, 400)

  const missing = await api('PATCH', '/api/channels/acme', { token, body: { models: 'acme-fast' } })
  assert.equal(missing.status, 409)

  const created = await api('POST', '/api/personnel/users', {
    token,
    body: { username: 'ch-edit-emp', password: 'emp123456', displayName: '编辑探针', role: 'employee', department: '测试' },
  })
  assert.equal(created.status, 201, created.json.error?.message)
  const emp = await api('POST', '/api/auth/login', { body: { username: 'ch-edit-emp', password: 'emp123456', device: 'test' } })
  const forbidden = await api('PATCH', `/api/channels/${custom.id}`, {
    token: emp.json.sessionToken,
    body: { models: 'custom-large' },
  })
  assert.equal(forbidden.status, 403)
})

test('每个模型可单独设上下文，未填的用通道默认', async () => {
  const login = await api('POST', '/api/auth/login', { body: { username: 'boss', password: 'boss123456', device: 'test' } })
  const token = login.json.sessionToken
  const list = await api('GET', '/api/channels', { token })
  const custom = list.json.channels.find((c) => c.custom && c.connected)
  assert.ok(custom, '应先有一条已接入的自定义通道')
  const credBefore = gw.channels.store.load().items[custom.id].credential

  const edited = await api('PATCH', `/api/channels/${custom.id}`, {
    token,
    body: {
      models: [
        { id: 'custom-mini', contextWindow: 32000 },
        { id: 'custom-large' },
      ],
      contextWindow: 64000,
    },
  })
  assert.equal(edited.status, 200, edited.json.error?.message)
  const mini = edited.json.channel.modelDetails.find((m) => m.id === 'custom-mini')
  const large = edited.json.channel.modelDetails.find((m) => m.id === 'custom-large')
  assert.equal(mini?.contextWindow, 32000)
  assert.equal(large?.contextWindow, 64000)
  assert.equal(gw.channels.store.load().items[custom.id].credential, credBefore)

  const me = await api('GET', '/api/auth/me', { token })
  assert.equal(me.json.company.models.find((m) => m.id === 'custom-mini')?.contextWindow, 32000)
  assert.equal(me.json.company.models.find((m) => m.id === 'custom-large')?.contextWindow, 64000)
})

test('每个模型可单独设是否支持图片识别', async () => {
  const login = await api('POST', '/api/auth/login', { body: { username: 'boss', password: 'boss123456', device: 'test' } })
  const token = login.json.sessionToken
  const created = await api('POST', '/api/channels', {
    token,
    body: { label: '识图通道', baseUrl: `${fakeUrl}/v1`, credential: 'key-ok', models: 'vision-off-mini, vision-on-large' },
  })
  assert.equal(created.status, 200, created.json.error?.message)
  const custom = created.json.channel

  const edited = await api('PATCH', `/api/channels/${custom.id}`, {
    token,
    body: {
      models: [
        { id: 'vision-off-mini', vision: false },
        { id: 'vision-on-large', vision: true },
      ],
    },
  })
  assert.equal(edited.status, 200, edited.json.error?.message)
  const mini = edited.json.channel.modelDetails.find((m) => m.id === 'vision-off-mini')
  const large = edited.json.channel.modelDetails.find((m) => m.id === 'vision-on-large')
  assert.equal(mini?.vision, false)
  assert.equal(large?.vision, true)

  const me = await api('GET', '/api/auth/me', { token })
  assert.deepEqual(me.json.company.models.find((m) => m.id === 'vision-off-mini')?.input, ['text'])
  assert.equal(me.json.company.models.find((m) => m.id === 'vision-off-mini')?.vision, false)
  assert.deepEqual(me.json.company.models.find((m) => m.id === 'vision-on-large')?.input, ['text', 'image'])
  assert.equal(me.json.company.models.find((m) => m.id === 'vision-on-large')?.vision, true)
})

test('自定义端点 baseUrl 无 /v1 时聊天打 /v1/chat/completions', async () => {
  const login = await api('POST', '/api/auth/login', { body: { username: 'boss', password: 'boss123456', device: 'test' } })
  const token = login.json.sessionToken
  hits.length = 0
  const created = await api('POST', '/api/channels', {
    token,
    body: { label: '无v1通道', baseUrl: fakeUrl, credential: 'key-ok', models: 'plain-chat' },
  })
  assert.equal(created.status, 200, created.json.error?.message)
  const chat = await api('POST', '/v1/chat/completions', {
    token: login.json.gatewayToken,
    body: { model: 'plain-chat', messages: [{ role: 'user', content: 'hi' }], stream: false },
  })
  assert.equal(chat.status, 200, JSON.stringify(chat.json))
  assert.ok(hits.some((h) => h.method === 'POST' && h.url === '/v1/chat/completions'), JSON.stringify(hits))
  assert.equal(hits.some((h) => h.url === '/chat/completions'), false)
})

test('同一通道多账号：额度用尽切到下一个', async () => {
  const login = await api('POST', '/api/auth/login', { body: { username: 'boss', password: 'boss123456', device: 'test' } })
  const token = login.json.sessionToken
  const a1 = await api('POST', '/api/channels/acme/connect', { token, body: { credential: 'key-exhausted', models: 'acme-large' } })
  assert.equal(a1.status, 200, a1.json.error?.message)
  const a2 = await api('POST', '/api/channels/acme/connect', { token, body: { credential: 'key-ok', models: 'acme-large' } })
  assert.equal(a2.status, 200)
  assert.equal(a2.json.channel.accountCount, 2)
  const chat = await api('POST', '/v1/chat/completions', {
    token: login.json.gatewayToken,
    body: { model: 'acme-large', messages: [{ role: 'user', content: 'hi' }] },
  })
  assert.equal(chat.status, 200, JSON.stringify(chat.json))
  assert.equal(chat.json.choices[0].message.content, 'from-2')
  const view = await api('GET', '/api/channels', { token })
  const acme = view.json.channels.find((c) => c.id === 'acme')
  assert.ok(acme.accounts.some((a) => a.status === 'exhausted'))
})

test('插件列表兼容 DSH plugin inventory', async () => {
  const login = await api('POST', '/api/auth/login', { body: { username: 'boss', password: 'boss123456', device: 'test' } })
  const r = await api('GET', '/api/plugins', { token: login.json.sessionToken })
  assert.equal(r.status, 200)
  assert.equal(r.json.format, 'dsh-plugin-inventory')
  assert.ok(r.json.entries.some((e) => e.entryId === 'desk-host' || e.moduleName.includes('desk-host') || e.entryId === 'plugin-inventory'))
})

test('手动增加知识库', async () => {
  const login = await api('POST', '/api/auth/login', { body: { username: 'boss', password: 'boss123456', device: 'test' } })
  const r = await api('POST', '/api/knowledge/entries', {
    token: login.json.sessionToken,
    body: { title: '发货核对', content: '先对单再出库', scope: 'shared', layer: '02-methods' },
  })
  assert.equal(r.status, 200, r.json.error?.message)
  assert.match(r.json.entry.path, /_shared\/_memory\/02-methods/)
  const col = await api('GET', '/api/knowledge/collections', { token: login.json.sessionToken })
  assert.ok(col.json.shared['02-methods'].files.some((f) => f.name.includes('发货核对')))
})
