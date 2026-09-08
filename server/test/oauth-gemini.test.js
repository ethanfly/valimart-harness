import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Channels } from '../src/channels.js'
import { OAuthSubscribe, describeOAuth, resolveProviderConfig } from '../src/oauth-subscribe.js'
import { LlmProxy } from '../src/llm-proxy.js'

const defaults = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)))
const channel = defaults.channels.find((c) => c.id === 'gemini')
const user = { id: 'boss-id', username: 'boss' }
const jwt = (sub) => `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`

test('Google One 默认目录支持 OAuth，公开视图不暴露应用或账号凭据', () => {
  assert.equal(channel.kind, 'subscription')
  const desc = describeOAuth(channel, defaults)
  assert.equal(desc.configured, true)
  assert.equal(desc.flow, 'authorization_code_paste')
  assert.match(desc.pasteHint, /完整回调/)
  assert.equal(desc.clientSecret, undefined)
  const custom = resolveProviderConfig('gemini', { oauth: { gemini: { clientId: 'custom-id' } } })
  assert.equal(custom.clientSecret, undefined, '自定义 client ID 不能搭配内置应用 secret')
})

test('Google OAuth：PKCE、state 校验、接入、同账号重登、令牌续期和多账号项目隔离', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-gemini-oauth-'))
  let channels
  t.after(() => { channels?.persist.close(); fs.rmSync(tmp, { recursive: true, force: true }) })
  const cfg = { channels: [channel], upstreams: {}, oauth: { gemini: { tokenUrl: 'https://mock/token' } } }
  let subject = 'user-one', project = 'project-one', sequence = 0
  const requests = []
  const fetchImpl = async (url, opts) => {
    requests.push({ url, opts })
    if (url.endsWith('/token')) {
      const form = new URLSearchParams(opts.body)
      assert.ok(form.get('client_secret'))
      assert.equal(opts.headers.authorization, undefined)
      if (form.get('grant_type') === 'authorization_code') {
        assert.ok(form.get('code_verifier'))
        assert.equal(form.get('redirect_uri'), 'http://localhost:45289/oauth2callback')
      }
      return Response.json({ access_token: `access-${++sequence}`, refresh_token: `refresh-${sequence}`, expires_in: 3600, id_token: jwt(subject) })
    }
    assert.ok(url.endsWith(':loadCodeAssist'), '不会向不存在的 /models 请求')
    return Response.json({ currentTier: { id: 'standard-tier' }, cloudaicompanionProject: project })
  }
  channels = new Channels(cfg, tmp)
  const oauth = new OAuthSubscribe({ cfg, channels, fetchImpl })
  const connect = async () => {
    const start = await oauth.start('gemini', user)
    const auth = new URL(start.authorizeUrl)
    assert.equal(auth.origin, 'https://accounts.google.com')
    assert.equal(auth.searchParams.get('access_type'), 'offline')
    assert.equal(auth.searchParams.get('code'), null)
    assert.ok(auth.searchParams.get('code_challenge'))
    const before = requests.length
    await assert.rejects(oauth.complete('gemini', user, { state: start.state, code: 'bare-code' }), /完整回调/)
    await assert.rejects(oauth.complete('gemini', user, { state: start.state, code: 'http://localhost/?code=code&state=wrong' }), /不匹配/)
    await assert.rejects(oauth.complete('gemini', { id: 'other' }, { state: start.state, code: 'x' }), /不是你/)
    assert.equal(requests.length, before)
    const authorized = await oauth.complete('gemini', user, { state: start.state, code: `http://localhost:45289/oauth2callback?code=good&state=${start.state}` })
    assert.equal(authorized.status, 'authorized')
    assert.ok(authorized.models.some((m) => m.id === 'gemini-2.5-pro'))
    assert.equal(channels.view()[0].connected, before > 0)
    const committed = await oauth.commit('gemini', user, { state: start.state, models: ['gemini-2.5-pro'] })
    assert.equal(committed.status, 'success')
    assert.doesNotMatch(JSON.stringify(committed), /access-\d|refresh-\d/)
  }
  await connect()
  const firstId = cfg.upstreams.gemini.accounts[0].id
  assert.equal(cfg.upstreams.gemini.googleProjectId, 'project-one')
  await connect()
  assert.equal(cfg.upstreams.gemini.accounts.length, 1)
  assert.equal(cfg.upstreams.gemini.accounts[0].id, firstId)
  subject = 'user-two'; project = 'project-two'
  await connect()
  assert.equal(cfg.upstreams.gemini.accounts.length, 2)
  await oauth.ensureFresh('gemini', { force: true, accountId: firstId })
  assert.equal(cfg.upstreams.gemini.accounts[0].googleProjectId, 'project-one')
  const proxy = new LlmProxy({ cfg, channels, oauth })
  assert.equal(proxy.withAccount(cfg.upstreams.gemini, cfg.upstreams.gemini.accounts[1]).googleProjectId, 'project-two')
  const restarted = new Channels({ ...cfg, upstreams: {} }, tmp)
  assert.equal(restarted.cfg.upstreams.gemini.accounts[1].googleProjectId, 'project-two')
  assert.doesNotMatch(JSON.stringify(restarted.view()), /access-\d|refresh-\d/)
})

test('Gemini 多账号：401 续期后重试，额度耗尽才切换且使用下个账号的项目', async () => {
  const upstream = { id: 'gemini', channel: 'gemini', api: 'gemini-code-assist', accounts: [
    { id: 'one', credential: 'old-one', googleProjectId: 'p-one' },
    { id: 'two', credential: 'token-two', googleProjectId: 'p-two' },
  ] }
  const exhausted = [], seen = []
  const proxy = new LlmProxy({ cfg: { upstreams: { gemini: upstream } },
    channels: { markAccountExhausted: (_channel, id) => exhausted.push(id) },
    oauth: { ensureFresh: async (_channel, { force, accountId }) => { if (force) upstream.accounts.find((a) => a.id === accountId).credential = 'new-one' } },
  })
  proxy.sendUpstream = async (current) => {
    seen.push([current.resolvedKey, current.googleProjectId])
    if (current.resolvedKey === 'old-one') return new Response('', { status: 401 })
    if (current.resolvedKey === 'new-one') return Response.json({ error: { message: 'quota exceeded' } }, { status: 429 })
    return Response.json({ ok: true })
  }
  const res = await proxy.fetchUpstream(upstream, {}, {}, {})
  assert.equal(res.status, 200)
  assert.deepEqual(seen, [['old-one', 'p-one'], ['new-one', 'p-one'], ['token-two', 'p-two']])
  assert.deepEqual(exhausted, ['one'])
})
