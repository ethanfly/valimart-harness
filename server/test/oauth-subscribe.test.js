/**
 * 订阅通道官方 OAuth（mock 令牌端点，不打真网、不自动化登录 Grok/ChatGPT/Claude）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../src/index.js'
import { parsePastedOAuthCode } from '../src/oauth-subscribe.js'

const PUBLIC_URL = 'http://oauth-test.example:8790'
const ACCESS = 'xai-oauth-access-should-never-leak'
const REFRESH = 'xai-oauth-refresh-should-never-leak'

let mock
let mockBase
let lastTokenForm = ''
let gw
let base
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-oauth-test-'))

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve(`http://127.0.0.1:${port}`)
    })
  })
}

async function api(method, p, { token, body, accept } = {}) {
  const r = await fetch(base + p, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(accept ? { accept } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { text }
  }
  return { status: r.status, json, text }
}

before(async () => {
  mock = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/oauth/token') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        lastTokenForm = Buffer.concat(chunks).toString('utf8')
        const params = new URLSearchParams(lastTokenForm)
        const okRedirect = [PUBLIC_URL + '/api/oauth/callback', mockBase + '/device/callback', 'https://console.anthropic.com/oauth/code/callback'].includes(params.get('redirect_uri'))
        if (params.get('grant_type') !== 'authorization_code' || params.get('code') !== 'good-code') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid_grant' }))
          return
        }
        if (!params.get('code_verifier') || !okRedirect) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid_request' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH, token_type: 'Bearer', expires_in: 3600 }))
      })
      return
    }
    if (req.method === 'POST' && req.url === '/oauth/token-json') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        lastTokenForm = Buffer.concat(chunks).toString('utf8')
        let body = {}
        try { body = JSON.parse(lastTokenForm) } catch { /* ignore */ }
        if (body.grant_type !== 'authorization_code' || body.code !== 'good-code' || !body.code_verifier) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid_grant' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH, token_type: 'Bearer', expires_in: 3600 }))
      })
      return
    }
    if (req.method === 'POST' && req.url === '/device/usercode') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ user_code: 'WXYZ-9', device_auth_id: 'dev-auth-1', interval: 0, expires_in: 900 }))
      return
    }
    if (req.method === 'POST' && req.url === '/device/token') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ authorization_code: 'good-code', code_verifier: 'device-verifier' }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  mockBase = await listen(mock)

  gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    publicUrl: PUBLIC_URL,
    dataDir: tmp,
    upstreams: { mock: { kind: 'mock', label: 'Mock', models: [{ id: 'mock-echo', name: 'Mock Echo', priceCnyPerM: { input: 1, output: 2, cachedInput: 0 } }] } },
    channels: [
      { id: 'grok', label: 'Grok', kind: 'subscription', baseUrl: 'https://api.x.ai/v1', hint: 'grok-4.6, grok-4.6-fast', reasoningEfforts: ['low', 'high'] },
      { id: 'chatgpt', label: 'ChatGPT', kind: 'subscription', baseUrl: 'https://api.openai.com/v1', hint: 'gpt-5.5' },
      { id: 'claude', label: 'Claude', kind: 'subscription', baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic-messages', hint: 'claude-opus-4-6' },
    ],
    oauth: {
      grok: {
        clientId: 'test-grok-client',
        clientSecret: 'test-grok-secret',
        flow: 'authorization_code',
        authorizeUrl: `${mockBase}/oauth/authorize`,
        tokenUrl: `${mockBase}/oauth/token`,
        scope: 'openid offline_access api:access',
      },
      chatgpt: {
        clientId: 'test-chatgpt',
        deviceUserCodeUrl: `${mockBase}/device/usercode`,
        devicePollUrl: `${mockBase}/device/token`,
        tokenUrl: `${mockBase}/oauth/token`,
        verificationUri: `${mockBase}/device/verify`,
        deviceRedirectUri: `${mockBase}/device/callback`,
      },
      claude: {
        clientId: 'test-claude',
        authorizeUrl: `${mockBase}/oauth/authorize`,
        tokenUrl: `${mockBase}/oauth/token-json`,
        redirectUri: 'https://console.anthropic.com/oauth/code/callback',
        tokenBody: 'json',
        authStyle: 'anthropic-oauth',
      },
    },
    defaultModel: 'mock-echo',
    quickInference: { defaultModel: 'mock-echo' },
    fetchReleases: async () => [],
  })
  base = await gw.listen()
})

after(async () => {
  await gw.close()
  await new Promise((resolve) => mock.close(resolve))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const ctx = {}

test('parsePastedOAuthCode：CODE#STATE 与 callback URL', () => {
  assert.equal(parsePastedOAuthCode('abc123#state'), 'abc123')
  assert.equal(parsePastedOAuthCode('https://console.anthropic.com/oauth/code/callback?code=xyz&state=s'), 'xyz')
  assert.equal(parsePastedOAuthCode('  code=plain  '), 'plain')
})

test('登录：管理员与员工', async () => {
  const boss = await api('POST', '/api/auth/login', { body: { username: 'boss', password: 'boss123456', device: 'oauth-test' } })
  assert.equal(boss.status, 200)
  ctx.boss = boss.json
  const emp = await api('POST', '/api/auth/login', { body: { username: 'emp-a', password: 'emp123456', device: 'oauth-test' } })
  assert.equal(emp.status, 200)
  ctx.emp = emp.json
})

test('通道视图：Grok 回调；ChatGPT 设备码；Claude 贴回授权码', async () => {
  const list = await api('GET', '/api/channels', { token: ctx.boss.sessionToken })
  assert.equal(list.status, 200)
  const grok = list.json.channels.find((c) => c.id === 'grok')
  const gpt = list.json.channels.find((c) => c.id === 'chatgpt')
  const claude = list.json.channels.find((c) => c.id === 'claude')
  assert.equal(grok.oauth.available, true)
  assert.equal(grok.oauth.configured, true)
  assert.equal(grok.oauth.flow, 'authorization_code')
  assert.equal(grok.oauth.callbackUrl, `${PUBLIC_URL}/api/oauth/callback`)
  assert.equal(gpt.oauth.available, true)
  assert.equal(gpt.oauth.configured, true)
  assert.equal(gpt.oauth.flow, 'device_code')
  assert.equal(claude.oauth.available, true)
  assert.equal(claude.oauth.configured, true)
  assert.equal(claude.oauth.flow, 'authorization_code_paste')
  assert.ok(!JSON.stringify(list.json).includes('test-grok-secret'))
})

test('员工发起 OAuth → 403', async () => {
  const r = await api('POST', '/api/channels/grok/oauth/start', { token: ctx.emp.sessionToken, body: { models: 'grok-4.6' } })
  assert.equal(r.status, 403)
  assert.equal(r.json.error.code, 'forbidden')
})

test('ChatGPT 设备码：start 返回一次性代码；status 轮询后接入', async () => {
  const start = await api('POST', '/api/channels/chatgpt/oauth/start', { token: ctx.boss.sessionToken, body: { models: 'gpt-5.5' } })
  assert.equal(start.status, 200)
  assert.equal(start.json.flow, 'device_code')
  assert.equal(start.json.userCode, 'WXYZ-9')
  assert.ok(start.json.verificationUri)
  const st = await api('GET', `/api/channels/chatgpt/oauth/status?state=${encodeURIComponent(start.json.state)}`, { token: ctx.boss.sessionToken })
  assert.equal(st.status, 200)
  assert.equal(st.json.status, 'authorized')
  assert.ok(st.json.models.some((m) => m.id === 'gpt-5.5'))
  assert.equal(gw.channels.store.load().items.chatgpt?.credential, undefined)
  const forbidden = await api('POST', `/api/channels/chatgpt/oauth/commit`, { token: ctx.emp.sessionToken, body: { state: start.json.state, models: ['gpt-5.5'] } })
  assert.equal(forbidden.status, 403)
  const empty = await api('POST', `/api/channels/chatgpt/oauth/commit`, { token: ctx.boss.sessionToken, body: { state: start.json.state, models: [] } })
  assert.equal(empty.status, 400)
  assert.equal(empty.json.error.code, 'models_required')
  const pulled = await api('POST', `/api/channels/chatgpt/discover-models`, { token: ctx.boss.sessionToken, body: { state: start.json.state } })
  assert.equal(pulled.status, 200)
  assert.ok((pulled.json.models || []).some((m) => m.id === 'gpt-5.5'))
  const done = await api('POST', `/api/channels/chatgpt/oauth/commit`, { token: ctx.boss.sessionToken, body: { state: start.json.state, models: 'gpt-5.5, gpt-5.5-mini', contextWindow: 128000, maxTokens: 8192 } })
  assert.equal(done.status, 200)
  assert.equal(done.json.status, 'success')
  const storedGpt = gw.channels.store.load().items.chatgpt
  assert.equal(storedGpt.credential, ACCESS)
  assert.equal(storedGpt.api, 'chatgpt-codex')
  assert.equal(storedGpt.baseUrl, 'https://chatgpt.com/backend-api/codex')
  assert.deepEqual(storedGpt.models.map((m) => m.id ?? m), ['gpt-5.5', 'gpt-5.5-mini'])
  assert.equal(storedGpt.models[0].contextWindow, 128000)
  assert.equal(storedGpt.models[0].maxTokens, 8192)
  assert.equal(storedGpt.models[1].contextWindow, 128000)
  assert.ok(!JSON.stringify(st.json).includes(ACCESS))
  assert.ok(!JSON.stringify(done.json).includes(ACCESS))
})

test('Claude 贴回的 state 必须对应当次登录', async () => {
  const start = await api('POST', '/api/channels/claude/oauth/start', { token: ctx.boss.sessionToken, body: { models: 'claude-opus-4-6' } })
  assert.equal(start.status, 200)
  const bad = await api('POST', '/api/channels/claude/oauth/complete', {
    token: ctx.boss.sessionToken,
    body: { state: start.json.state, code: 'good-code#not-this-session' },
  })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'oauth_state_mismatch')
})

test('Claude 贴回授权码：start 打开官方授权页；complete 换票', async () => {
  const start = await api('POST', '/api/channels/claude/oauth/start', { token: ctx.boss.sessionToken, body: { models: 'claude-opus-4-6' } })
  assert.equal(start.status, 200)
  assert.equal(start.json.flow, 'authorization_code_paste')
  assert.ok(start.json.authorizeUrl.includes('code_challenge='))
  assert.ok(start.json.authorizeUrl.includes('code=true'))
  assert.ok(start.json.authorizeUrl.includes(encodeURIComponent('https://console.anthropic.com/oauth/code/callback')))
  const done = await api('POST', '/api/channels/claude/oauth/complete', {
    token: ctx.boss.sessionToken,
    body: { state: start.json.state, code: `good-code#${start.json.state}` },
  })
  assert.equal(done.status, 200)
  assert.equal(done.json.status, 'authorized')
  assert.ok((done.json.models || []).some((m) => m.id === 'claude-opus-4-6'))
  assert.equal(gw.channels.store.load().items.claude?.credential, undefined)
  const committed = await api('POST', '/api/channels/claude/oauth/commit', {
    token: ctx.boss.sessionToken,
    body: { state: start.json.state, models: ['claude-opus-4-6'] },
  })
  assert.equal(committed.status, 200)
  assert.equal(committed.json.status, 'success')
  const stored = gw.channels.store.load().items.claude
  assert.equal(stored.credential, ACCESS)
  assert.equal(stored.authStyle, 'anthropic-oauth')
})

test('管理员发起授权：URL 带 state 与 PKCE', async () => {
  const r = await api('POST', '/api/channels/grok/oauth/start', { token: ctx.boss.sessionToken, body: { models: 'grok-4.6, grok-4.6-fast', baseUrl: 'https://api.x.ai/v1' } })
  assert.equal(r.status, 200)
  assert.ok(r.json.state)
  assert.ok(r.json.authorizeUrl.includes(`state=${r.json.state}`))
  assert.ok(r.json.authorizeUrl.includes('code_challenge='))
  assert.ok(r.json.authorizeUrl.includes('code_challenge_method=S256'))
  assert.ok(r.json.authorizeUrl.includes(encodeURIComponent(`${PUBLIC_URL}/api/oauth/callback`)))
  assert.ok(r.json.authorizeUrl.includes('client_id=test-grok-client'))
  ctx.start = r.json
  const pending = await api('GET', `/api/channels/grok/oauth/status?state=${encodeURIComponent(r.json.state)}`, { token: ctx.boss.sessionToken })
  assert.equal(pending.status, 200)
  assert.equal(pending.json.status, 'pending')
})

test('callback 错误 state → 400，通道仍未接', async () => {
  const r = await fetch(`${base}/api/oauth/callback?code=good-code&state=not-a-real-state`)
  assert.equal(r.status, 400)
  const text = await r.text()
  assert.ok(!text.includes(ACCESS))
  const list = await api('GET', '/api/channels', { token: ctx.boss.sessionToken })
  assert.equal(list.json.channels.find((c) => c.id === 'grok').connected, false)
})

test('管理员 callback 成功：服务端存凭据，响应与列表不外泄', async () => {
  const cb = await fetch(`${base}/api/oauth/callback?code=good-code&state=${encodeURIComponent(ctx.start.state)}`)
  assert.equal(cb.status, 200)
  const html = await cb.text()
  assert.match(html, /已登录/)
  assert.match(html, /选择要接入的模型/)
  assert.ok(!html.includes(ACCESS))
  assert.ok(!html.includes(REFRESH))
  assert.match(lastTokenForm, /code_verifier=/)
  assert.match(lastTokenForm, /grant_type=authorization_code/)

  const ready = await api('GET', `/api/channels/grok/oauth/status?state=${encodeURIComponent(ctx.start.state)}`, { token: ctx.boss.sessionToken })
  assert.equal(ready.status, 200)
  assert.equal(ready.json.status, 'authorized')
  assert.equal(ready.json.channel.connected, false)
  assert.ok(ready.json.models.some((m) => m.id === 'grok-4.6'))
  assert.ok(ready.json.models.some((m) => m.id === 'grok-4.6-fast'))
  assert.ok(!JSON.stringify(ready.json).includes(ACCESS))
  assert.equal(gw.channels.store.load().items.grok?.credential, undefined)

  const listBefore = await api('GET', '/api/channels', { token: ctx.emp.sessionToken })
  assert.equal(listBefore.json.channels.find((c) => c.id === 'grok').connected, false)

  const done = await api('POST', '/api/channels/grok/oauth/commit', {
    token: ctx.boss.sessionToken,
    body: { state: ctx.start.state, models: ['grok-4.6'] },
  })
  assert.equal(done.status, 200)
  assert.equal(done.json.status, 'success')
  assert.equal(done.json.channel.connected, true)
  assert.deepEqual(done.json.channel.models, ['grok-4.6'])
  assert.ok(!JSON.stringify(done.json).includes(ACCESS))

  const list = await api('GET', '/api/channels', { token: ctx.emp.sessionToken })
  const grok = list.json.channels.find((c) => c.id === 'grok')
  assert.equal(grok.connected, true)
  assert.equal(grok.statusLabel, '已接')
  assert.ok(!JSON.stringify(list.json).includes(ACCESS))
  assert.ok(!JSON.stringify(list.json).includes(REFRESH))

  const stored = gw.channels.store.load()
  assert.equal(stored.items.grok.credential, ACCESS)
  assert.equal(stored.items.grok.refreshToken, REFRESH)
  assert.equal(stored.items.grok.oauthProvider, 'grok')
})

test('未配 Grok client_id 时仍走公开客户端设备码', async () => {
  const prevId = process.env.OAUTH_GROK_CLIENT_ID
  const prevSecret = process.env.OAUTH_GROK_CLIENT_SECRET
  delete process.env.OAUTH_GROK_CLIENT_ID
  delete process.env.OAUTH_GROK_CLIENT_SECRET
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-oauth-noconfig-'))
  const bare = createGateway({
    host: '127.0.0.1',
    port: 0,
    publicUrl: PUBLIC_URL,
    dataDir: dir,
    upstreams: { mock: { kind: 'mock', label: 'Mock', models: [{ id: 'mock-echo', name: 'Mock Echo', priceCnyPerM: { input: 0, output: 0, cachedInput: 0 } }] } },
    channels: [{ id: 'grok', label: 'Grok', kind: 'subscription', baseUrl: 'https://api.x.ai/v1', hint: 'grok-4.6' }],
    defaultModel: 'mock-echo',
    fetchReleases: async () => [],
  })
  const bareBase = await bare.listen()
  try {
    const login = await fetch(bareBase + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'boss123456', device: 'oauth-test' }),
    })
    const { sessionToken } = await login.json()
    const view = await fetch(bareBase + '/api/channels', { headers: { authorization: `Bearer ${sessionToken}` } })
    const json = await view.json()
    assert.equal(json.channels[0].oauth.available, true)
    assert.equal(json.channels[0].oauth.configured, true)
    assert.equal(json.channels[0].oauth.flow, 'device_code')
    assert.equal(json.channels[0].oauth.reason, null)
  } finally {
    await bare.close()
    fs.rmSync(dir, { recursive: true, force: true })
    if (prevId !== undefined) process.env.OAUTH_GROK_CLIENT_ID = prevId
    else delete process.env.OAUTH_GROK_CLIENT_ID
    if (prevSecret !== undefined) process.env.OAUTH_GROK_CLIENT_SECRET = prevSecret
    else delete process.env.OAUTH_GROK_CLIENT_SECRET
  }
})

test('管理页源码：订阅弹窗有登录账号，且无官方 OAuth 的通道写明仍需粘贴', async () => {
  const page = await fetch(base + '/admin')
  const html = await page.text()
  assert.match(html, /登录账号/)
  assert.match(html, /该平台无官方 OAuth，仍需粘贴令牌/)
  assert.match(html, /高级：手动粘贴/)
  assert.match(html, /about:blank/)
  assert.match(html, /如果浏览器拦截了弹窗/)
  assert.match(html, /oauth\/commit/)
  assert.match(html, /每行可改上下文、识图，点 × 去掉/)
  assert.match(html, /默认上下文（未单独填的模型）/)
  assert.match(html, /class="model-ctx"/)
  assert.match(html, /id="discover"/)
  assert.match(html, /id="modelsField"/)
  assert.match(html, /data-edit=/)
  assert.match(html, /\/api\/channels\/' \+ encodeURIComponent\([^)]+\)/)
  assert.match(html, /'PATCH'/)
})
