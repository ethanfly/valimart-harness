import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FAMILY_ALIASES, isVideoModel, listVideoModels, normalizeVideoConfig, planSegments, resolveVideoModel, segmentCap } from '../../plugins/desk-video/lib/models.js'
import { callGatewayVideo, concatVideos, generateVideo, writeVideoItem } from '../../plugins/desk-video/lib/generate.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const CATALOG = [
  { id: 'deepseek-v4-pro', name: 'DeepSeek' },
  { id: 'grok-imagine-video-1.5', name: 'Grok Video' },
  { id: 'grok-imagine-image-2.0', name: 'Grok Image' },
  { id: 'wan2.6-t2v', name: '万相' },
  { id: 'MiniMax-Hailuo-02', name: '海螺' },
  { id: 'sora-2', name: 'Sora' },
  { id: 'doubao-seedance-1-0-pro', name: 'Seedance' },
]

test('isVideoModel：视频进、生图和聊天排除', () => {
  assert.equal(isVideoModel('grok-imagine-video-1.5'), true)
  assert.equal(isVideoModel('wan2.6-t2v'), true)
  assert.equal(isVideoModel('sora-2'), true)
  assert.equal(isVideoModel('doubao-seedance-1-0-pro'), true)
  assert.equal(isVideoModel('grok-imagine-image-2.0'), false)
  assert.equal(isVideoModel('qwen-image'), false)
  assert.equal(isVideoModel('deepseek-v4-pro'), false)
})

test('短名对到目录里的真实 id，对不上不落到别的厂商', () => {
  assert.equal(resolveVideoModel({ requested: 'grok', catalog: CATALOG }), 'grok-imagine-video-1.5')
  assert.equal(resolveVideoModel({ requested: 'wan', catalog: CATALOG }), 'wan2.6-t2v')
  assert.equal(resolveVideoModel({ requested: 'qwen', catalog: CATALOG }), 'wan2.6-t2v')
  assert.equal(resolveVideoModel({ requested: 'minimax', catalog: CATALOG }), 'MiniMax-Hailuo-02')
  assert.equal(resolveVideoModel({ requested: 'gpt', catalog: CATALOG }), 'sora-2')
  assert.equal(resolveVideoModel({ requested: 'seedance', catalog: CATALOG }), 'doubao-seedance-1-0-pro')
  assert.equal(resolveVideoModel({ requested: 'seeddance', catalog: CATALOG }), 'doubao-seedance-1-0-pro')
  assert.equal(resolveVideoModel({ requested: 'kling', catalog: CATALOG }), null)
  assert.equal(resolveVideoModel({ defaultModel: 'grok', catalog: CATALOG }), 'grok-imagine-video-1.5')
})

test('listVideoModels 去掉生图模型', () => {
  assert.deepEqual(listVideoModels(CATALOG).map((m) => m.id), ['grok-imagine-video-1.5', 'wan2.6-t2v', 'MiniMax-Hailuo-02', 'sora-2', 'doubao-seedance-1-0-pro'])
})

test('长视频按单段上限切，余数留给最后一段', () => {
  assert.deepEqual(planSegments(6, 10), [6])
  assert.deepEqual(planSegments(25, 10), [10, 10, 5])
  assert.equal(segmentCap('wan2.6-t2v'), 10)
  assert.equal(segmentCap('sora-2'), 15)
  assert.equal(segmentCap('grok-imagine-video-1.5'), 15)
  assert.equal(segmentCap('veo-3'), 8)
  assert.equal(planSegments(999, 10).reduce((a, b) => a + b, 0), 120)
})

test('normalizeVideoConfig 清洗时长和长视频开关', () => {
  const cfg = normalizeVideoConfig({ defaultModel: ' wan ', duration: 9999, aspectRatio: 'nope', longForm: 'false', customModels: 'a, b' })
  assert.equal(cfg.defaultModel, 'wan')
  assert.equal(cfg.duration, 120)
  assert.equal(cfg.aspectRatio, '16:9')
  assert.equal(cfg.longForm, false)
  assert.deepEqual(cfg.customModels, ['a', 'b'])
  assert.equal(cfg.aliases.grok, 'grok-imagine-video-1.5')
})

test('FAMILY_ALIASES 覆盖六家', () => {
  for (const name of ['wan', 'minimax', 'grok', 'gpt', 'qwen', 'seedance']) assert.ok(FAMILY_ALIASES[name]?.length)
})

test('异步任务先拿 id 再轮询到 url', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(url)
    const body = JSON.parse(init.body)
    if (url.endsWith('/generations')) return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'task-1', status: 'queued', data: [] }), json: async () => ({}) }
    assert.equal(body.id, 'task-1')
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'succeeded', data: [{ url: 'https://cdn.example/a.mp4' }] }) }
  }
  const r = await callGatewayVideo({
    gatewayUrl: 'http://gw', token: 't', model: 'wan2.6-t2v', prompt: '猫走路', duration: 5, aspectRatio: '16:9',
    fetchImpl, sleep: async () => {},
  })
  assert.equal(r.item.url, 'https://cdn.example/a.mp4')
  assert.equal(calls.length, 2)
})

test('多参考图放进 images，单张同时给 image', async () => {
  let sent
  const fetchImpl = async (_url, init) => {
    sent = JSON.parse(init.body)
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: Buffer.from('mp4').toString('base64') }] }) }
  }
  await callGatewayVideo({
    gatewayUrl: 'http://gw', token: 't', model: 'wan2.6-t2v', prompt: '猫', duration: 5, aspectRatio: '16:9',
    images: ['aaa', 'bbb'], fetchImpl,
  })
  assert.deepEqual(sent.images, ['aaa', 'bbb'])
  assert.equal(sent.image, 'aaa')
  await assert.rejects(() => callGatewayVideo({ gatewayUrl: 'http://gw', token: 't', model: 'x', prompt: '  ', fetchImpl }), /prompt/)
})

test('超过单段上限时分段，下一段用上一段尾帧当首帧', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-video-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const prompts = []
  let n = 0
  const fetchImpl = async (_url, init) => {
    if (init?.method === 'POST') {
      prompts.push(JSON.parse(init.body))
      n += 1
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ url: `https://cdn.example/${n}.mp4` }] }) }
    }
    return { ok: true, arrayBuffer: async () => Buffer.from(`part-${n}`) }
  }
  const exec = (_bin, args, cb) => {
    if (args[0] === '-version') { cb(null, 'ffmpeg', ''); return }
    if (args.includes('-frames:v')) { fs.writeFileSync(args.at(-1), 'FRAME'); cb(null, '', ''); return }
    fs.writeFileSync(args.at(-1), 'joined')
    cb(null, '', '')
  }
  const r = await generateVideo({
    gatewayUrl: 'http://gw', token: 't', model: 'wan2.6-t2v', prompt: '猫在雨里走', duration: 25, aspectRatio: '16:9',
    images: ['ref'], cwd: dir, out: 'out.mp4', fetchImpl, exec,
  })
  assert.deepEqual(r.segments, [10, 10, 5])
  assert.equal(prompts.length, 3)
  assert.deepEqual(prompts[0].images, ['ref'])
  assert.equal(prompts[1].images[0], Buffer.from('FRAME').toString('base64'))
  assert.equal(prompts[1].images[1], 'ref')
  assert.equal(prompts[1].image, prompts[1].images[0])
  assert.match(prompts[1].prompt, /第 2\/3 段/)
  assert.equal(fs.readFileSync(r.written[0].path, 'utf8'), 'joined')
  assert.equal(fs.existsSync(path.join(dir, 'videos')), false)
  assert.equal(fs.readdirSync(dir).some((f) => f.startsWith('.')), false)
})

test('Grok 单段 15 秒，15 秒不拆段', async () => {
  let sent
  const fetchImpl = async (_url, init) => {
    sent = JSON.parse(init.body)
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: Buffer.from('x').toString('base64') }] }) }
  }
  const r = await generateVideo({
    gatewayUrl: 'http://gw', token: 't', model: 'grok-imagine-video-1.5', prompt: '猫', duration: 15, aspectRatio: '16:9',
    cwd: os.tmpdir(), out: path.join(os.tmpdir(), 'grok15.mp4'), fetchImpl, exec: () => {},
  })
  assert.deepEqual(r.segments, [15])
  assert.equal(sent.duration, 15)
})

test('没有 ffmpeg 时保留各段而不是失败', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-video-noff-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let n = 0
  const fetchImpl = async (_url, init) => {
    if (init?.method === 'POST') { n += 1; return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ url: 'https://cdn.example/a.mp4' }] }) } }
    return { ok: true, arrayBuffer: async () => Buffer.from('part' + n) }
  }
  const exec = (bin, _args, cb) => cb(Object.assign(new Error('spawn ' + bin + ' ENOENT'), { code: 'ENOENT' }))
  const r = await generateVideo({
    gatewayUrl: 'http://gw', token: 't', model: 'wan2.6-t2v', prompt: '猫', duration: 25, aspectRatio: '16:9',
    cwd: dir, out: 'out.mp4', fetchImpl, exec,
  })
  assert.equal(r.written.length, 3)
  assert.match(r.note, /ffmpeg/)
  assert.equal(fs.readdirSync(path.join(dir, 'videos')).filter((f) => f.startsWith('part-')).length, 3)
})

test('concatVideos 用 concat demuxer 调 ffmpeg', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-video-concat-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let argv
  const dest = path.join(dir, 'out.mp4')
  await concatVideos([path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')], dest, (_bin, args, cb) => {
    argv = args
    fs.writeFileSync(dest, 'ok')
    cb(null, '', '')
  })
  assert.equal(argv[0], '-y')
  assert.ok(argv.includes('-f') && argv.includes('concat'))
  assert.equal(fs.existsSync(dest), true)
  assert.equal(fs.readdirSync(dir).some((f) => f.startsWith('.concat-')), false)
})

test('writeVideoItem 把文件限制在工作目录内', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-video-write-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = await writeVideoItem({ cwd: dir, out: 'clip.mp4', item: { b64_json: Buffer.from('xyz').toString('base64') } })
  assert.equal(file.rel, 'clip.mp4')
  assert.equal(fs.readFileSync(file.path, 'utf8'), 'xyz')
})

test('profile、设置页、输入框和打包清单都挂上 desk-video', () => {
  const patch = fs.readFileSync(path.join(repo, 'profile/cordis.patch.yml'), 'utf8')
  const ui = fs.readFileSync(path.join(repo, 'plugins/desk-ui/src/client/index.jsx'), 'utf8')
  const api = fs.readFileSync(path.join(repo, 'plugins/desk-ui/src/client/api.js'), 'utf8')
  const boot = fs.readFileSync(path.join(repo, 'scripts/lib/bootstrap.mjs'), 'utf8')
  const payload = fs.readFileSync(path.join(repo, 'scripts/build-payload.mjs'), 'utf8')
  const plugin = fs.readFileSync(path.join(repo, 'plugins/desk-video/lib/index.js'), 'utf8')
  assert.match(plugin, /name: 'video_generate'/)
  assert.match(plugin, /\/v1\/videos\/generations/)
  assert.match(patch, /id: desk-video/)
  assert.match(ui, /VideoGenSection/)
  assert.match(api, /video:\s*\{/)
  assert.match(boot, /desk-video/)
  assert.match(payload, /desk-video/)
})
