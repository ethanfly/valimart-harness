/**
 * ChatGPT Codex 上游：/v1/chat/completions 改写为 /responses，过期先续期（不打公网）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../src/index.js'

const STALE = 'stale-chatgpt-access'
const FRESH = 'fresh-chatgpt-access'
let fake
let fakeUrl
let last
let refreshCalls = 0
let gw
let base
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-codex-'))

function writeSse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: {"type":"response.output_text.delta","delta":"codex-ok"}\n\n')
  res.write('data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2}}}\n\n')
  res.end()
}

before(async () => {
  fake = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/oauth/token') {
        refreshCalls += 1
        const params = new URLSearchParams(raw)
        if (params.get('grant_type') !== 'refresh_token' || params.get('refresh_token') !== 'old-refresh') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid_grant' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ access_token: FRESH, refresh_token: 'new-refresh', expires_in: 3600 }))
        return
      }
      last = { url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : {} }
      if (req.url !== '/backend-api/codex/responses') {
        res.writeHead(404)
        res.end('no')
        return
      }
      if (req.headers.authorization !== `Bearer ${FRESH}`) {
        res.writeHead(401)
        res.end(JSON.stringify({ error: 'expired' }))
        return
      }
      writeSse(res)
    })
  })
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
  fakeUrl = `http://127.0.0.1:${fake.address().port}`
  const codexBase = `${fakeUrl}/backend-api/codex`
  gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: tmp,
    seedUsers: [],
    upstreams: {},
    channels: [{ id: 'chatgpt', label: 'ChatGPT', kind: 'subscription', baseUrl: 'https://api.openai.com/v1', hint: 'gpt-5.5' }],
    oauth: {
      chatgpt: {
        clientId: 'test-chatgpt',
        tokenUrl: `${fakeUrl}/oauth/token`,
        upstreamApi: 'chatgpt-codex',
        upstreamBaseUrl: codexBase,
      },
    },
    defaultModel: 'gpt-5.5',
    quickInference: { defaultModel: 'gpt-5.5' },
    fetchReleases: async () => [],
  })
  base = await gw.listen()
  gw.channels.connect('chatgpt', {
    credential: STALE,
    models: 'gpt-5.5',
    baseUrl: codexBase,
    refreshToken: 'old-refresh',
    tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    api: 'chatgpt-codex',
    chatgptAccountId: 'acct-1',
    oauthProvider: 'chatgpt',
  }, { username: 'boss' })
})

after(async () => {
  await gw.close()
  await new Promise((resolve) => fake.close(resolve))
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* Windows 偶发占用 */
  }
})

async function login() {
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'boss123456', device: 'test' }),
  })
  return (await r.json()).gatewayToken
}

test('Codex：过期先续期，再打 /responses；非流式回 OpenAI 形状', async () => {
  const token = await login()
  refreshCalls = 0
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.5',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      stream: false,
      temperature: 0.2,
    }),
  })
  assert.equal(r.status, 200)
  const json = await r.json()
  assert.equal(json.choices[0].message.content, 'codex-ok')
  assert.equal(json.usage.prompt_tokens, 4)
  assert.ok(refreshCalls >= 1)
  assert.equal(last.url, '/backend-api/codex/responses')
  assert.equal(last.headers.authorization, `Bearer ${FRESH}`)
  assert.equal(last.headers['chatgpt-account-id'], 'acct-1')
  assert.equal(last.headers.originator, 'codex_cli_rs')
  assert.equal(last.body.stream, true)
  assert.equal(last.body.temperature, undefined)
  assert.equal(last.body.instructions, 'sys')
  assert.equal(gw.channels.store.load().items.chatgpt.credential, FRESH)
})

test('Codex：流式事件转成 OpenAI chunk', async () => {
  const token = await login()
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  })
  assert.equal(r.status, 200)
  const text = await r.text()
  assert.match(text, /codex-ok/)
  assert.match(text, /data: \[DONE\]/)
  assert.equal(last.body.stream, true)
})
