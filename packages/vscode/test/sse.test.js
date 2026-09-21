import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSseBlock, createChatAccumulator, consumeOpenAiSse, jsonToCompletion } from '../src/lib/sse.js'
import { TokenStore } from '../src/lib/token-store.js'
import { GatewayClient } from '../src/lib/gateway-client.js'
import { runAgentLoop } from '../src/lib/agent-loop.js'
import { createWorkspaceTools } from '../src/lib/workspace-fs.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

test('parseSseBlock 识别 DONE 与 JSON 块', () => {
  assert.equal(parseSseBlock('data: [DONE]'), '[DONE]')
  const ev = parseSseBlock('data: {"choices":[{"delta":{"content":"hi"}}]}')
  assert.equal(ev.choices[0].delta.content, 'hi')
  assert.equal(parseSseBlock('event: ping\n'), null)
})

test('accumulator 拼 content / reasoning / tool_calls', () => {
  const acc = createChatAccumulator()
  acc.applyEvent({ choices: [{ delta: { content: '你' } }] })
  acc.applyEvent({ choices: [{ delta: { content: '好' }, finish_reason: null }] })
  acc.applyEvent({ choices: [{ delta: { reasoning_content: '想' } }] })
  acc.applyEvent({
    choices: [{
      delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"p' } }] },
    }],
  })
  acc.applyEvent({
    choices: [{
      delta: { tool_calls: [{ index: 0, function: { arguments: 'ath":"."}' } }] },
      finish_reason: 'tool_calls',
    }],
  })
  const done = acc.finish()
  assert.equal(done.message.content, '你好')
  assert.equal(done.message.reasoning_content, '想')
  assert.equal(done.message.tool_calls[0].function.name, 'read_file')
  assert.equal(done.message.tool_calls[0].function.arguments, '{"path":"."}')
  assert.equal(done.finishReason, 'tool_calls')
})

test('json 回退也会触发 onDelta', () => {
  const seen = []
  const json = jsonToCompletion({
    choices: [{ message: { role: 'assistant', content: '整段' }, finish_reason: 'stop' }],
  }, { onDelta: (d) => seen.push(d.text) })
  assert.equal(json.choices[0].message.content, '整段')
  assert.deepEqual(seen, ['整段'])
})

test('GatewayClient 消费 SSE 并允许中途取消', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.write('data: {"choices":[{"delta":{"content":"一"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{"content":"二"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-sse-'))
  const store = new TokenStore(dir)
  store.setLogin({ gatewayUrl: `http://127.0.0.1:${port}`, sessionToken: 's', gatewayToken: 'g', user: {}, company: {} })
  const deltas = []
  const client = new GatewayClient(store)
  const json = await client.chatCompletions({ model: 'm', messages: [] }, { onDelta: (d) => deltas.push(d.text) })
  assert.equal(json.choices[0].message.content, '一二')
  assert.ok(deltas.includes('一'))
  assert.ok(deltas.at(-1).includes('二'))
  await new Promise((r) => server.close(r))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('consumeOpenAiSse 读完整 body', async () => {
  const payload = [
    'data: {"choices":[{"delta":{"content":"x"}}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  const res = new Response(payload, { headers: { 'content-type': 'text/event-stream' } })
  const json = await consumeOpenAiSse(res)
  assert.equal(json.choices[0].message.content, 'x')
})

test('runAgentLoop 点停止会留下可见收尾而不是抛错', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-cancel-'))
  const ac = new AbortController()
  const client = {
    async chatCompletions(_body, { signal } = {}) {
      ac.abort()
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
        if (signal?.aborted) {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        }
      })
    },
  }
  const result = await runAgentLoop({
    client,
    tools: createWorkspaceTools({ workspaceRoot: root }),
    model: 'mock-echo',
    userMessage: 'go',
    signal: ac.signal,
  })
  assert.equal(result.stopReason, 'cancelled')
  assert.match(result.text, /已停止生成/)
  fs.rmSync(root, { recursive: true, force: true })
})
