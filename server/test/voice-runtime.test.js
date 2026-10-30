/**
 * 本机语音运行时（node --test）。
 *
 * 不下载真实模型、不跑 sherpa-onnx：fetch、tar、子进程都注入。
 * 覆盖：校验和不符不落盘、压缩包路径穿越拒绝、安装后激活把通道改成本机、
 * 设备识别/合成走注入的运行时且不出网、缺文件时 400。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { createGateway } from '../src/index.js'
import { VOICE_ASSETS, VOICE_RUNTIMES } from '../src/voice-runtime.js'
import { pcmToWav } from '../src/audio-proxy.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-voice-runtime-'))
const downloads = []

function bodyOf(buf) {
  return Readable.toWeb(Readable.from([buf]))
}

const gw = createGateway({
  host: '127.0.0.1',
  port: 0,
  dataDir: tmp,
  upstreams: { mock: { kind: 'mock', label: 'Mock', models: [{ id: 'mock-echo', name: 'Mock Echo' }] } },
  defaultModel: 'mock-echo',
  voice: { provider: 'mock' },
  fetchReleases: async () => [],
  fetchModels: async () => new Response(JSON.stringify({ error: 'no' }), { status: 404 }),
})

// 安装与推理全部注入：测试不碰网络、不碰真实 tar。
const rt = gw.voiceRuntime
rt.platform = 'win32'
rt.fetch = async (url) => {
  downloads.push(url)
  const asset = Object.values(VOICE_RUNTIMES).find((a) => a.url === url) ?? Object.values(VOICE_ASSETS).find((a) => a.url === url)
  const buf = Buffer.from(asset.sha256)
  // 摘要必须匹配：用真实 sha256 反推不出正文，改为让运行时接受「测试模式」不现实，
  // 所以直接把资产摘要换成这段正文的摘要（仅测试进程内）。
  asset.sha256 = createHash('sha256').update(buf).digest('hex')
  return { ok: true, status: 200, body: bodyOf(buf) }
}
rt.extract = async (archive, asset) => {
  const root = path.join(tmp, 'voice-runtime')
  const touch = (rel) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), 'x') }
  if (!asset.model) {
    touch(`${asset.dir}/bin/sherpa-onnx-offline.exe`)
    touch(`${asset.dir}/bin/sherpa-onnx-offline-tts.exe`)
  } else if (asset.model.endsWith('int8.onnx')) {
    touch(`${asset.dir}/tokens.txt`)
    touch(`${asset.dir}/${asset.model}`)
  } else {
    touch(`${asset.dir}/tokens.txt`)
    touch(`${asset.dir}/${asset.model}`)
    touch(`${asset.dir}/voices.bin`)
  }
  fs.rmSync(archive, { force: true })
}
rt.run = async (command, args) => {
  if (args?.includes('-tjf') || args?.includes('-xjf')) return { code: 0, stdout: '', stderr: '' }
  const asr = String(command).includes('sherpa-onnx-offline') && !String(command).includes('tts')
  return asr ? { code: 0, stdout: '', stderr: '{"text":"本机识别结果"}\n' } : { code: 0, stdout: '', stderr: '' }
}

let base
let token
before(async () => {
  base = await gw.listen()
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'boss123456', device: 'rt' }) })
  token = (await login.json()).sessionToken
})
after(async () => { await gw.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

async function call(method, p, body) {
  const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}

test('未安装时状态全为 false，且不报已激活', async () => {
  const r = await call('GET', '/api/admin/voice/runtime')
  assert.equal(r.status, 200)
  assert.equal(r.json.runtime.ready, false)
  assert.equal(r.json.runtime.runtime, false)
  assert.equal(r.json.runtime.active, false)
  assert.equal(r.json.runtime.bytes.tts, 349_906_910)
})

test('没装好就激活 → 400，通道不变', async () => {
  const r = await call('POST', '/api/admin/voice/runtime/activate')
  assert.equal(r.status, 400)
  assert.equal(r.json.error.code, 'runtime_missing')
  const view = await call('GET', '/api/admin/voice')
  assert.equal(view.json.voice.adminSet, false)
})

test('安装按固定地址下载三项；激活后通道变成 local://，响应不含密钥', async () => {
  const r = await call('POST', '/api/admin/voice/runtime/install')
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.runtime.ready, true)
  assert.deepEqual(downloads.map((u) => new URL(u).pathname.split('/').at(-1)), [VOICE_RUNTIMES[rt.runtimeKey].name, VOICE_ASSETS.asr.name, VOICE_ASSETS.tts.name])
  const again = await call('POST', '/api/admin/voice/runtime/install')
  assert.equal(downloads.length, 3, '已装好不再下载')
  void again

  const on = await call('POST', '/api/admin/voice/runtime/activate')
  assert.equal(on.status, 200)
  assert.equal(on.json.voice.asrEndpoint, 'local://asr')
  assert.equal(on.json.voice.ttsEndpoint, 'local://tts')
  assert.equal(on.json.voice.endpointsSplit, true)
  assert.equal(on.json.voice.available, true)
  assert.doesNotMatch(JSON.stringify(on.json), /local-key|sk-/)
})

test('设备识别与合成走本机运行时，不发上游请求', async () => {
  const emp = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'emp-a', password: 'emp123456', device: 'rt' }) })
  const device = (await emp.json()).gatewayToken
  const asr = await fetch(base + '/v1/audio/transcriptions?rate=16000', { method: 'POST', headers: { authorization: `Bearer ${device}`, 'content-type': 'audio/pcm' }, body: Buffer.alloc(3200) })
  assert.equal(asr.status, 200, JSON.stringify(await asr.clone().json()))
  assert.equal((await asr.json()).text, '本机识别结果')
  const tts = await fetch(base + '/v1/audio/speech', { method: 'POST', headers: { authorization: `Bearer ${device}`, 'content-type': 'application/json' }, body: JSON.stringify({ input: '你好', format: 'pcm' }) })
  assert.equal(tts.status, 502, '注入的 run 不产 WAV，合成应明确失败而不是回演示音')
  assert.equal((await tts.json()).error.code, 'local_tts_failed')
  assert.equal(downloads.length, 3, '推理过程没有新的下载')
})

test('文件清单超过 run() 保留的尾部 → 仍整份校验并解压', async () => {
  const { VoiceRuntime } = await import('../src/voice-runtime.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-voice-list-'))
  const runtime = new VoiceRuntime({ dataDir: dir, platform: 'win32' })
  const asset = VOICE_ASSETS.tts
  const archive = path.join(dir, 'voice-runtime', `${asset.name}.part`)
  fs.mkdirSync(path.dirname(archive), { recursive: true })
  fs.writeFileSync(archive, 'x')
  const listing = Array.from({ length: 400 }, (_, i) => `${asset.dir}/espeak-ng-data/lang/dict-${String(i).padStart(3, '0')}`).join('\n') + '\n'
  assert.ok(listing.length > 8000, '用例必须长过 run() 内存里保留的尾部')
  const calls = []
  runtime.run = async (cmd, args, opts = {}) => {
    calls.push(args[0])
    if (args.includes('-tjf')) {
      assert.ok(opts.stdoutFile, '长清单必须落盘，不能靠被截断的 stdout')
      fs.writeFileSync(opts.stdoutFile, listing)
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const root = path.join(dir, 'voice-runtime')
  const touch = (rel) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), 'x') }
  const orig = runtime.installed.bind(runtime)
  runtime.installed = async () => { touch(`${asset.dir}/tokens.txt`); touch(`${asset.dir}/${asset.model}`); touch(`${asset.dir}/voices.bin`); return orig() }
  await runtime.extract(archive, asset)
  assert.deepEqual(calls, ['-tjf', '-xjf'])
  assert.equal(fs.existsSync(`${archive}.list`), false, '清单临时文件要删掉')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('压缩包含路径穿越 → 拒绝且不调用 tar 解压', async () => {
  const { VoiceRuntime } = await import('../src/voice-runtime.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-voice-tar-'))
  const runtime = new VoiceRuntime({ dataDir: dir, platform: 'linux', arch: 'arm64' })
  const archive = path.join(dir, 'voice-runtime', 'bad.tar.bz2')
  fs.mkdirSync(path.dirname(archive), { recursive: true })
  fs.writeFileSync(archive, 'x')
  let extracted = false
  runtime.run = async (cmd, args, opts = {}) => {
    if (args.includes('-tjf')) { fs.writeFileSync(opts.stdoutFile, '../outside.txt\n'); return { code: 0, stdout: '', stderr: '' } }
    extracted = true
    return { code: 0, stdout: '', stderr: '' }
  }
  await assert.rejects(() => runtime.extract(archive, VOICE_RUNTIMES[runtime.runtimeKey]), (err) => err.code === 'bad_archive')
  assert.equal(extracted, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('校验和不符 → 400/502 且删除临时文件', async () => {
  const { VoiceRuntime } = await import('../src/voice-runtime.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-voice-sum-'))
  const runtime = new VoiceRuntime({ dataDir: dir, platform: 'win32' })
  runtime.fetch = async () => ({ ok: true, status: 200, body: bodyOf(Buffer.from('not-the-asset')) })
  await assert.rejects(() => runtime.fetchAsset('runtime'), (err) => err.code === 'bad_checksum')
  const left = fs.readdirSync(path.join(dir, 'voice-runtime')).filter((n) => n.endsWith('.part'))
  assert.deepEqual(left, [])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('Linux arm64 下载 aarch64 运行库，且启动时带上 lib 目录', async () => {
  const { VoiceRuntime } = await import('../src/voice-runtime.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-voice-arm-'))
  const runtime = new VoiceRuntime({ dataDir: dir, platform: 'linux', arch: 'arm64' })
  assert.equal(runtime.runtimeKey, 'linux-arm64')
  const seen = []
  runtime.fetch = async (url) => {
    seen.push(url)
    const asset = url.endsWith(VOICE_RUNTIMES['linux-arm64'].name) ? VOICE_RUNTIMES['linux-arm64'] : Object.values(VOICE_ASSETS).find((a) => a.url === url)
    const buf = Buffer.from('arm')
    asset.sha256 = createHash('sha256').update(buf).digest('hex')
    return { ok: true, status: 200, body: bodyOf(buf) }
  }
  runtime.extract = async (archive, asset) => {
    const touch = (rel) => { fs.mkdirSync(path.dirname(path.join(dir, 'voice-runtime', rel)), { recursive: true }); fs.writeFileSync(path.join(dir, 'voice-runtime', rel), 'x') }
    if (asset === VOICE_RUNTIMES['linux-arm64']) {
      touch(`${asset.dir}/bin/sherpa-onnx-offline`)
      touch(`${asset.dir}/bin/sherpa-onnx-offline-tts`)
    } else touch(`${asset.dir}/tokens.txt`) , touch(`${asset.dir}/${asset.model}`) , asset.model === 'model.onnx' && touch(`${asset.dir}/voices.bin`)
    fs.rmSync(archive, { force: true })
  }
  let env = null
  runtime.run = async () => { env = runtime.libEnv(); return { code: 0, stdout: '', stderr: '{"text":"ok"}\n' } }
  const view = await runtime.install()
  assert.equal(view.ready, true)
  assert.equal(view.platform, 'linux-arm64')
  assert.ok(seen[0].endsWith('sherpa-onnx-v2.0.0-linux-aarch64-shared-cpu.tar.bz2'))
  await runtime.transcribe(Buffer.from('x'))
  assert.ok(env.LD_LIBRARY_PATH.replaceAll('\\', '/').endsWith('linux-aarch64-shared-cpu/lib'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('识别结果在 stdout，且带空格的模型路径先转成无空格再交给 sherpa', async () => {
  const { VoiceRuntime } = await import('../src/voice-runtime.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk voice runtime '))
  const runtime = new VoiceRuntime({ dataDir: dir, platform: 'win32' })
  const asset = VOICE_ASSETS.asr
  const root = path.join(dir, 'voice-runtime')
  const touch = (rel) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), 'x') }
  touch(`${asset.dir}/tokens.txt`)
  touch(`${asset.dir}/${asset.model}`)
  const seen = []
  runtime.run = async (cmd, args) => {
    seen.push(...args)
    return { code: 0, stdout: '{"text":"从标准输出读到"}\n', stderr: 'recognizer created\n' }
  }
  const text = await runtime.transcribe(Buffer.from('RIFF'))
  assert.equal(text, '从标准输出读到')
  const modelArg = seen.find((a) => a.startsWith('--sense-voice-model='))
  assert.ok(modelArg, '要传模型路径')
  assert.equal(modelArg.includes(' '), false, modelArg)
  assert.equal(seen.at(-1).includes(' '), false, seen.at(-1))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('中文音色名映射到 Kokoro 说话人编号，未知名字不用 0 号英语音色', async () => {
  const { VoiceRuntime, KOKORO_SPEAKERS, DEFAULT_LOCAL_VOICE } = await import('../src/voice-runtime.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-voice-sid-'))
  const runtime = new VoiceRuntime({ dataDir: dir, platform: 'win32' })
  const asset = VOICE_ASSETS.tts
  const root = path.join(dir, 'voice-runtime')
  const touch = (rel) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), 'x') }
  touch(`${asset.dir}/tokens.txt`)
  touch(`${asset.dir}/${asset.model}`)
  touch(`${asset.dir}/voices.bin`)
  touch(`${asset.dir}/espeak-ng-data/phontab`)
  touch(`${asset.dir}/lexicon-us-en.txt`)
  touch(`${asset.dir}/lexicon-zh.txt`)
  const sids = []
  runtime.run = async (cmd, args) => {
    const sid = args.find((a) => a.startsWith('--sid='))
    sids.push(sid)
    const out = args.find((a) => a.startsWith('--output-filename='))?.slice('--output-filename='.length)
    fs.writeFileSync(out, 'RIFF')
    return { code: 0, stdout: '', stderr: '' }
  }
  await runtime.speak('你好', 'zf_xiaoxiao')
  await runtime.speak('你好', 'zf_xiaobei')
  await runtime.speak('你好', '没有这个音色')
  assert.deepEqual(sids, [
    `--sid=${KOKORO_SPEAKERS.zf_xiaoxiao}`,
    `--sid=${KOKORO_SPEAKERS.zf_xiaobei}`,
    `--sid=${KOKORO_SPEAKERS[DEFAULT_LOCAL_VOICE]}`,
  ])
  assert.notEqual(KOKORO_SPEAKERS[DEFAULT_LOCAL_VOICE], 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('不支持的架构直接拒绝，不发下载', async () => {
  const { VoiceRuntime } = await import('../src/voice-runtime.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-voice-arch-'))
  const runtime = new VoiceRuntime({ dataDir: dir, platform: 'linux', arch: 'riscv64' })
  let fetched = false
  runtime.fetch = async () => { fetched = true; return { ok: false, status: 500, body: null } }
  await assert.rejects(() => runtime.install(), (err) => err.code === 'unsupported_platform')
  assert.equal(fetched, false)
  const view = await runtime.view()
  assert.equal(view.supported, false)
  fs.rmSync(dir, { recursive: true, force: true })
})
