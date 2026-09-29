/**
 * 单账号（apiKey，无 accounts）上游的流式转发不能被“配额窥探”整段缓冲。
 *
 * 回归：fetchUpstream 曾在成功响应上 await res.clone().text() 来判定配额耗尽。clone 会 tee
 * 出第二条流，在读原流之前先等克隆读完整段 SSE，会让客户端只在生成结束时一次性收到全部
 * chunk —— 会话统计的解码时间塌成 0，TPS 被放大到不可能的值（Grok 显示 11 万 tok/s）。
 * 本用例断言单账号路径下 chunk 仍随时间逐个到达。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../src/index.js'

const CHUNKS = 6
const GAP_MS = 80
let fake
let gw
let base
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-stream-'))

before(async () => {
  fake = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (!String(req.url).endsWith('/chat/completions')) {
        res.writeHead(404)
        res.end('no')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let i = 0
      const send = () => {
        i++
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'w' + i } }] })}\n\n`)
        if (i >= CHUNKS) {
          res.write(`data: ${JSON.stringify({ id: 'x', choices: [], usage: { prompt_tokens: 3, completion_tokens: CHUNKS, total_tokens: 3 + CHUNKS } })}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        setTimeout(send, GAP_MS)
      }
      send()
    })
  })
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
  gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: tmp,
    seedUsers: [],
    upstreams: {
      single: {
        kind: 'openai-compatible',
        label: 'Single',
        baseUrl: `http://127.0.0.1:${fake.address().port}/v1`,
        apiKey: 'sk-single',
        models: [{ id: 'single-model', name: 'Single', priceCnyPerM: { input: 1, output: 2, cachedInput: 0 } }],
      },
    },
    channels: [],
    defaultModel: 'single-model',
    quickInference: { defaultModel: 'single-model' },
    fetchReleases: async () => [],
  })
  base = await gw.listen()
})

after(async () => {
  await gw.close()
  await new Promise((resolve) => fake.close(resolve))
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('单账号上游：流式转发逐个到达，未被整段缓冲', async () => {
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'boss123456', device: 'test' }),
  })
  const { gatewayToken } = await login.json()
  const started = Date.now()
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${gatewayToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'single-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/)

  const reader = r.body.getReader()
  const times = []
  for (;;) {
    const { done } = await reader.read()
    if (done) break
    times.push(Date.now() - started)
  }

  const span = times.at(-1) - times[0]
  assert.ok(times.length >= 2, `expect multiple reads, got ${times.length}`)
  // 缓冲时 span ≈ 0；逐个到达时 span 应接近上游 CHUNKS*GAP_MS（≈480ms）。
  assert.ok(span >= GAP_MS * (CHUNKS - 2), `stream was buffered: span=${span}ms times=${times.join(',')}`)
})
