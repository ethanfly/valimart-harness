/**
 * 订阅令牌过期自动续期（mock 令牌端点，不打真网）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Channels } from '../src/channels.js'
import { OAuthSubscribe } from '../src/oauth-subscribe.js'

const OLD = 'old-access-should-not-stay'
const NEW_REFRESH = 'rotated-refresh'

function fakeJwt(payload) {
  const h = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${h}.${p}.sig`
}

let mock
let mockBase
let refreshCalls = 0
let lastRefresh
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-oauth-refresh-'))

before(async () => {
  mock = http.createServer((req, res) => {
    if (req.method === 'POST' && (req.url === '/oauth/token' || req.url === '/oauth/token-json')) {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        refreshCalls += 1
        const raw = Buffer.concat(chunks).toString('utf8')
        lastRefresh = raw
        const body = req.url === '/oauth/token-json' ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))
        if (body.grant_type !== 'refresh_token' || body.refresh_token !== 'old-refresh') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid_grant' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          access_token: fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-refreshed' } }),
          refresh_token: NEW_REFRESH,
          expires_in: 3600,
        }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
  mockBase = `http://127.0.0.1:${mock.address().port}`
})

after(async () => {
  await new Promise((resolve) => mock.close(resolve))
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* Windows 偶发占用 */
  }
})

function make(channelId, tokenUrl, extraOauth = {}) {
  const cfg = {
    publicUrl: 'http://oauth-refresh.test',
    oauth: {
      [channelId]: {
        clientId: `test-${channelId}`,
        tokenUrl,
        ...extraOauth,
      },
    },
    channels: [
      { id: 'chatgpt', label: 'ChatGPT', kind: 'subscription', baseUrl: 'https://api.openai.com/v1', hint: 'gpt-5.5' },
      { id: 'claude', label: 'Claude', kind: 'subscription', baseUrl: 'https://api.anthropic.com/v1', hint: 'claude-opus-4-6' },
    ],
    upstreams: {},
  }
  const channels = new Channels(cfg, tmp)
  const oauth = new OAuthSubscribe({ cfg, channels })
  return { cfg, channels, oauth }
}

test('ensureFresh：过期则换新 access / 旋转 refresh，并写回通道', async () => {
  refreshCalls = 0
  const { channels, oauth } = make('chatgpt', `${mockBase}/oauth/token`)
  channels.connect('chatgpt', {
    credential: OLD,
    models: 'gpt-5.5',
    refreshToken: 'old-refresh',
    tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    oauthProvider: 'chatgpt',
  }, { username: 'boss' })
  const item = await oauth.ensureFresh('chatgpt')
  assert.equal(refreshCalls, 1)
  assert.match(lastRefresh, /grant_type=refresh_token/)
  assert.notEqual(item.credential, OLD)
  assert.equal(item.refreshToken, NEW_REFRESH)
  assert.equal(item.chatgptAccountId, 'acct-refreshed')
  assert.equal(channels.store.load().items.chatgpt.refreshToken, NEW_REFRESH)
  assert.ok(Date.parse(item.tokenExpiresAt) > Date.now())
})

test('ensureFresh：未过期不打令牌端点', async () => {
  const before = refreshCalls
  const { channels, oauth } = make('chatgpt', `${mockBase}/oauth/token`)
  channels.connect('chatgpt', {
    credential: OLD,
    models: 'gpt-5.5',
    refreshToken: 'old-refresh',
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }, { username: 'boss' })
  const item = await oauth.ensureFresh('chatgpt')
  assert.equal(refreshCalls, before)
  assert.equal(item.credential, OLD)
})

test('applyOne：已接入的 ChatGPT OAuth 自动切 Codex 后端', () => {
  const { channels } = make('chatgpt', `${mockBase}/oauth/token`)
  channels.connect('chatgpt', {
    credential: OLD,
    models: 'gpt-5.5',
    baseUrl: 'https://api.openai.com/v1',
    refreshToken: 'old-refresh',
    oauthProvider: 'chatgpt',
  }, { username: 'boss' })
  const up = channels.cfg.upstreams.chatgpt
  assert.equal(up.api, 'chatgpt-codex')
  assert.equal(up.baseUrl, 'https://chatgpt.com/backend-api/codex')
})

test('ensureFresh：Claude 用 JSON refresh_token', async () => {
  const { channels, oauth } = make('claude', `${mockBase}/oauth/token-json`, { tokenBody: 'json', authStyle: 'anthropic-oauth' })
  channels.connect('claude', {
    credential: OLD,
    models: 'claude-opus-4-6',
    refreshToken: 'old-refresh',
    tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    authStyle: 'anthropic-oauth',
  }, { username: 'boss' })
  await oauth.ensureFresh('claude')
  const raw = JSON.parse(lastRefresh)
  assert.equal(raw.grant_type, 'refresh_token')
  assert.equal(channels.store.load().items.claude.credential.includes('.'), true)
})
