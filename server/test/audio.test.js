/**
 * 语音端点与设备端知识检索（node --test）。
 *
 * - 网关 A：mock 语音通道 —— 验证设备拿到的 PCM 是真实可播放的波形而不是空包，
 *   且 mock 是显式标记（config.mock + x-audio-mock），不会被当成真语音。
 * - 网关 B/C/P：provider 指向本机真实 HTTP stub 上游（不是 fetch 注入）——
 *   验证请求打包（multipart + WAV 头）、回包剥壳、上游错误/重定向/超时/超大响应、
 *   客户端断连取消，以及可配置语音价目的记账。
 * - 网关 R/D：停用/吊销账号、未配置密钥通道的「明确不可用」。
 * - 知识检索：网关令牌 + limit + 用户权限隔离。
 * 全程不访问外网、不调用付费服务。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../src/index.js'
import { pcmToWav, splitWav } from '../src/audio-proxy.js'

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
const stubCalls = []
let stubHandler = null
const stub = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    stubCalls.push({ url: req.url, method: req.method, headers: req.headers, body })
    Promise.resolve(stubHandler(req, res, body)).then(
      ({ status, headers, body: out }) => {
        if (res.destroyed) return // 设备/网关已断开（如取消用例），迟到的回包没有去处
        res.writeHead(status, headers)
        res.end(out)
      },
      () => {
        /* handler 自己管连接（如断连用例） */
      },
    )
  })
})
const setStub = (fn) => {
  stubHandler = fn
}
const jsonOut = (status, payload) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(20)
  }
  return false
}

/** 造一个测试用 WAV（支持非 16-bit / 非单声道 / 非 PCM 编码标签，用于格式校验用例）。 */
function makeWav({ rate = 22050, channels = 1, bits = 16, frames = 8, fmtTag = 1 } = {}) {
  const bytesPer = bits >> 3 || 1
  const data = Buffer.alloc(frames * channels * bytesPer)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(fmtTag, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * channels * bytesPer, 28)
  header.writeUInt16LE(channels * bytesPer, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** 测试端简易 multipart 解析：[{ head, data }]。 */
function multipartParts(contentType, body) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const delim = Buffer.from(`--${(m[1] ?? m[2]).trim()}`)
  const parts = []
  let at = body.indexOf(delim)
  while (at !== -1) {
    const headStart = at + delim.length
    if (body.slice(headStart, headStart + 2).toString() === '--') break
    const headEnd = body.indexOf('\r\n\r\n', headStart)
    const next = body.indexOf(delim, headEnd)
    parts.push({ head: body.slice(headStart + 2, headEnd).toString('utf8'), data: body.slice(headEnd + 4, next - 2) })
    at = next
  }
  return parts
}

/** 设备侧行为：不发 Content-Length，边录边发（chunked）。 */
function postChunked(base, p, token, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p)
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/pcm' } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          let json
          try {
            json = JSON.parse(buf.toString('utf8'))
          } catch {
            json = { text: buf.toString('utf8') }
          }
          resolve({ status: res.statusCode, headers: res.headers, buf, json })
        })
      },
    )
    req.on('error', reject)
    if (payload.length) req.write(payload)
    req.end()
  })
}

// ---------- 网关实例 ----------
let stubBase
let gwA, gwB, gwC, gwP, gwR, gwD
let baseA, baseB, baseC, baseP, baseR, baseD
const ctx = {}

before(async () => {
  stubBase = await new Promise((resolve) => {
    stub.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${stub.address().port}/v1`))
  })
  setStub((req, res, body) => {
    if (req.url.endsWith('/audio/transcriptions')) return jsonOut(200, { text: '上游识别结果' })
    if (req.url.endsWith('/audio/speech')) {
      const pcm = Buffer.alloc(200 * 2)
      for (let i = 0; i < 200; i++) pcm.writeInt16LE(i * 10, i * 2)
      // 上游给 22050 Hz 单声道：网关必须原样告诉设备，而不是回配置里的 24000。
      return { status: 200, headers: { 'content-type': 'audio/wav' }, body: pcmToWav(pcm, 22050, 1) }
    }
    return jsonOut(404, { error: { message: 'stub 404' } })
  })

  // loadConfig 会原地解析/删除上游的密钥字段：每个网关必须拿到独立的对象，
  // 否则第一个网关 resolve 之后，后面的网关会把同一对象的 resolvedKey 冲掉。
  const speechUpstream = () => ({ kind: 'openai-compatible', label: 'Speech Stub', baseUrl: stubBase, apiKey: 'sk-stub-key', models: [] })
  const voice = (extra = {}) => ({ provider: 'speech', asrModel: 'asr-test', ttsModel: 'tts-test', voice: 'v-test', ttsRate: 24000, ...extra })

  gwA = createGateway({
    host: '127.0.0.1', port: 0, dataDir: mkTmp('desk-audio-mock-'),
    upstreams: { mock: mockUpstream },
    defaultModel: 'mock-echo',
    quickInference: { defaultModel: 'mock-echo' },
    voice: { provider: 'mock', asrModel: 'mock-asr', ttsModel: 'mock-tts', ttsRate: 16000 },
  })
  baseA = await gwA.listen()

  gwB = createGateway({
    host: '127.0.0.1', port: 0, dataDir: mkTmp('desk-audio-up-'),
    upstreams: { mock: mockUpstream, speech: speechUpstream() },
    defaultModel: 'mock-echo',
    voice: voice(),
  })
  baseB = await gwB.listen()

  // 限额/超时参数打到最小档，专门测超时与超大回包。
  gwC = createGateway({
    host: '127.0.0.1', port: 0, dataDir: mkTmp('desk-audio-limits-'),
    upstreams: { mock: mockUpstream, speech: speechUpstream() },
    defaultModel: 'mock-echo',
    voice: voice({ timeoutMs: 1000, maxTtsBytes: 1024 }),
  })
  baseC = await gwC.listen()

  // 可配置语音价目：识别 6 元/分钟、合成 12 元/分钟。
  gwP = createGateway({
    host: '127.0.0.1', port: 0, dataDir: mkTmp('desk-audio-price-'),
    upstreams: { mock: mockUpstream, speech: speechUpstream() },
    defaultModel: 'mock-echo',
    voice: voice({ asrPriceCnyPerMinute: 6, ttsPriceCnyPerMinute: 12 }),
  })
  baseP = await gwP.listen()

  // 指到没有密钥的通道：可用性必须是显式的 false，请求直接 503。
  gwD = createGateway({
    host: '127.0.0.1', port: 0, dataDir: mkTmp('desk-audio-nokey-'),
    upstreams: { mock: mockUpstream, nul: { kind: 'openai-compatible', label: 'NoKey', baseUrl: 'https://nul.test/v1', models: [] } },
    defaultModel: 'mock-echo',
    voice: { provider: 'nul' },
  })
  baseD = await gwD.listen()

  // 停用/吊销专用。
  gwR = createGateway({
    host: '127.0.0.1', port: 0, dataDir: mkTmp('desk-audio-revoke-'),
    upstreams: { mock: mockUpstream },
    defaultModel: 'mock-echo',
    voice: { provider: 'mock' },
  })
  baseR = await gwR.listen()
})

after(async () => {
  await Promise.all([gwA, gwB, gwC, gwP, gwR, gwD].map((gw) => gw.close()))
  await new Promise((r) => stub.close(r))
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
})

async function api(base, method, p, { token, body, headers = {} } = {}) {
  const r = await fetch(base + p, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body instanceof Buffer ? headers : body !== undefined ? { 'content-type': 'application/json' } : headers),
      ...headers,
    },
    body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body),
  })
  const buf = Buffer.from(await r.arrayBuffer())
  const text = buf.toString('utf8')
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { text }
  }
  return { status: r.status, headers: r.headers, buf, json }
}

async function login(base, username, password) {
  const r = await api(base, 'POST', '/api/auth/login', { body: { username, password, device: 'audio-test' } })
  assert.equal(r.status, 200, `login ${username}: ${r.status}`)
  return r.json
}

test('登录：拿到网关令牌（设备只需要保存这一个）', async () => {
  ctx.emp = await login(baseA, 'emp-a', 'emp123456')
  ctx.empB = await login(baseB, 'emp-a', 'emp123456')
  ctx.empC = await login(baseC, 'emp-a', 'emp123456')
  ctx.empP = await login(baseP, 'emp-a', 'emp123456')
  assert.match(ctx.emp.gatewayToken, /^dgw_/)
  assert.ok(ctx.emp.sessionToken)
})

test('语音配置：无令牌/会话令牌都 401；mock 标记显式、无密钥泄漏', async () => {
  const anon = await api(baseA, 'GET', '/v1/audio/config')
  assert.equal(anon.status, 401)
  const sessionOnly = await api(baseA, 'GET', '/v1/audio/config', { token: ctx.emp.sessionToken })
  assert.equal(sessionOnly.status, 401)

  const mockCfg = await api(baseA, 'GET', '/v1/audio/config', { token: ctx.emp.gatewayToken })
  assert.equal(mockCfg.status, 200)
  assert.equal(mockCfg.json.available, true)
  assert.equal(mockCfg.json.mock, true, 'mock 通道必须显式告诉设备这是演示')
  assert.equal(mockCfg.json.ttsRate, 16000)
  assert.equal(mockCfg.json.ttsChannels, 1)
  assert.equal(mockCfg.json.ttsBits, 16)

  const realCfg = await api(baseB, 'GET', '/v1/audio/config', { token: ctx.empB.gatewayToken })
  assert.equal(realCfg.status, 200)
  assert.equal(realCfg.json.available, true)
  assert.equal(realCfg.json.mock, false, '真通道不许带 mock 标记')
  assert.ok(!JSON.stringify(realCfg.json).includes('sk-'), 'config 不能泄漏任何密钥')

  // 指到没配密钥的通道：显式不可用，而不是含糊的真值。
  const noKey = await api(baseD, 'GET', '/v1/audio/config', { token: (await login(baseD, 'emp-a', 'emp123456')).gatewayToken })
  assert.equal(noKey.status, 200)
  assert.equal(noKey.json.available, false)
  assert.equal(noKey.json.mock, false)
  const refused = await api(baseD, 'POST', '/v1/audio/transcriptions?rate=16000', {
    token: (await login(baseD, 'emp-a', 'emp123456')).gatewayToken,
    body: Buffer.alloc(32),
    headers: { 'content-type': 'audio/pcm' },
  })
  assert.equal(refused.status, 503)
  assert.equal(refused.json.error.code, 'voice_not_configured')
})

test('语音识别：裸 PCM chunked 直传 mock 通道；非法参数逐一拒绝', async () => {
  // 设备上限 6 秒 / 192000 字节：16 kHz 单声道 16-bit 正好 6 秒。
  const pcm = Buffer.alloc(192000)
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(1000, i * 2)
  const r = await postChunked(baseA, '/v1/audio/transcriptions?rate=16000&channels=1&encoding=pcm_s16le', ctx.emp.gatewayToken, pcm)
  assert.equal(r.status, 200)
  assert.match(r.json.text, /模拟/)

  const empty = await api(baseA, 'POST', '/v1/audio/transcriptions', {
    token: ctx.emp.gatewayToken,
    body: Buffer.alloc(0),
    headers: { 'content-type': 'audio/pcm' },
  })
  assert.equal(empty.status, 400)
  assert.equal(empty.json.error.code, 'empty_audio')

  const cases = [
    ['/v1/audio/transcriptions?rate=100', 'bad_rate'],
    ['/v1/audio/transcriptions?rate=16000.5', 'bad_rate'],
    ['/v1/audio/transcriptions?rate=16000&channels=2', 'bad_channels'],
    ['/v1/audio/transcriptions?encoding=pcm_float32', 'bad_encoding'],
  ]
  for (const [p, code] of cases) {
    const bad = await api(baseA, 'POST', p, { token: ctx.emp.gatewayToken, body: pcm, headers: { 'content-type': 'audio/pcm' } })
    assert.equal(bad.status, 400, `${p}: ${bad.status}`)
    assert.equal(bad.json.error.code, code, p)
  }

  const oddPcm = await api(baseA, 'POST', '/v1/audio/transcriptions?rate=16000', {
    token: ctx.emp.gatewayToken,
    body: Buffer.alloc(3),
    headers: { 'content-type': 'audio/pcm' },
  })
  assert.equal(oddPcm.status, 400)
  assert.equal(oddPcm.json.error.code, 'bad_audio')

  // multipart 透传已移除：不做校验的任意转发一律拒绝。
  const mp = await api(baseA, 'POST', '/v1/audio/transcriptions', {
    token: ctx.emp.gatewayToken,
    body: Buffer.from('----x\r\nContent-Disposition: form-data; name="file"\r\n\r\nhi\r\n----x--\r\n'),
    headers: { 'content-type': 'multipart/form-data; boundary=x' },
  })
  assert.equal(mp.status, 400)
  assert.equal(mp.json.error.code, 'unsupported_content_type')
})

test('语音合成：mock 通道返回可播放的 PCM、显式 mock 头；非法请求拒绝', async () => {
  const r = await api(baseA, 'POST', '/v1/audio/speech', { token: ctx.emp.gatewayToken, body: { input: '你好', format: 'pcm' } })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'audio/pcm')
  assert.equal(r.headers.get('x-audio-rate'), '16000')
  assert.equal(r.headers.get('x-audio-channels'), '1')
  assert.equal(r.headers.get('x-audio-bits'), '16')
  assert.equal(r.headers.get('x-audio-mock'), '1', 'mock 合成必须可辨认')
  // 700 ms @ 16 kHz 单声道 16-bit = 22400 字节
  assert.equal(r.buf.length, 22400)
  assert.ok(r.buf.some((b) => b !== 0))

  const missing = await api(baseA, 'POST', '/v1/audio/speech', { token: ctx.emp.gatewayToken, body: { input: '   ' } })
  assert.equal(missing.status, 400)
  assert.equal(missing.json.error.code, 'missing_input')

  const nonString = await api(baseA, 'POST', '/v1/audio/speech', { token: ctx.emp.gatewayToken, body: { input: ['不是字符串'] } })
  assert.equal(nonString.status, 400)
  assert.equal(nonString.json.error.code, 'invalid_input')

  const badFormat = await api(baseA, 'POST', '/v1/audio/speech', { token: ctx.emp.gatewayToken, body: { input: '你好', format: 'mp3' } })
  assert.equal(badFormat.status, 400)
  assert.equal(badFormat.json.error.code, 'unsupported_format')

  const tooLong = await api(baseA, 'POST', '/v1/audio/speech', { token: ctx.emp.gatewayToken, body: { input: '啊'.repeat(2001) } })
  assert.equal(tooLong.status, 413)
  assert.equal(tooLong.json.error.code, 'input_too_long')
})

test('语音识别：真实 stub 上游 —— 网关把裸 PCM 封成 WAV multipart 发出', async () => {
  stubCalls.length = 0
  setStub((req, res, body) => jsonOut(200, { text: '上游识别结果' }))
  const pcm = Buffer.alloc(1600)
  pcm.writeInt16LE(1234, 0)
  const r = await api(baseB, 'POST', '/v1/audio/transcriptions?rate=16000&channels=1', {
    token: ctx.empB.gatewayToken,
    body: pcm,
    headers: { 'content-type': 'audio/pcm' },
  })
  assert.equal(r.status, 200)
  assert.equal(r.json.text, '上游识别结果')

  const call = stubCalls.find((c) => c.url.endsWith('/audio/transcriptions'))
  assert.ok(call, '应向上游发起真实 HTTP 请求')
  assert.equal(call.url, '/v1/audio/transcriptions')
  assert.equal(call.headers.authorization, 'Bearer sk-stub-key')
  assert.match(call.headers['content-type'], /multipart\/form-data; boundary=/)

  const parts = multipartParts(call.headers['content-type'], call.body)
  assert.equal(parts.length, 3)
  assert.match(parts[0].head, /name="model"/)
  assert.equal(parts[0].data.toString('utf8'), 'asr-test')
  assert.match(parts[1].head, /name="response_format"/)
  assert.equal(parts[1].data.toString('utf8'), 'json')
  assert.match(parts[2].head, /name="file"/)
  assert.match(parts[2].head, /filename="speech\.wav"/)
  assert.match(parts[2].head, /Content-Type: audio\/wav/i)

  const wav = parts[2].data
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.readUInt32LE(24), 16000, 'WAV 头采样率应为设备上报的 16000')
  assert.equal(wav.readUInt32LE(40), 1600, 'WAV data 长度应为 PCM 字节数')
})

test('语音合成：上游 WAV 剥成裸 PCM，采样率/位深如实告诉设备；客户端不能任指 model/voice', async () => {
  stubCalls.length = 0
  setStub((req, res, body) => {
    const pcm = Buffer.alloc(200 * 2)
    for (let i = 0; i < 200; i++) pcm.writeInt16LE(i * 10, i * 2)
    return { status: 200, headers: { 'content-type': 'audio/wav' }, body: pcmToWav(pcm, 22050, 1) }
  })
  const r = await api(baseB, 'POST', '/v1/audio/speech', {
    token: ctx.empB.gatewayToken,
    body: { input: '讲个笑话', format: 'pcm', model: 'rogue-model', voice: 'rogue-voice' },
  })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'audio/pcm')
  assert.equal(r.headers.get('x-audio-rate'), '22050')
  assert.equal(r.headers.get('x-audio-channels'), '1')
  assert.equal(r.headers.get('x-audio-bits'), '16')
  assert.equal(r.headers.get('x-audio-mock'), null)
  assert.equal(r.buf.length, 400)
  assert.equal(r.buf.readInt16LE(0), 0)

  const call = stubCalls.find((c) => c.url.endsWith('/audio/speech'))
  assert.equal(call.headers.authorization, 'Bearer sk-stub-key')
  const sent = JSON.parse(call.body.toString('utf8'))
  assert.deepEqual(sent, { model: 'tts-test', input: '讲个笑话', voice: 'v-test', response_format: 'wav' })
})

test('语音合成：上游回非 16-bit / 立体声 / 超范围采样率 / 非 WAV 一律 502 拒绝', async () => {
  const cases = [
    [{ channels: 2, frames: 4 }, 'unsupported_audio', '立体声'],
    [{ bits: 8, frames: 16 }, 'unsupported_audio', '8-bit'],
    [{ rate: 96000, frames: 8 }, 'unsupported_audio', '超范围采样率'],
    [{ fmtTag: 3, bits: 32, frames: 8 }, 'unsupported_audio', 'float 编码'],
  ]
  for (const [wavOpts, code, name] of cases) {
    setStub(() => ({ status: 200, headers: { 'content-type': 'audio/wav' }, body: makeWav({ rate: 22050, ...wavOpts }) }))
    const r = await api(baseB, 'POST', '/v1/audio/speech', { token: ctx.empB.gatewayToken, body: { input: '你好' } })
    assert.equal(r.status, 502, `${name}: ${r.status}`)
    assert.equal(r.json.error.code, code, name)
    assert.ok(!r.headers.get('x-audio-rate'), `${name}: 不该带可播放头`)
  }
  setStub(() => ({ status: 200, headers: { 'content-type': 'audio/mpeg' }, body: Buffer.alloc(128, 0xff) }))
  const mp3 = await api(baseB, 'POST', '/v1/audio/speech', { token: ctx.empB.gatewayToken, body: { input: '你好' } })
  assert.equal(mp3.status, 502)
  assert.equal(mp3.json.error.code, 'bad_upstream_audio', '非 WAV 不能当 PCM 骗设备播放')
})

test('语音识别：畸形 WAV 输入被明确拒绝', async () => {
  const garbage = await api(baseB, 'POST', '/v1/audio/transcriptions', {
    token: ctx.empB.gatewayToken,
    body: Buffer.alloc(64, 7),
    headers: { 'content-type': 'audio/wav' },
  })
  assert.equal(garbage.status, 400)
  assert.equal(garbage.json.error.code, 'bad_wav')

  const truncated = await api(baseB, 'POST', '/v1/audio/transcriptions', {
    token: ctx.empB.gatewayToken,
    body: Buffer.from('RIFF1234WAVE'),
    headers: { 'content-type': 'audio/wav' },
  })
  assert.equal(truncated.status, 400)
  assert.equal(truncated.json.error.code, 'bad_wav')

  const truncatedData = makeWav({ frames: 16 }).subarray(0, -1)
  const truncatedDataResult = await api(baseB, 'POST', '/v1/audio/transcriptions', {
    token: ctx.empB.gatewayToken,
    body: truncatedData,
    headers: { 'content-type': 'audio/wav' },
  })
  assert.equal(truncatedDataResult.status, 400)
  assert.equal(truncatedDataResult.json.error.code, 'bad_wav')

  const bits8 = await api(baseB, 'POST', '/v1/audio/transcriptions', {
    token: ctx.empB.gatewayToken,
    body: makeWav({ bits: 8, frames: 16 }),
    headers: { 'content-type': 'audio/wav' },
  })
  assert.equal(bits8.status, 400)
  assert.equal(bits8.json.error.code, 'unsupported_audio')
})

test('语音上游错误：不透传可能含敏感信息的错误体，账本记 upstream_<status>', async () => {
  setStub(() => jsonOut(500, { error: { message: 'boom sk-should-not-leak', code: 'stub_boom' } }))
  const r = await api(baseB, 'POST', '/v1/audio/transcriptions?rate=16000', {
    token: ctx.empB.gatewayToken,
    body: Buffer.alloc(160),
    headers: { 'content-type': 'audio/pcm' },
  })
  assert.equal(r.status, 502)
  assert.equal(r.json.error.code, 'upstream_error')
  assert.match(r.json.error.message, /HTTP 500/)
  assert.ok(!JSON.stringify(r.json).includes('sk-should-not-leak'))
  const entry = gwB.ledger.entriesSince(0, (e) => e.voice).at(-1)
  assert.equal(entry.status, 'upstream_500')
})

test('语音上游重定向被拒绝（不把 Authorization 带去第三方）', async () => {
  setStub(() => ({ status: 302, headers: { location: 'http://127.0.0.1:9/steal', 'content-type': 'text/plain' }, body: '' }))
  const r = await api(baseB, 'POST', '/v1/audio/speech', { token: ctx.empB.gatewayToken, body: { input: '你好' } })
  assert.equal(r.status, 502)
  assert.equal(r.json.error.code, 'upstream_unreachable')
})

test('语音上游超时：504 timeout，不把设备挂死', async () => {
  setStub(() => sleep(5000).then(() => jsonOut(200, { text: '太迟了' })))
  const started = Date.now()
  const r = await api(baseC, 'POST', '/v1/audio/transcriptions?rate=16000', {
    token: ctx.empC.gatewayToken,
    body: Buffer.alloc(160),
    headers: { 'content-type': 'audio/pcm' },
  })
  assert.equal(r.status, 504)
  assert.equal(r.json.error.code, 'timeout')
  assert.ok(Date.now() - started < 4000, `超时应约 1s 返回，实际 ${Date.now() - started}ms`)
  assert.equal(gwC.ledger.entriesSince(0, (e) => e.voice).at(-1).status, 'timeout')
})

test('WAV 结构：容器长度、块长度、采样对齐和空数据严格校验', () => {
  const valid = makeWav()
  assert.equal(splitWav(valid).pcm.length, 16)
  const mutations = [
    (b) => b.writeUInt32LE(36, 4),
    (b) => b.writeUInt32LE(b.length + 100, 4),
    (b) => b.writeUInt32LE(2, 16),
    (b) => b.writeUInt16LE(0, 22),
    (b) => b.writeUInt16LE(0, 34),
    (b) => b.writeUInt16LE(4, 32),
    (b) => b.writeUInt32LE(1, 28),
    (b) => b.writeUInt32LE(15, 40),
  ]
  for (const mutate of mutations) {
    const broken = Buffer.from(valid)
    mutate(broken)
    assert.equal(splitWav(broken), null)
  }
  assert.equal(splitWav(makeWav({ frames: 0 })), null)
  const trailer = Buffer.concat([valid, Buffer.from('x')])
  trailer.writeUInt32LE(trailer.length - 8, 4)
  assert.equal(splitWav(trailer), null)
})

test('WAV 结构：OpenAI 流式占位符（0xFFFFFFFF）能解析，但矛盾/截断容器仍拒绝', () => {
  const base = makeWav({ rate: 24000, frames: 64 })
  const streamed = Buffer.from(base)
  streamed.writeUInt32LE(0xFFFFFFFF, 4)
  streamed.writeUInt32LE(0xFFFFFFFF, 40)
  const wav = splitWav(streamed)
  assert.ok(wav, 'RIFF + data 都是占位符时要能剥出 PCM')
  assert.equal(wav.rate, 24000)
  assert.equal(wav.pcm.length, 128)

  // 只有 RIFF 是占位符（data 长度真实）
  const riffOnly = Buffer.from(base)
  riffOnly.writeUInt32LE(0xFFFFFFFF, 4)
  assert.equal(splitWav(riffOnly).pcm.length, 128)

  // data 占位但 RIFF 长度是严格的：容器自相矛盾，拒绝
  const dataOnly = Buffer.from(base)
  dataOnly.writeUInt32LE(0xFFFFFFFF, 40)
  assert.equal(splitWav(dataOnly), null)

  // 流式容器尾部多一个字节：截到 blockAlign 倍数，不留半个采样
  const odd = Buffer.concat([streamed, Buffer.from([0])])
  odd.writeUInt32LE(0xFFFFFFFF, 4)
  assert.equal(splitWav(odd).pcm.length, 128)

  // 流式容器里 data 为空：拒绝
  const empty = Buffer.from(base).subarray(0, 44)
  empty.writeUInt32LE(0xFFFFFFFF, 4)
  empty.writeUInt32LE(0, 40)
  assert.equal(splitWav(empty), null)

  // 其他块的长度不能是占位符
  const withJunk = Buffer.concat([base.subarray(0, 36), Buffer.from('LIST'), Buffer.from([0xff, 0xff, 0xff, 0xff]), base.subarray(36)])
  withJunk.writeUInt32LE(withJunk.length - 8, 4)
  assert.equal(splitWav(withJunk), null)
})

test('语音上游发完响应头后停住：ASR/TTS 都返回 504', async () => {
  setStub((req, res) => {
    res.writeHead(200, { 'content-type': req.url.endsWith('/speech') ? 'audio/wav' : 'application/json' })
    res.write('x')
    return new Promise(() => {})
  })
  const asr = await api(baseC, 'POST', '/v1/audio/transcriptions?rate=16000', {
    token: ctx.empC.gatewayToken, body: Buffer.alloc(160), headers: { 'content-type': 'audio/pcm' },
  })
  assert.equal(asr.status, 504)
  assert.equal(asr.json.error.code, 'timeout')
  const tts = await api(baseC, 'POST', '/v1/audio/speech', {
    token: ctx.empC.gatewayToken, body: { input: '测试超时' },
  })
  assert.equal(tts.status, 504)
  assert.equal(tts.json.error.code, 'timeout')
})

test('语音合成回包超限：502 upstream_too_large（响应尺寸有界）', async () => {
  setStub(() => ({ status: 200, headers: { 'content-type': 'audio/wav' }, body: makeWav({ rate: 16000, frames: 4096 }) }))
  const r = await api(baseC, 'POST', '/v1/audio/speech', { token: ctx.empC.gatewayToken, body: { input: '你好' } })
  assert.equal(r.status, 502)
  assert.equal(r.json.error.code, 'upstream_too_large')
})

test('设备断开连接：上游请求被取消，账本记 client_aborted', async () => {
  let gone
  const gonePromise = new Promise((resolve) => (gone = resolve))
  stubCalls.length = 0
  setStub((req, res) => {
    res.on('close', () => gone(res.writableEnded ? 'finished' : 'aborted'))
    return new Promise(() => {}) // 故意不回包
  })
  const ac = new AbortController()
  const device = fetch(baseB + '/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.empB.gatewayToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ input: '慢一点说' }),
    signal: ac.signal,
  }).then(
    () => 'resolved',
    () => 'aborted',
  )
  assert.ok(await waitFor(() => stubCalls.some((c) => c.url.endsWith('/audio/speech'))), '上游应已收到请求')
  ac.abort()
  assert.equal(await device, 'aborted')
  assert.equal(await Promise.race([gonePromise, sleep(3000).then(() => 'timeout')]), 'aborted', '上游连接应随设备断开而取消')
  assert.equal(gwB.ledger.entriesSince(0, (e) => e.voice).at(-1).status, 'client_aborted')
})

test('账号停用/令牌吊销即时生效', async () => {
  const me = await login(baseR, 'emp-a', 'emp123456')
  const user = gwR.db.listUsers().find((u) => u.username === 'emp-a')

  const ok = await api(baseR, 'GET', '/v1/audio/config', { token: me.gatewayToken })
  assert.equal(ok.status, 200)

  gwR.db.updateUser(user.id, { disabled: true })
  const disabled = await api(baseR, 'GET', '/v1/audio/config', { token: me.gatewayToken })
  assert.equal(disabled.status, 403)
  assert.equal(disabled.json.error.code, 'account_disabled')
  const knowledgeDisabled = await api(baseR, 'GET', '/v1/knowledge/search?q=x', { token: me.gatewayToken })
  assert.equal(knowledgeDisabled.status, 403)

  gwR.db.updateUser(user.id, { disabled: false })
  const restored = await api(baseR, 'GET', '/v1/audio/config', { token: me.gatewayToken })
  assert.equal(restored.status, 200)

  gwR.db.revokeGatewayTokens(user.id)
  const revoked = await api(baseR, 'GET', '/v1/audio/config', { token: me.gatewayToken })
  assert.equal(revoked.status, 401)
  assert.equal(revoked.json.error.code, 'invalid_token')
})

test('语音记账：按秒记账、没配价目如实 0；配置价目后如实计费', async () => {
  const voiceEntries = gwA.ledger.entriesSince(0, (e) => e.voice)
  const asr = voiceEntries.find((e) => e.voice.kind === 'asr')
  assert.ok(asr)
  assert.equal(asr.tag, 'voice-asr')
  assert.equal(asr.voice.audioSeconds, 6, '192000 字节 @16k 单声道 = 6 秒')
  assert.equal(asr.costCny, 0)
  assert.equal(asr.priceKnown, false, '没配价目不许假装知道成本')
  assert.equal(asr.promptTokens, 0)
  const tts = voiceEntries.find((e) => e.voice.kind === 'tts')
  assert.equal(tts.voice.audioSeconds, 0.7)

  setStub((req, res, body) => jsonOut(200, { text: '计费' }))
  await api(baseP, 'POST', '/v1/audio/transcriptions?rate=16000', {
    token: ctx.empP.gatewayToken,
    body: Buffer.alloc(1600),
    headers: { 'content-type': 'audio/pcm' },
  })
  const priced = gwP.ledger.entriesSince(0, (e) => e.voice && e.voice.kind === 'asr').at(-1)
  assert.equal(priced.priceKnown, true)
  assert.equal(priced.voice.audioSeconds, 0.05)
  assert.equal(priced.costCny, 0.005, '0.05 秒 × 6 元/分钟')
})

test('设备知识检索：网关令牌、limit 生效、用户之间权限隔离', async () => {
  // emp-a 写一条个人记忆（员工对共享目录无写权限，个人记忆足够验证权限链路）
  const add = await api(baseA, 'POST', '/api/knowledge/entries', {
    token: ctx.emp.sessionToken,
    body: { title: '设备接入说明', content: '设备通过网关访问知识库，语音走 /v1/audio。', scope: 'personal' },
  })
  assert.equal(add.status, 200, JSON.stringify(add.json))

  const r = await api(baseA, 'GET', '/v1/knowledge/search?q=' + encodeURIComponent('知识库') + '&limit=2', { token: ctx.emp.gatewayToken })
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.json.hits))
  assert.ok(r.json.hits.length <= 2, 'limit=2 要生效')
  const hit = r.json.hits.find((h) => h.title.includes('设备接入说明'))
  assert.ok(hit, '网关令牌应检索到刚写的个人记忆')
  assert.equal(hit.kind, 'personal')

  // 别人搜同一个词：员工的个人记忆不可见。
  const boss = await login(baseA, 'boss', 'boss123456')
  const bossView = await api(baseA, 'GET', '/v1/knowledge/search?q=' + encodeURIComponent('知识库') + '&limit=5', { token: boss.gatewayToken })
  assert.equal(bossView.status, 200)
  assert.equal(bossView.json.hits.find((h) => h.title.includes('设备接入说明')), undefined, '他人的个人记忆必须隔离')

  const anon = await api(baseA, 'GET', '/v1/knowledge/search?q=x')
  assert.equal(anon.status, 401)
  const sessionOnly = await api(baseA, 'GET', '/v1/knowledge/search?q=x', { token: ctx.emp.sessionToken })
  assert.equal(sessionOnly.status, 401)
})

test('语音合成：上游用 OpenAI 风格占位符长度的 WAV 也能剥出裸 PCM', async () => {
  // 真实 OpenAI TTS 的 WAV 在 RIFF/data 长度里写 0xFFFFFFFF（流式写入，不知道总长）。
  setStub((req) => {
    if (req.url.endsWith('/audio/speech')) {
      const pcm = Buffer.alloc(400 * 2)
      for (let i = 0; i < 400; i++) pcm.writeInt16LE(i * 5, i * 2)
      const buf = pcmToWav(pcm, 24000, 1)
      buf.writeUInt32LE(0xFFFFFFFF, 4)
      buf.writeUInt32LE(0xFFFFFFFF, 40)
      return { status: 200, headers: { 'content-type': 'audio/wav' }, body: buf }
    }
    return jsonOut(200, { text: 'x' })
  })
  const r = await api(baseB, 'POST', '/v1/audio/speech', { token: ctx.empB.gatewayToken, body: { input: '占位符', format: 'pcm' } })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('x-audio-rate'), '24000')
  assert.equal(r.buf.length, 800)
  assert.equal(gwB.ledger.entriesSince(0, (e) => e.tag === 'voice-tts').at(-1).status, 'ok')
})
