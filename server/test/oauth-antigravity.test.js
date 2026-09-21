import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Channels } from '../src/channels.js'
import { OAuthSubscribe, describeOAuth, resolveProviderConfig } from '../src/oauth-subscribe.js'
import { usesAntigravity } from '../src/upstream-gemini.js'
import { ANTIGRAVITY_CALLBACK } from '../src/oauth-providers/antigravity.js'

const defaults = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)))
const channel = defaults.channels.find((c) => c.id === 'antigravity')
const user = { id: 'boss-id', username: 'boss' }
const jwt = (sub) => `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`

test('Antigravity 默认目录支持 OAuth，公开视图不暴露应用或账号凭据', () => {
  assert.equal(channel.kind, 'subscription')
  assert.equal(channel.api, 'antigravity')
  const desc = describeOAuth(channel, defaults)
  assert.equal(desc.configured, true)
  assert.equal(desc.flow, 'authorization_code_paste')
  assert.match(desc.pasteHint, /51121/)
  assert.match(desc.detail, /CLIProxyAPI|CPA/)
  assert.equal(desc.clientSecret, undefined)
  const custom = resolveProviderConfig('antigravity', { oauth: { antigravity: { clientId: 'custom-id' } } })
  assert.equal(custom.clientSecret, undefined, '自定义 client ID 不能搭配内置应用 secret')
})

test('Antigravity OAuth：PKCE、CPA 回调端口、不走 loadCodeAssist、接入后可对话', async (t) => {
  const prevSecret = process.env.OAUTH_ANTIGRAVITY_CLIENT_SECRET
  process.env.OAUTH_ANTIGRAVITY_CLIENT_SECRET = 'test-secret'
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-antigravity-oauth-'))
  let channels
  t.after(() => {
    if (prevSecret === undefined) delete process.env.OAUTH_ANTIGRAVITY_CLIENT_SECRET
    else process.env.OAUTH_ANTIGRAVITY_CLIENT_SECRET = prevSecret
    channels?.persist.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  const cfg = { channels: [channel], upstreams: {}, oauth: { antigravity: { tokenUrl: 'https://mock/token' } } }
  const requests = []
  const fetchImpl = async (url, opts) => {
    requests.push({ url, opts })
    if (url.endsWith('/token')) {
      const form = new URLSearchParams(opts.body)
      assert.ok(form.get('client_secret'))
      assert.ok(form.get('code_verifier'))
      assert.equal(form.get('redirect_uri'), ANTIGRAVITY_CALLBACK)
      return Response.json({ access_token: 'ag-access', refresh_token: 'ag-refresh', expires_in: 3600, id_token: jwt('google-user-1') })
    }
    if (String(url).includes('loadCodeAssist')) {
      throw new Error('Antigravity 不应调用 loadCodeAssist')
    }
    throw new Error(`unexpected ${url}`)
  }
  channels = new Channels(cfg, tmp)
  const oauth = new OAuthSubscribe({ cfg, channels, fetchImpl })
  const start = await oauth.start('antigravity', user)
  const auth = new URL(start.authorizeUrl)
  assert.equal(auth.searchParams.get('redirect_uri'), ANTIGRAVITY_CALLBACK)
  assert.match(auth.searchParams.get('scope'), /cclog/)
  assert.ok(auth.searchParams.get('code_challenge'))
  const authorized = await oauth.complete('antigravity', user, {
    state: start.state,
    code: `${ANTIGRAVITY_CALLBACK}?code=good&state=${start.state}`,
  })
  assert.equal(authorized.status, 'authorized')
  assert.ok(authorized.models.some((m) => m.id === 'gemini-3.5-flash'))
  assert.equal(requests.some((r) => String(r.url).includes('loadCodeAssist')), false)
  const committed = await oauth.commit('antigravity', user, { state: start.state, models: ['gemini-3.5-flash'] })
  assert.equal(committed.status, 'success')
  assert.equal(cfg.upstreams.antigravity.api, 'antigravity')
  assert.equal(usesAntigravity(cfg.upstreams.antigravity), true)
  assert.equal(cfg.upstreams.antigravity.googleProjectId, undefined)
  assert.equal(cfg.upstreams.antigravity.resolvedKey, 'ag-access')
})
