/**
 * 用本地假上游验证网关视频生成代理（不打公网）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../src/index.js'

let fake
let last
let gw
let base
let token
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-vid-'))

before(async () => {
  fake = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      last = { url: req.url, method: req.method, headers: req.headers, body: JSON.parse(raw || '{}') }
      if (req.url === '/videos/generations' || req.url === '/v1/videos/generations') {
        const asyncJob = last.body.prompt === 'async'
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(asyncJob
          ? { request_id: 'req-1' }
          : { created: 1, data: [{ url: 'https://cdn.example/clip.mp4', revised_prompt: last.body.prompt }], usage: { prompt_tokens: 8, completion_tokens: 4000, total_tokens: 4008 } }))
        return
      }
      if (req.url === '/v1/videos/req-1') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'done', video: { url: 'https://cdn.example/async.mp4' } }))
        return
      }
      res.writeHead(404)
      res.end('no')
    })
  })
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
  const fakeUrl = 'http://127.0.0.1:' + fake.address().port
  gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: tmp,
    seedUsers: [],
    upstreams: {
      grok: {
        kind: 'openai-compatible',
        label: 'Grok',
        baseUrl: fakeUrl,
        apiKey: 'xai-test',
        models: [
          { id: 'grok-imagine-image-2.0', name: 'Grok Imagine Image 2.0', priceCnyPerM: { input: 1, output: 2, cachedInput: 0 } },
          { id: 'grok-imagine-video-1.5', name: 'Grok Imagine Video 1.5', priceCnyPerM: { input: 1, output: 2, cachedInput: 0 } },
        ],
      },
    },
    channels: [],
    defaultModel: 'grok-imagine-video-1.5',
    quickInference: { defaultModel: 'grok-imagine-video-1.5' },
    fetchReleases: async () => [],
  })
  base = await gw.listen()
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'boss123456', device: 'test' }),
  })
  const json = await login.json()
  token = json.gatewayToken
})

after(async () => {
  await gw.close()
  await new Promise((resolve) => fake.close(resolve))
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('POST /v1/videos/generations 转发上游并记账', async () => {
  const r = await fetch(base + '/v1/videos/generations', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-imagine-video-1.5',
      prompt: 'an orange cat walks across a sunlit windowsill, slow camera push-in',
      duration: 6,
      aspect_ratio: '16:9',
    }),
  })
  assert.equal(r.status, 200)
  const json = await r.json()
  assert.equal(json.data[0].url, 'https://cdn.example/clip.mp4')
  assert.equal(last.url.replace(/^\/v1/, ''), '/videos/generations')
  assert.equal(last.body.model, 'grok-imagine-video-1.5')
  assert.equal(last.body.duration, 6)
  assert.equal(last.headers.authorization, 'Bearer xai-test')
})

test('未指定 model 时默认 grok-imagine-video-1.5', async () => {
  const r = await fetch(base + '/v1/videos/generations', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'a slow orbit around a red apple on a table' }),
  })
  assert.equal(r.status, 200)
  assert.equal(last.body.model, 'grok-imagine-video-1.5')
  assert.equal(last.body.duration, 6)
  assert.equal(last.body.aspect_ratio, '16:9')
})

test('xAI 只回 request_id 时轮询到 video.url', async () => {
  const prev = process.env.DESK_VIDEO_POLL_MS
  process.env.DESK_VIDEO_POLL_MS = '1'
  try {
    const r = await fetch(base + '/v1/videos/generations', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'grok-imagine-video-1.5', prompt: 'async' }),
    })
    assert.equal(r.status, 200)
    assert.equal((await r.json()).data[0].url, 'https://cdn.example/async.mp4')
    assert.equal(last.url, '/v1/videos/req-1')
  } finally {
    if (prev == null) delete process.env.DESK_VIDEO_POLL_MS
    else process.env.DESK_VIDEO_POLL_MS = prev
  }
})

test('裸 base64 参考图包成 data URI，多张走 reference_images', async () => {
  const r = await fetch(base + '/v1/videos/generations', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'grok-imagine-video-1.5', prompt: '猫动起来', image: 'QUFB', images: ['QUFB', 'QkJC'] }),
  })
  assert.equal(r.status, 200)
  assert.deepEqual(last.body.image, { url: 'data:image/png;base64,QUFB' })
  assert.equal(last.body.images, undefined)
  assert.deepEqual(last.body.reference_images, [
    { image_url: 'data:image/png;base64,QUFB' },
    { image_url: 'data:image/png;base64,QkJC' },
  ])
})

test('缺 prompt 返回 400；未知模型 404', async () => {
  const noPrompt = await fetch(base + '/v1/videos/generations', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'grok-imagine-video-1.5' }),
  })
  assert.equal(noPrompt.status, 400)
  const unknown = await fetch(base + '/v1/videos/generations', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nope', prompt: 'x' }),
  })
  assert.equal(unknown.status, 404)
})
