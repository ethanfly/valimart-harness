import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FAMILY_ALIASES, isImageModel, listImageModels, normalizeImageConfig, resolveImageModel } from '../../plugins/desk-image/lib/models.js'
import { callGatewayImages, destPath, parseDataUrl, sniffImage, stampName, writeImageItems } from '../../plugins/desk-image/lib/generate.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')

test('isImageModel：生图进、聊天/视频/vision 排除', () => {
  assert.equal(isImageModel('grok-imagine-image-2.0'), true)
  assert.equal(isImageModel('gpt-image-1'), true)
  assert.equal(isImageModel('qwen-image'), true)
  assert.equal(isImageModel('dall-e-3'), true)
  assert.equal(isImageModel('deepseek-v4-pro'), false)
  assert.equal(isImageModel('grok-imagine-video-1.5'), false)
  assert.equal(isImageModel('gpt-4o-vision'), false)
})

test('resolveImageModel：gpt / qwen / grok 短名对到目录里的真实 id', () => {
  const catalog = [
    { id: 'deepseek-v4-pro', name: 'DeepSeek' },
    { id: 'grok-imagine-image-2.0', name: 'Grok Imagine' },
    { id: 'gpt-image-1', name: 'GPT Image' },
    { id: 'qwen-image', name: 'Qwen Image' },
  ]
  assert.equal(resolveImageModel({ requested: 'grok', catalog }), 'grok-imagine-image-2.0')
  assert.equal(resolveImageModel({ requested: 'gpt', catalog }), 'gpt-image-1')
  assert.equal(resolveImageModel({ requested: 'qwen', catalog }), 'qwen-image')
  assert.equal(resolveImageModel({ requested: 'GPT Image 1', catalog }), 'gpt-image-1')
  assert.equal(resolveImageModel({ requested: 'grok-imagine-image-2.0', catalog }), 'grok-imagine-image-2.0')
  assert.equal(resolveImageModel({ defaultModel: 'grok', catalog }), 'grok-imagine-image-2.0')
  assert.equal(resolveImageModel({ requested: 'flux', catalog: [{ id: 'flux-1-pro' }] }), 'flux-1-pro')
  assert.equal(resolveImageModel({ requested: 'nope', catalog: [{ id: 'deepseek-v4-pro' }] }), null)
  assert.equal(resolveImageModel({ requested: 'gpt', catalog: [{ id: 'grok-imagine-image-2.0' }] }), null)
})

test('aliases 覆盖短名；customModels 允许目录外的 id', () => {
  const catalog = [{ id: 'grok-imagine-image-2.0' }]
  assert.equal(resolveImageModel({ requested: 'gpt', aliases: { gpt: 'grok-imagine-image-2.0' }, catalog }), 'grok-imagine-image-2.0')
  assert.equal(resolveImageModel({ requested: 'gpt-image-1', customModels: ['gpt-image-1'], catalog }), 'gpt-image-1')
})

test('normalizeImageConfig：清洗比例、短名、额外模型列表', () => {
  const cfg = normalizeImageConfig({ defaultModel: ' gpt ', aspectRatio: 'nope', customModels: 'a, b\nc', aliases: { GPT: ' gpt-image-1 ' } })
  assert.equal(cfg.defaultModel, 'gpt')
  assert.equal(cfg.aspectRatio, '1:1')
  assert.deepEqual(cfg.customModels, ['a', 'b', 'c'])
  assert.equal(cfg.aliases.gpt, 'gpt-image-1')
  assert.equal(cfg.aliases.grok, 'grok-imagine-image-2.0')
})

test('listImageModels 去重视频模型', () => {
  const list = listImageModels([
    { id: 'grok-imagine-image-2.0' },
    { id: 'grok-imagine-image-2.0' },
    { id: 'grok-imagine-video-1.5' },
    { id: 'deepseek-v4-pro' },
  ])
  assert.deepEqual(list.map((m) => m.id), ['grok-imagine-image-2.0'])
})

test('FAMILY_ALIASES 覆盖 gpt / qwen / grok', () => {
  for (const name of ['gpt', 'qwen', 'grok']) assert.ok(FAMILY_ALIASES[name]?.length)
})

test('sniffImage / parseDataUrl / stampName', () => {
  assert.equal(sniffImage(PNG).ext, '.png')
  assert.equal(parseDataUrl('data:image/png;base64,abc'), 'abc')
  assert.equal(parseDataUrl('abc'), 'abc')
  assert.match(stampName(new Date('2026-09-08T12:34:56Z')), /image-20260908-123456/)
})

test('destPath 限制在工作目录内，并按内容改扩展名', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-image-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const out = destPath(dir, 'cat.png', 0, 1, PNG)
  assert.equal(path.basename(out), 'cat.png')
  assert.ok(out.startsWith(dir))
  assert.throws(() => destPath(dir, path.join(dir, '..', 'escape.png'), 0, 1, PNG), /工作目录/)
})

test('callGatewayImages + writeImageItems：走 generations，把 PNG 写盘', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-image-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let last
  const fetchImpl = async (url, init) => {
    last = { url, init }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ b64_json: PNG_B64 }] }),
    }
  }
  const { items, model, edit } = await callGatewayImages({
    gatewayUrl: 'http://127.0.0.1:8790/',
    token: 'tok',
    model: 'grok-imagine-image-2.0',
    prompt: '一只橙猫',
    fetchImpl,
  })
  assert.equal(edit, false)
  assert.equal(model, 'grok-imagine-image-2.0')
  assert.equal(last.url, 'http://127.0.0.1:8790/v1/images/generations')
  assert.match(last.init.headers.authorization, /Bearer tok/)
  const written = await writeImageItems({ cwd: dir, out: 'cat.png', items, fetchImpl })
  assert.equal(written.length, 1)
  assert.equal(written[0].rel, 'cat.png')
  assert.ok(fs.existsSync(path.join(dir, 'cat.png')))
})

test('callGatewayImages：有参考图走 edits；缺 prompt / 未登录失败', async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [{ b64_json: PNG_B64 }] }),
    url,
  })
  const r = await callGatewayImages({
    gatewayUrl: 'http://gw',
    token: 't',
    model: 'gpt-image-1',
    prompt: '改成夜晚',
    image: PNG_B64,
    fetchImpl,
  })
  assert.equal(r.edit, true)
  await assert.rejects(() => callGatewayImages({ gatewayUrl: 'http://gw', token: 't', model: 'x', prompt: '  ', fetchImpl }), /prompt/)
  await assert.rejects(() => callGatewayImages({ gatewayUrl: 'http://gw', token: '', model: 'x', prompt: 'a', fetchImpl }), /未登录/)
})

test('desk-host 暴露 deskHost；profile 插入 desk-image；设置页与输入框有生图入口', () => {
  const host = fs.readFileSync(path.join(repo, 'plugins/desk-host/lib/index.js'), 'utf8')
  const image = fs.readFileSync(path.join(repo, 'plugins/desk-image/lib/index.js'), 'utf8')
  const patch = fs.readFileSync(path.join(repo, 'profile/cordis.patch.yml'), 'utf8')
  const ui = fs.readFileSync(path.join(repo, 'plugins/desk-ui/src/client/index.jsx'), 'utf8')
  const api = fs.readFileSync(path.join(repo, 'plugins/desk-ui/src/client/api.js'), 'utf8')
  const boot = fs.readFileSync(path.join(repo, 'scripts/lib/bootstrap.mjs'), 'utf8')
  assert.match(host, /ctx\.provide\('deskHost'/)
  assert.match(image, /name: 'image_generate'/)
  assert.match(image, /name: 'image_edit'/)
  assert.match(image, /\/v1\/images\//)
  assert.match(patch, /id: desk-image/)
  assert.match(patch, /@company-desk\/desk-image/)
  assert.match(ui, /desk-image/)
  assert.match(ui, /ImageGenSection/)
  assert.match(api, /image:\s*\{/)
  assert.match(boot, /desk-image/)
})
