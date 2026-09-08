/**
 * DashScope（阿里云百炼）出图：OpenAI /images/* ↔ 原生 multimodal-generation / text2image。
 * 用本地假 DashScope 验证，不打公网。
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
let mode
let gw
let base
let token
let taskPolls
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-dashscope-img-'))

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')

before(async () => {
  calls = []
  mode = 'sync'
  taskPolls = 0
  fake = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      calls.push({ url: req.url, method: req.method, headers: req.headers, body })
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (req.url === '/out.png') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(PNG)
        return
      }
      if (req.url === '/api/v1/services/aigc/multimodal-generation/generation') {
        if (mode === 'task') {
          send(400, { code: 'UnsupportedModel', message: 'model not supported on multimodal-generation' })
          return
        }
        send(200, {
          output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ image: `${fakeUrl}/out.png` }] } }] },
          usage: { input_tokens: 12, output_tokens: 4096 },
          request_id: 'req-1',
        })
        return
      }
      if (req.url === '/api/v1/services/aigc/text2image/image-synthesis') {
        send(200, { output: { task_id: 'task-1', task_status: 'PENDING' }, request_id: 'req-2' })
        return
      }
      if (req.url === '/api/v1/tasks/task-1') {
        taskPolls++
        if (taskPolls < 2) {
          send(200, { output: { task_id: 'task-1', task_status: 'RUNNING' } })
          return
        }
        send(200, { output: { task_id: 'task-1', task_status: 'SUCCEEDED', results: [{ url: `${fakeUrl}/out.png` }] } })
        return
      }
      res.writeHead(404)
      res.end('no')
    })
  })
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
  fakeUrl = `http://127.0.0.1:${fake.address().port}`
  process.env.DESK_DASHSCOPE_POLL_MS = '10'
  gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: tmp,
    seedUsers: [],
    upstreams: {
      dashscope: {
        kind: 'openai-compatible',
        api: 'dashscope-images',
        label: '千问生图',
        baseUrl: `${fakeUrl}/compatible-mode/v1`,
        apiKey: 'dashscope-test',
        models: [{ id: 'qwen-image-3.0', name: 'Qwen Image 3.0' }],
      },
    },
    channels: [],
    defaultModel: 'qwen-image-3.0',
    quickInference: { defaultModel: 'qwen-image-3.0' },
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
  delete process.env.DESK_DASHSCOPE_POLL_MS
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

test('qwen-image 走同步 multimodal-generation，回 b64_json', async () => {
  mode = 'sync'
  const r = await post('/v1/images/generations', { model: 'qwen-image-3.0', prompt: '一只橘猫', aspect_ratio: '16:9' })
  assert.equal(r.status, 200)
  const json = await r.json()
  assert.equal(json.data[0].b64_json, PNG_B64)
  assert.equal(json.usage.prompt_tokens, 12)
  const call = calls.find((c) => c.url === '/api/v1/services/aigc/multimodal-generation/generation')
  assert.equal(call.headers.authorization, 'Bearer dashscope-test')
  assert.equal(call.body.model, 'qwen-image-3.0')
  assert.equal(call.body.input.messages[0].content.at(-1).text, '一只橘猫')
  assert.equal(call.body.parameters.size, '1664*928')
})

test('multimodal 不支持时退回异步 text2image + 轮询任务', async () => {
  mode = 'task'
  taskPolls = 0
  const r = await post('/v1/images/generations', { model: 'qwen-image-3.0', prompt: 'wanx 风格', aspect_ratio: '1:1' })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).data[0].b64_json, PNG_B64)
  const async = calls.filter((c) => c.url === '/api/v1/services/aigc/text2image/image-synthesis').at(-1)
  assert.equal(async.headers['x-dashscope-async'], 'enable')
  assert.equal(async.body.parameters.size, '1328*1328')
  assert.ok(taskPolls >= 2)
  mode = 'sync'
})

test('修图：参考图进 input.messages content 的 image 字段', async () => {
  mode = 'sync'
  const r = await post('/v1/images/edits', { model: 'qwen-image-3.0', prompt: '改成夜晚', image: PNG_B64 })
  assert.equal(r.status, 200)
  const parts = calls.filter((c) => c.url === '/api/v1/services/aigc/multimodal-generation/generation').at(-1).body.input.messages[0].content
  assert.equal(parts[0].image, `data:image/png;base64,${PNG_B64}`)
  assert.equal(parts[1].text, '改成夜晚')
})
