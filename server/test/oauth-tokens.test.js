/**
 * OAuth 令牌：从 JWT 取 ChatGPT 账号、判断是否该续期。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountIdFromToken, needsRefresh, resolveConnectBaseUrl, tokenExpiresAtMs } from '../src/oauth-tokens.js'

function fakeJwt(payload) {
  const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${h}.${p}.sig`
}

test('accountIdFromToken：读 https://api.openai.com/auth.chatgpt_account_id', () => {
  const tok = fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-9' } })
  assert.equal(accountIdFromToken(tok), 'acct-9')
  assert.equal(accountIdFromToken('not-a-jwt'), undefined)
  assert.equal(accountIdFromToken(fakeJwt({ chatgpt_account_id: 'plain' })), 'plain')
})

test('needsRefresh：有 refresh 且即将过期才续；无 refresh 不续', () => {
  const now = Date.parse('2026-09-05T02:00:00.000Z')
  assert.equal(needsRefresh({ refreshToken: 'r', tokenExpiresAt: '2026-09-05T02:01:00.000Z' }, now), true)
  assert.equal(needsRefresh({ refreshToken: 'r', tokenExpiresAt: '2026-09-05T03:00:00.000Z' }, now), false)
  assert.equal(needsRefresh({ tokenExpiresAt: '2026-09-05T02:00:00.000Z' }, now), false)
  const jwt = fakeJwt({ exp: Math.floor(now / 1000) + 30 })
  assert.equal(needsRefresh({ refreshToken: 'r', credential: jwt }, now), true)
  assert.equal(tokenExpiresAtMs({ tokenExpiresAt: '2026-09-05T02:00:00.000Z' }), now)
})

test('resolveConnectBaseUrl：ChatGPT OAuth 默认切到 Codex 后端', () => {
  const provider = { upstreamApi: 'chatgpt-codex', upstreamBaseUrl: 'https://chatgpt.com/backend-api/codex' }
  assert.equal(resolveConnectBaseUrl('', provider, 'https://api.openai.com/v1'), 'https://chatgpt.com/backend-api/codex')
  assert.equal(resolveConnectBaseUrl('https://api.openai.com/v1', provider, 'https://api.openai.com/v1'), 'https://chatgpt.com/backend-api/codex')
  assert.equal(resolveConnectBaseUrl('https://proxy.example/v1', provider, 'https://api.openai.com/v1'), 'https://proxy.example/v1')
})
