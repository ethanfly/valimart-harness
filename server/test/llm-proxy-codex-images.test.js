/**
 * ChatGPT 订阅（Codex）出图：上游没有 /images/*，网关用 Responses 的 image_generation 工具，
 * 再把结果包成 OpenAI /images 形状。用本地假 Codex 验证，不打公网。
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
let calls
let gw
let base
let token
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-codex-img-'))

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const sse = (payload) => [
  'event: response.output_item.done',
  `data: ${JSON.stringify({ type: 'response.output_item.done', item: payload })}`,
  '',
  'event: response.completed',
  `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 } } })}`,
  '',
  '',
].join('\n')

before(async () => {
  calls = []
  fake = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      calls.push({ url: req.url, method: req.method, headers: req.headers, body: JSON.parse(raw || '{}') })
      if (req.url !== '/responses') {
        res.writeHead(404)
        res.end('no')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse({
        id: 'ig_test',
        type: 'image_generation_call',
        status: 'completed',
        result: PNG_B64,
        revised_prompt: 'revised prompt',
        size: '1024x1024',
        output_format: 'png',
      }))
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
      chatgpt: {
        kind: 'openai-compatible',
        api: 'chatgpt-codex',
        label: 'ChatGPT',
        baseUrl: fakeUrl,
        apiKey: 'codex-test',
        models: [
          { id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol' },
          { id: 'gpt-image-2.0', name: 'GPT Image 2.0' },
        ],
      },
    },
    channels: [],
    defaultModel: 'gpt-5.6-sol',
    quickInference: { defaultModel: 'gpt-5.6-sol' },
    fetchReleases: async () => [],
  })
  base = await gw.listen()
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'boss123456', device: 'test' }),
  })
  token = (await login.json()).gatewayToken
})

after(async () => {
  await gw.close()
  await new Promise((resolve) => fake.close(resolve))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const post = (p, body) =>
  fetch(base + p, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

test('订阅通道 /v1/images/generations 走 image_generation 工具，回 b64_json', async () => {
  const r = await post('/v1/images/generations', { model: 'gpt-image-2.0', prompt: 'a red square icon', aspect_ratio: '16:9' })
  assert.equal(r.status, 200)
  const json = await r.json()
  assert.equal(json.data[0].b64_json, PNG_B64)
  assert.equal(json.data[0].revised_prompt, 'revised prompt')
  assert.equal(json.usage.prompt_tokens, 11)
  const call = calls.at(-1)
  assert.equal(call.url, '/responses')
  assert.equal(call.headers.originator, 'codex_cli_rs')
  assert.equal(call.body.model, 'gpt-5.6-sol') // 用通道里的对话模型驱动
  assert.equal(call.body.tools[0].type, 'image_generation')
  assert.equal(call.body.tools[0].size, '1536x1024') // aspect_ratio 映射成 size
  assert.equal(call.body.input[0].content.at(-1).text, 'a red square icon')
})

test('n=2 逐张生成；/v1/images/edits 把参考图带进 input_image', async () => {
  const before1 = calls.length
  const two = await post('/v1/images/generations', { model: 'gpt-image-2.0', prompt: 'two icons', n: 2 })
  assert.equal(two.status, 200)
  assert.equal((await two.json()).data.length, 2)
  assert.equal(calls.length - before1, 2)

  const edit = await post('/v1/images/edits', { model: 'gpt-image-2.0', prompt: 'make it blue', image: PNG_B64 })
  assert.equal(edit.status, 200)
  const parts = calls.at(-1).body.input[0].content
  assert.equal(parts[0].type, 'input_image')
  assert.ok(parts[0].image_url.startsWith('data:image/png;base64,'))
})

test('订阅通道仍不支持视频接口', async () => {
  const r = await post('/v1/videos/generations', { model: 'gpt-image-2.0', prompt: 'x' })
  assert.equal(r.status, 400)
  assert.match(await r.text(), /不支持媒体接口/)
})