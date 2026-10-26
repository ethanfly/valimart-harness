/**
 * 管理页 → 模型 → 语音（node --test）。
 *
 * - 权限：员工 403、总监可读不可写、管理员可写；视图永远不回显 API Key。
 * - 校验：端点 / 密钥 / 模型名（multipart 头注入）/ 数值范围；首次保存必须填密钥。
 * - 生效：保存后设备侧 /v1/audio/config 与 /v1/audio/speech 立刻改用管理页端点（不重启），
 *   账本 provider 记 voice-admin；换端点不填密钥一律拒绝（不把旧密钥发到新地址）。
 * - 清除：DELETE 回退到 config.voice。
 * - 测试：真实 TTS → ASR 往返；失败固定 200 + 阶段/稳定错误码，不透传上游原文（可能含密钥）。
 *
 * 全程本机 HTTP stub 上游，不访问外网、不调用付费服务。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../src/index.js'
import { pcmToWav } from '../src/audio-proxy.js'

const tmpDirs = []
const mkTmp = (name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name))
  tmpDirs.push(dir)
  return dir
}

const mockUpstream = {
  kind: 'mock',
  label: 'Mock',
  models: [{ id: 'mock-echo', name: 'Mock Echo', priceCnyPerM: { input: 1, output: 2, cachedInput: 0.1 } }],
}

// ---------- 本地 HTTP stub 语音上游 ----------
const calls = []
let stubHandler = null
const stub = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    calls.push({ url: req.url, method: req.method, headers: req.headers, body })
    Promise.resolve(stubHandler(req, res, body)).then(
      ({ status, headers, body: out }) => {
        if (res.destroyed) return
        res.writeHead(status, headers)
        res.end(out)
      },
      () => {
        /* handler 自己管连接 */
      },
    )
  })
})
const jsonOut = (status, payload) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
const wavOut = (status, buf) => ({ status, headers: { 'content-type': 'audio/wav' }, body: buf })
const serveUpstream = (req, res, body) => {
  if (req.url.endsWith('/audio/transcriptions')) return jsonOut(200, { text: '管理页往返测试通过' })
  if (req.url.endsWith('/audio/speech')) return wavOut(200, toneWav(24000, 300))
  return jsonOut(404, { error: { message: 'stub 404' } })
}

function toneWav(rate, ms) {
  const samples = Math.round((rate * ms) / 1000)
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2)
  return pcmToWav(pcm, rate, 1)
}

let stubBase
let gw
let base
const tok = {}

before(async () => {
  stubBase = await new Promise((resolve) => {
    stub.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${stub.address().port}/v1`))
  })
  stubHandler = serveUpstream
  gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: mkTmp('desk-voice-admin-'),
    upstreams: {
      mock: mockUpstream,
      speech: { kind: 'openai-compatible', label: 'Speech Stub', baseUrl: stubBase, apiKey: 'sk-config-key', models: [] },
    },
    defaultModel: 'mock-echo',
    voice: { provider: 'speech', asrModel: 'cfg-asr', ttsModel: 'cfg-tts', voice: 'cfg-voice', ttsRate: 22050 },
    quota: { anchor: '2026-08-31T17:45:21+08:00', weeklyCny: 100, byRole: { admin: 1000, employee: 100 } },
    fetchReleases: async () => [],
    fetchModels: async () => new Response(JSON.stringify({ error: 'no' }), { status: 404 }),
  })
  base = await gw.listen()
  const loginAs = async (username, password) => {
    const r = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, device: 'voice-admin-test' }),
    })
    const json = await r.json()
    assert.equal(r.status, 200, `login ${username}: ${JSON.stringify(json)}`)
    return json
  }
  tok.boss = (await loginAs('boss', 'boss123456')).sessionToken
  tok.director = (await loginAs('director', 'director123')).sessionToken
  const emp = await loginAs('emp-a', 'emp123456')
  tok.emp = emp.sessionToken
  tok.empDevice = emp.gatewayToken
})

after(async () => {
  await gw.close()
  await new Promise((r) => stub.close(r))
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
})

async function call(method, p, { t = tok.boss, body } = {}) {
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
  return { status: r.status, headers: r.headers, json }
}

async function speechDevice(input = '你好') {
  return fetch(base + '/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${tok.empDevice}`, 'content-type': 'application/json' },
    body: JSON.stringify({ input, format: 'pcm' }),
  })
}

test('权限：员工 403；总监可读不可写；视图不含密钥', async () => {
  assert.equal((await call('GET', '/api/admin/voice', { t: tok.emp })).status, 403)
  assert.equal((await call('PUT', '/api/admin/voice', { t: tok.emp, body: { baseUrl: stubBase, apiKey: 'sk-hack' } })).status, 403)

  const view = await call('GET', '/api/admin/voice', { t: tok.director })
  assert.equal(view.status, 200)
  const v = view.json.voice
  assert.equal(v.available, true)
  assert.equal(v.mock, false)
  assert.equal(v.source, 'config')
  assert.equal(v.sourceLabel, '服务端配置 / 环境变量')
  assert.equal(v.endpoint, stubBase)
  assert.equal(v.keyConfigured, true)
  assert.equal(v.asrModel, 'cfg-asr')
  assert.equal(v.ttsRate, 22050)
  assert.equal(v.adminSet, false)
  assert.doesNotMatch(JSON.stringify(view.json), /sk-config-key/)

  assert.equal((await call('PUT', '/api/admin/voice', { t: tok.director, body: { baseUrl: stubBase, apiKey: 'sk-dir' } })).status, 403)
})

test('校验：端点/密钥/模型名/数值非法一律 400，且不落库', async () => {
  const bads = [
    [{ baseUrl: 'ftp://example.test/v1', apiKey: 'sk-1' }, 'bad_base_url'],
    [{ baseUrl: 'https://example.test/v1?q=1', apiKey: 'sk-1' }, 'bad_base_url'],
    [{ baseUrl: 'https://user:pw@example.test/v1', apiKey: 'sk-1' }, 'bad_base_url'],
    [{ baseUrl: 'not a url', apiKey: 'sk-1' }, 'bad_base_url'],
    [{ baseUrl: stubBase, apiKey: 'sk with space' }, 'bad_key'],
    [{ baseUrl: stubBase, apiKey: 'sk-ok', ttsModel: 'a"b' }, 'bad_field'],
    [{ baseUrl: stubBase, apiKey: 'sk-ok', asrModel: 'a\r\n--x' }, 'bad_field'],
    [{ baseUrl: stubBase, apiKey: 'sk-ok', ttsRate: 100 }, 'bad_field'],
    [{ baseUrl: stubBase, apiKey: 'sk-ok', ttsRate: 24000.5 }, 'bad_field'],
    [{ baseUrl: stubBase, apiKey: 'sk-ok', ttsPriceCnyPerMinute: -1 }, 'bad_field'],
    // 首次保存必须填密钥：不能把 config 里的旧密钥自动带过来。
    [{ baseUrl: stubBase }, 'need_api_key'],
  ]
  for (const [body, code] of bads) {
    const r = await call('PUT', '/api/admin/voice', { t: tok.boss, body })
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.equal(r.json.error?.code, code, JSON.stringify(body))
  }
  const view = await call('GET', '/api/admin/voice')
  assert.equal(view.json.voice.adminSet, false)
  assert.equal(view.json.voice.source, 'config')
})

test('保存：立即覆盖 config（不重启），账本 provider=voice-admin，响应不回显密钥', async () => {
  calls.length = 0
  const saved = await call('PUT', '/api/admin/voice', {
    body: {
      baseUrl: stubBase,
      apiKey: 'sk-admin-page-key',
      asrModel: 'admin-asr',
      ttsModel: 'admin-tts',
      voice: 'admin-voice',
      ttsRate: 16000,
      asrPriceCnyPerMinute: 3,
      ttsPriceCnyPerMinute: 6,
    },
  })
  assert.equal(saved.status, 200)
  const v = saved.json.voice
  assert.equal(v.available, true)
  assert.equal(v.adminSet, true)
  assert.equal(v.source, 'admin-page')
  assert.equal(v.sourceLabel, '管理页设置')
  assert.equal(v.endpoint, stubBase)
  assert.equal(v.keyConfigured, true)
  assert.equal(v.asrModel, 'admin-asr')
  assert.equal(v.ttsModel, 'admin-tts')
  assert.equal(v.voice, 'admin-voice')
  assert.equal(v.ttsRate, 16000)
  assert.equal(v.asrPriceCnyPerMinute, 3)
  assert.equal(v.ttsPriceCnyPerMinute, 6)
  assert.doesNotMatch(JSON.stringify(saved.json), /sk-admin-page-key/)
  assert.doesNotMatch(JSON.stringify(saved.json), /sk-config-key/)

  // 设备侧配置立即生效
  const devCfg = await call('GET', '/v1/audio/config', { t: tok.empDevice })
  assert.equal(devCfg.status, 200)
  assert.equal(devCfg.json.available, true)
  assert.equal(devCfg.json.mock, false)
  assert.equal(devCfg.json.asrModel, 'admin-asr')
  assert.equal(devCfg.json.ttsModel, 'admin-tts')
  assert.equal(devCfg.json.ttsRate, 16000)
  assert.doesNotMatch(JSON.stringify(devCfg.json), /sk-/)

  // 合成走管理页端点 + 管理页密钥 + 管理页模型
  const speech = await speechDevice('管理页测试')
  assert.equal(speech.status, 200)
  assert.equal(speech.headers.get('x-audio-rate'), '24000', '采样率以管理页通道上游回包为准')
  const speechCall = calls.filter((c) => c.url.endsWith('/audio/speech')).at(-1)
  assert.equal(speechCall.headers.authorization, 'Bearer sk-admin-page-key')
  assert.equal(JSON.parse(speechCall.body).model, 'admin-tts')
  assert.equal(JSON.parse(speechCall.body).voice, 'admin-voice')

  const entry = gw.ledger.entriesSince(0, (e) => e.tag === 'voice-tts').at(-1)
  assert.equal(entry.provider, 'voice-admin')
  assert.equal(entry.priceKnown, true)
  assert.ok(entry.costCny > 0, '配了价目就要如实计费')
})

test('密钥沿用：同端点留空保留旧 key；换端点留空必须重填', async () => {
  // 同端点 + 空 key：沿用已保存的 key
  const same = await call('PUT', '/api/admin/voice', { body: { baseUrl: `${stubBase}/`, apiKey: '', ttsRate: 22050 } })
  assert.equal(same.status, 200)
  assert.equal(same.json.voice.keyConfigured, true)
  assert.equal(same.json.voice.ttsRate, 22050)
  assert.doesNotMatch(JSON.stringify(same.json), /sk-admin-page-key/)

  calls.length = 0
  const speech = await speechDevice()
  assert.equal(speech.status, 200)
  assert.equal(calls.at(-1).headers.authorization, 'Bearer sk-admin-page-key', '同端点留空保存应保留旧密钥')

  // 换端点 + 空 key：拒绝，避免把旧密钥发到新地址
  const other = await call('PUT', '/api/admin/voice', { body: { baseUrl: 'https://voice.example.test/v1', apiKey: '' } })
  assert.equal(other.status, 400)
  assert.equal(other.json.error.code, 'need_api_key')
  const view = await call('GET', '/api/admin/voice')
  assert.equal(view.json.voice.endpoint, stubBase, '被拒绝的保存不能改掉现有端点')

  // 换端点 + 新 key：允许
  const moved = await call('PUT', '/api/admin/voice', { body: { baseUrl: 'https://voice.example.test/v1', apiKey: 'sk-new-place' } })
  assert.equal(moved.status, 200)
  assert.equal(moved.json.voice.endpoint, 'https://voice.example.test/v1')
  // 换回来，后面的用例继续用本机 stub
  const back = await call('PUT', '/api/admin/voice', { body: { baseUrl: stubBase, apiKey: 'sk-admin-page-key', ttsRate: 16000 } })
  assert.equal(back.status, 200)
})

test('测试连通：真实 TTS→ASR 往返；失败只回阶段和稳定错误码，不透传上游原文', async () => {
  calls.length = 0
  const ok = await call('POST', '/api/admin/voice/test', {
    body: {
      baseUrl: stubBase,
      apiKey: '', // 与已保存端点一致 → 沿用已保存密钥
      asrModel: 'admin-asr',
      ttsModel: 'admin-tts',
      voice: 'admin-voice',
    },
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.mock, false)
  assert.equal(ok.json.tts.rate, 24000)
  assert.equal(ok.json.asr.text, '管理页往返测试通过')
  assert.ok(ok.json.tts.latencyMs >= 0 && ok.json.asr.latencyMs >= 0)
  assert.doesNotMatch(JSON.stringify(ok.json), /sk-admin-page-key/)
  const asrCall = calls.filter((c) => c.url.endsWith('/audio/transcriptions')).at(-1)
  assert.equal(asrCall.headers.authorization, 'Bearer sk-admin-page-key')
  assert.match(asrCall.headers['content-type'], /multipart\/form-data/)
  assert.match(asrCall.body.toString('latin1'), /name="model"\r\n\r\nadmin-asr\r\n/)
  // 测试调用也记账，但用独立的 tag，不与真实设备请求混在一起
  const testEntry = gw.ledger.entriesSince(0, (e) => e.tag === 'voice-test').at(-1)
  assert.ok(testEntry, '测试调用要记账')
  assert.equal(testEntry.provider, 'voice-admin')

  // 上游把密钥片段回显在错误体里：网关必须丢弃
  stubHandler = () => ({ status: 401, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { message: 'bad key sk-admin-page-key leaked' } }) })
  const failed = await call('POST', '/api/admin/voice/test', { body: { baseUrl: stubBase, apiKey: '', ttsModel: 'admin-tts' } })
  assert.equal(failed.status, 200)
  assert.equal(failed.json.ok, false)
  assert.equal(failed.json.error.stage, 'tts')
  assert.equal(failed.json.error.code, 'upstream_error')
  assert.doesNotMatch(JSON.stringify(failed.json), /sk-admin-page-key/)
  assert.doesNotMatch(JSON.stringify(failed.json), /leaked/)

  // 表单填了非法端点：明确 400，而不是悄悄去测当前生效的通道
  const rejected = await call('POST', '/api/admin/voice/test', { body: { baseUrl: 'ftp://x/v1', apiKey: 'sk-x' } })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.json.error.code, 'bad_base_url')

  stubHandler = serveUpstream
})

test('清除：回退到 config.voice，设备侧立刻回到配置通道', async () => {
  const cleared = await call('DELETE', '/api/admin/voice')
  assert.equal(cleared.status, 200)
  const v = cleared.json.voice
  assert.equal(v.adminSet, false)
  assert.equal(v.source, 'config')
  assert.equal(v.available, true)
  assert.equal(v.asrModel, 'cfg-asr')
  assert.equal(v.ttsRate, 22050)

  calls.length = 0
  const speech = await speechDevice()
  assert.equal(speech.status, 200)
  assert.equal(calls.at(-1).headers.authorization, 'Bearer sk-config-key', '清除后必须回到配置通道的密钥')
  assert.equal(JSON.parse(calls.at(-1).body).model, 'cfg-tts')
  const entry = gw.ledger.entriesSince(0, (e) => e.tag === 'voice-tts').at(-1)
  assert.equal(entry.provider, 'speech')
})

test('管理页 HTML：模型页有「语音」子标签，含保存/测试/清除入口', async () => {
  const r = await fetch(base + '/admin')
  const html = await r.text()
  assert.equal(r.status, 200)
  assert.match(html, /data-tab="voice"/)
  assert.match(html, /id="voicekey"/)
  assert.match(html, /id="voiceForm"/)
  assert.match(html, /\/api\/admin\/voice\/test/)
  assert.match(html, /语音通道/)
})
