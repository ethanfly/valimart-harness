/**
 * 用本地假 OpenAI /images 验证网关生图 / 修图代理（不打公网）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../src/index.js'

let fake
let fakeUrl
let last
let gw
let base
let token
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-img-'))

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

before(async () => {
  fake = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      last = { url: req.url, method: req.method, headers: req.headers, body: JSON.parse(raw || '{}') }
      const route = req.url.replace(/^\/v1/, '')
      if (route === '/images/generations' || route === '/images/edits') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          created: 1,
          data: [{ b64_json: PNG_B64, revised_prompt: last.body.prompt }],
          usage: { prompt_tokens: 8, completion_tokens: 1000, total_tokens: 1008 },
        }))
        return
      }
      res.writeHead(404)
      res.end('no')
    })
  })
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
  fakeUrl = `http://127.0.0.1:${fake.address().port}`
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
        models: [{ id: 'grok-imagine-image-2.0', name: 'Grok Imagine Image 2.0', priceCnyPerM: { input: 1, output: 2, cachedInput: 0 } }],
      },
    },
    channels: [],
    defaultModel: 'grok-imagine-image-2.0',
    quickInference: { defaultModel: 'grok-imagine-image-2.0' },
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

test('POST /v1/images/generations 转发上游并记账', async () => {
  const r = await fetch(base + '/v1/images/generations', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'grok-imagine-image-2.0', prompt: 'a red square icon, flat, no text', aspect_ratio: '1:1' }),
  })
  assert.equal(r.status, 200)
  const json = await r.json()
  assert.equal(json.data[0].b64_json, PNG_B64)
  assert.equal(last.url.replace(/^\/v1/, ''), '/images/generations')
  assert.equal(last.body.model, 'grok-imagine-image-2.0')
  assert.equal(last.body.prompt, 'a red square icon, flat, no text')
  assert.equal(last.body.response_format, 'b64_json')
  assert.equal(last.headers.authorization, 'Bearer xai-test')
})

test('POST /v1/images/edits 需要参考图并转发 /images/edits', async () => {
  const missing = await fetch(base + '/v1/images/edits', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'grok-imagine-image-2.0', prompt: 'make it blue' }),
  })
  assert.equal(missing.status, 400)
  const r = await fetch(base + '/v1/images/edits', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'grok-imagine-image-2.0', prompt: 'make it blue', image: PNG_B64 }),
  })
  assert.equal(r.status, 200)
  assert.equal(last.url.replace(/^\/v1/, ''), '/images/edits')
  assert.equal(last.body.image, PNG_B64)
})

test('未指定 model 时默认 grok-imagine-image-2.0', async () => {
  const r = await fetch(base + '/v1/images/generations', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'tiny red square icon, flat, no text' }),
  })
  assert.equal(r.status, 200)
  assert.equal(last.body.model, 'grok-imagine-image-2.0')
})

test('缺 prompt 返回 400；未知模型 404', async () => {
  const noPrompt = await fetch(base + '/v1/images/generations', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'grok-imagine-image-2.0' }),
  })
  assert.equal(noPrompt.status, 400)
  const unknown = await fetch(base + '/v1/images/generations', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nope', prompt: 'x' }),
  })
  assert.equal(unknown.status, 404)
})
