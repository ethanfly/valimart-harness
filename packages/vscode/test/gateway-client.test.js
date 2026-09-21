import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TokenStore, catalogModelId, isForbiddenKey } from '../src/lib/token-store.js'
import { GatewayClient, GatewayError, DEFAULT_CHAT_TIMEOUT_MS } from '../src/lib/gateway-client.js'
import { summarizeQuota } from '../src/lib/quota.js'
import { startCompanyDeskGateway } from './helpers/start-gateway.js'

function usedPctOr(row) {
  const s = summarizeQuota([row])[0]
  return s.usedPct
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-state-'))
let gw
let store
let client

before(async () => {
  gw = await startCompanyDeskGateway()
  store = new TokenStore(stateDir)
  client = new GatewayClient(store)
})

after(async () => {
  await gw.close()
  fs.rmSync(stateDir, { recursive: true, force: true })
})

function assertNoUpstreamKeys(value, trail = '') {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUpstreamKeys(v, `${trail}[${i}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [k, v] of Object.entries(value)) {
    assert.equal(isForbiddenKey(k), false, `forbidden key ${trail}.${k}`)
    assertNoUpstreamKeys(v, `${trail}.${k}`)
  }
}

test('login 200 returns sessionToken + gatewayToken; company.models catalog', async () => {
  const login = await client.login({
    gatewayUrl: gw.baseUrl,
    username: gw.credentials.username,
    password: gw.credentials.password,
    device: 'test-vscode',
  })
  assert.equal(typeof login.sessionToken, 'string')
  assert.ok(login.sessionToken.length > 0)
  assert.equal(typeof login.gatewayToken, 'string')
  assert.ok(login.gatewayToken.length > 0)
  assert.ok(login.user)
  assert.ok(Array.isArray(login.company?.models))
  assert.ok(login.company.models.some((m) => m.id === 'mock-echo'))
  assert.equal(store.data.sessionToken, login.sessionToken)
  assert.equal(store.data.gatewayToken, login.gatewayToken)
})

test('me 200 for that session; quota remaining/used/limit; /v1/models lists catalog id; chat returns assistant content', async () => {
  const me = await client.me()
  assert.ok(me.user)
  assert.equal(me.user.username, gw.credentials.username)
  const quota = me.quota ?? store.data.quota
  assert.ok(Array.isArray(quota) && quota.length > 0, 'quota is a provider list')
  const row = quota[0]
  assert.ok('usedPct' in row || 'remainingPct' in row || 'usedCny' in row || 'limitCny' in row)
  const summarized = summarizeQuota([row])[0]
  assert.equal(typeof usedPctOr(row), 'number')
  assert.ok(summarized.limit != null)
  assert.ok(summarized.used != null)
  assert.ok(summarized.remaining != null)

  const models = await client.listModels()
  assert.ok(models.data.some((m) => m.id === 'mock-echo'))

  const model = catalogModelId(store.data.company)
  const chat = await client.chatCompletions({
    model,
    messages: [{ role: 'user', content: 'ping from vscode client' }],
  })
  const content = chat.choices?.[0]?.message?.content
  assert.equal(typeof content, 'string')
  assert.ok(content.length > 0)
})

test('wrong password is non-200', async () => {
  const isolated = new TokenStore(fs.mkdtempSync(path.join(os.tmpdir(), 'vh-bad-')))
  const other = new GatewayClient(isolated)
  await assert.rejects(
    () =>
      other.login({
        gatewayUrl: gw.baseUrl,
        username: gw.credentials.username,
        password: 'definitely-wrong-password',
        device: 'test-vscode',
      }),
    (err) => {
      assert.ok(err instanceof GatewayError)
      assert.notEqual(err.status, 200)
      assert.ok(err.status === 401 || err.status === 403)
      return true
    },
  )
})

test('persisted state has the two tokens and no upstream API key fields', async () => {
  const raw = JSON.parse(fs.readFileSync(store.file, 'utf8'))
  assert.ok(raw.sessionToken)
  assert.ok(raw.gatewayToken)
  assertNoUpstreamKeys(raw)
  const extra = {
    apiKey: 'sk-should-not-persist',
    OPENAI_API_KEY: 'sk-openai',
    ANTHROPIC_API_KEY: 'sk-ant',
    models: [{ id: 'mock-echo', apiKey: 'nested' }],
  }
  store.setLogin({
    gatewayUrl: store.data.gatewayUrl,
    sessionToken: store.data.sessionToken,
    gatewayToken: store.data.gatewayToken,
    user: store.data.user,
    company: extra,
    quota: store.data.quota,
  })
  const saved = JSON.parse(fs.readFileSync(store.file, 'utf8'))
  assert.ok(saved.sessionToken)
  assert.ok(saved.gatewayToken)
  assertNoUpstreamKeys(saved)
  assert.equal(saved.company.apiKey, undefined)
  assert.equal(saved.company.OPENAI_API_KEY, undefined)
})

test('超时给出中文提示：响应头前、以及 body 流中途 abort', async () => {
  const isolated = new TokenStore(fs.mkdtempSync(path.join(os.tmpdir(), 'vh-to-')))
  isolated.setLogin({ gatewayUrl: 'http://127.0.0.1:9', sessionToken: 's', gatewayToken: 'g', user: {}, company: {} })

  const never = new GatewayClient(isolated, {
    fetchImpl: (_url, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })))
      }),
  })
  await assert.rejects(() => never.chatCompletions({ model: 'm', messages: [] }, { timeoutMs: 30 }), (err) => {
    assert.ok(err instanceof GatewayError)
    assert.equal(err.code, 'timeout')
    assert.match(err.message, /超时/)
    return true
  })

  const halfBody = new GatewayClient(isolated, {
    fetchImpl: async (_url, opts) =>
      new Response(
        new ReadableStream({
          start(controller) {
            opts.signal.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })))
          },
        }),
        { status: 200 },
      ),
  })
  await assert.rejects(() => halfBody.chatCompletions({ model: 'm', messages: [] }, { timeoutMs: 30 }), (err) => {
    assert.equal(err.code, 'timeout')
    assert.match(err.message, /等待响应超时/)
    return true
  })
})

test('agent 轮次的默认超时比 /api/* 宽松得多', async () => {
  const isolated = new TokenStore(fs.mkdtempSync(path.join(os.tmpdir(), 'vh-tm-')))
  isolated.setLogin({ gatewayUrl: 'http://127.0.0.1:9', sessionToken: 's', gatewayToken: 'g', user: {}, company: {} })
  let signal = null
  const probe = new GatewayClient(isolated, {
    fetchImpl: (_url, opts) => {
      signal = opts.signal
      return new Promise((_r, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    },
  })
  assert.ok(DEFAULT_CHAT_TIMEOUT_MS >= 240_000, '工具轮 + 思考型模型 2 分钟不够，默认必须更长')
  await probe.chatCompletions({ model: 'm', messages: [] }, { timeoutMs: 40 }).catch(() => {})
  assert.equal(signal?.aborted, true, '显式短超时要能掐断请求')
})

test('logout clears local tokens', async () => {
  await client.logout()
  assert.equal(store.data.sessionToken, null)
  assert.equal(store.data.gatewayToken, null)
  const saved = JSON.parse(fs.readFileSync(store.file, 'utf8'))
  assert.equal(saved.sessionToken, null)
  assert.equal(saved.gatewayToken, null)
})
