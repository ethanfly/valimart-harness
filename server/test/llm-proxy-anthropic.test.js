/**
 * 用本地假 Anthropic /messages 验证代理改写与流式转译（不打公网）。
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-anth-'))

before(async () => {
  fake = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      last = { url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') }
      if (req.url !== '/v1/messages') {
        res.writeHead(404)
        res.end('no')
        return
      }
      if (last.body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","usage":{"input_tokens":4}}}\n\n')
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"claude-ok"}}\n\n')
        res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n')
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'msg_x',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'claude-ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 4, output_tokens: 2 },
      }))
    })
  })
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
  const addr = fake.address()
  fakeUrl = `http://127.0.0.1:${addr.port}/v1`
  gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: tmp,
    seedUsers: [],
    upstreams: {
      anthropic: {
        kind: 'openai-compatible',
        api: 'anthropic-messages',
        label: 'Anthropic',
        baseUrl: fakeUrl,
        apiKey: 'sk-ant-test',
        models: [{ id: 'claude-test', name: 'Claude Test', priceCnyPerM: { input: 1, output: 2, cachedInput: 0 } }],
      },
    },
    channels: [],
    defaultModel: 'claude-test',
    quickInference: { defaultModel: 'claude-test' },
    fetchReleases: async () => [],
  })
  base = await gw.listen()
})

after(async () => {
  await gw.close()
  await new Promise((resolve) => fake.close(resolve))
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('Anthropic：非流式改写为 /messages + x-api-key，响应转成 OpenAI 形状', async () => {
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'boss123456', device: 'test' }),
  })
  const { gatewayToken } = await login.json()
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${gatewayToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-test', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], stream: false }),
  })
  assert.equal(r.status, 200)
  const json = await r.json()
  assert.equal(json.choices[0].message.content, 'claude-ok')
  assert.equal(json.usage.prompt_tokens, 4)
  assert.equal(last.url, '/v1/messages')
  assert.equal(last.headers['x-api-key'], 'sk-ant-test')
  assert.ok(!last.headers.authorization)
  assert.equal(last.body.system, 'sys')
  assert.equal(last.body.messages[0].role, 'user')
})

test('Anthropic：流式事件转成 OpenAI chunk', async () => {
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'boss123456', device: 'test' }),
  })
  const { gatewayToken } = await login.json()
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${gatewayToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-test', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  })
  assert.equal(r.status, 200)
  const text = await r.text()
  assert.match(text, /claude-ok/)
  assert.match(text, /data: \[DONE\]/)
  assert.equal(last.body.stream, true)
})
