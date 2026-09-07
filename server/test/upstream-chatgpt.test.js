/**
 * ChatGPT Codex 上游：OpenAI chat/completions ↔ Responses（不打公网）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { LlmProxy } from '../src/llm-proxy.js'
import {
  chatgptHeaders,
  chatgptResponsesUrl,
  createCodexSseTranslator,
  inferUpstreamApi,
  textFromCodexOutput,
  toCodexResponsesBody,
  toOpenAIFromCodex,
  usesChatgptCodex,
} from '../src/upstream-chatgpt.js'

const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }]
const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"中文.md"}' }
const sse = (event) => `data: ${JSON.stringify(event)}\r\n\r\n`
const done = (output) => ({ type: 'response.completed', response: { output, usage: { input_tokens: 3, output_tokens: 4 } } })

test('工具定义、选择策略、调用历史与执行结果完整转换，保留调用顺序', () => {
  const body = toCodexResponsesBody({ tools, tool_choice: 'required', parallel_tool_calls: true, messages: [
    { role: 'developer', content: 'Use tools' },
    { role: 'user', content: 'Read files' },
    { role: 'assistant', content: 'Reading', tool_calls: [{ id: call.call_id, type: 'function', function: { name: call.name, arguments: call.arguments } }] },
    { role: 'tool', tool_call_id: call.call_id, content: 'File contents' },
  ] })
  assert.equal(body.instructions, 'Use tools')
  assert.equal(body.tools[0].name, 'read_file')
  assert.deepEqual(body.tools[0].parameters, tools[0].function.parameters)
  assert.equal(body.tools[0].strict, false)
  assert.equal(body.tool_choice, 'required')
  assert.equal(body.parallel_tool_calls, true)
  assert.deepEqual(body.input.map((i) => i.type), ['message', 'message', 'function_call', 'function_call_output'])
  assert.equal(body.input[2].call_id, body.input[3].call_id)
  assert.equal(body.input[3].output, 'File contents')
  assert.equal(toCodexResponsesBody({ tools }).tool_choice, 'auto')
  assert.equal(toCodexResponsesBody({ tools, tool_choice: 'none' }).tool_choice, 'none')
  assert.deepEqual(toCodexResponsesBody({ tools, tool_choice: { type: 'function', function: { name: 'read_file' } } }).tool_choice, { type: 'function', name: 'read_file' })
})

test('流式工具参数按片段累加；done/completed 不重复，多个调用使用连续索引', () => {
  const t = createCodexSseTranslator({ model: 'gpt-6' })
  const second = { ...call, id: 'fc_2', call_id: 'call_2', arguments: '{}' }
  const events = [
    { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: call.id, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: call.id, delta: '"中文.md"}' },
    { type: 'response.function_call_arguments.done', output_index: 1, item_id: call.id, arguments: call.arguments },
    { type: 'response.output_item.done', output_index: 1, item: call },
    { type: 'response.output_item.added', output_index: 3, item: second },
    done([{ type: 'reasoning' }, call, { type: 'message', content: [] }, second]),
  ]
  const chunks = []
  // Arbitrary network boundaries, including inside event names and JSON strings.
  const wire = events.map(sse).join('')
  for (let i = 0; i < wire.length; i += 7) chunks.push(...t.push(wire.slice(i, i + 7)))
  chunks.push(...t.end())
  const parsed = chunks.filter((s) => !s.includes('[DONE]')).map((s) => JSON.parse(s.slice(6)))
  const reconstructed = []
  for (const chunk of parsed) for (const delta of chunk.choices[0]?.delta?.tool_calls ?? []) {
    const c = reconstructed[delta.index] ??= { arguments: '' }
    if (delta.id) c.id = delta.id
    c.arguments += delta.function?.arguments ?? ''
  }
  assert.deepEqual(reconstructed, [{ id: 'call_1', arguments: call.arguments }, { id: 'call_2', arguments: '{}' }])
  assert.equal(t.finishReason, 'tool_calls')
  assert.equal(t.message.tool_calls.length, 2)
  assert.equal(t.usage.total_tokens, 7)
  assert.deepEqual(t.end(), [])
})

test('仅完成事件也能恢复工具调用；工具执行结果可用于下一轮', () => {
  const t = createCodexSseTranslator()
  t.push(sse(done([call])).trimEnd())
  t.end()
  const result = toOpenAIFromCodex({ output: [call] }, 'gpt-6')
  assert.deepEqual(t.message, result.choices[0].message)
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
  const next = toCodexResponsesBody({ tools, messages: [t.message, { role: 'tool', tool_call_id: 'call_1', content: 'Read OK' }] })
  assert.equal(next.input[0].arguments, call.arguments)
  assert.equal(next.input[1].output, 'Read OK')
})

test('失败和断流不伪装成成功；incomplete 返回 length', () => {
  assert.throws(() => createCodexSseTranslator().end(), /before response completion/)
  assert.throws(() => createCodexSseTranslator().push(sse({ type: 'response.failed', response: { error: { message: 'quota exceeded' } } })), /quota exceeded/)
  const t = createCodexSseTranslator()
  t.push(sse({ type: 'response.incomplete', response: { status: 'incomplete', output: [] } }))
  t.end()
  assert.equal(t.finishReason, 'length')
})

test('真实代理的 stream=false 与 stream=true 都保留工具调用', async () => {
  for (const stream of [false, true]) {
    const records = []
    const proxy = new LlmProxy({ ledger: { record: (r) => records.push(r) } })
    const encoder = new TextEncoder()
    const wire = encoder.encode(sse(done([call])))
    proxy.fetchUpstream = async () => new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < wire.length; i += 3) controller.enqueue(wire.slice(i, i + 3))
      controller.close()
    } }))
    const res = new EventEmitter()
    let body = ''
    res.writeHead = () => {}
    res.write = (part) => { body += part }
    res.end = (part = '') => { body += part; res.writableEnded = true }
    await proxy.proxyChat({ id: 'test', username: 'test' }, { id: 'gpt-6', provider: 'chatgpt' }, { stream }, res, { api: 'chatgpt-codex' })
    if (stream) {
      assert.match(body, /"finish_reason":"tool_calls"/)
      assert.match(body, /中文.md/)
      assert.match(body, /\[DONE\]/)
    } else {
      const choice = JSON.parse(body).choices[0]
      assert.equal(choice.message.tool_calls[0].function.arguments, call.arguments)
      assert.equal(choice.finish_reason, 'tool_calls')
    }
    assert.equal(records[0].status, 'ok')
  }
})

test('infer / uses：Codex 后端走 chatgpt-codex', () => {
  assert.equal(inferUpstreamApi('https://chatgpt.com/backend-api/codex'), 'chatgpt-codex')
  assert.equal(inferUpstreamApi('https://chatgpt.com/backend-api/codex/'), 'chatgpt-codex')
  assert.equal(usesChatgptCodex({ api: 'chatgpt-codex', baseUrl: 'https://api.openai.com/v1' }), true)
  assert.equal(usesChatgptCodex({ api: 'openai-compatible', baseUrl: 'https://chatgpt.com/backend-api/codex' }), false)
  assert.equal(usesChatgptCodex({ baseUrl: 'https://chatgpt.com/backend-api/codex' }), true)
  assert.equal(chatgptResponsesUrl('https://chatgpt.com/backend-api/codex'), 'https://chatgpt.com/backend-api/codex/responses')
  assert.equal(chatgptResponsesUrl('https://chatgpt.com/backend-api/codex/responses'), 'https://chatgpt.com/backend-api/codex/responses')
})

test('chatgptHeaders：Bearer + 账号 id + originator，不要当成 API key', () => {
  const h = chatgptHeaders('tok', { accountId: 'acct-1' })
  assert.equal(h.authorization, 'Bearer tok')
  assert.equal(h['chatgpt-account-id'], 'acct-1')
  assert.equal(h.originator, 'codex_cli_rs')
  assert.equal(h['openai-beta'], 'responses=experimental')
  assert.equal(h['x-api-key'], undefined)
})

test('toCodexResponsesBody：OpenAI image_url 转成 input_image', () => {
  const body = toCodexResponsesBody(
    {
      model: 'gpt-5.5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,bbb' } },
          ],
        },
      ],
    },
    { upstreamModel: 'gpt-5.5' },
  )
  assert.equal(body.input[0].content[0].type, 'input_text')
  assert.equal(body.input[0].content[0].text, '看图')
  assert.deepEqual(body.input[0].content[1], { type: 'input_image', image_url: 'data:image/jpeg;base64,bbb' })
})

test('toCodexResponsesBody：system 进 instructions；禁止 temperature / max_tokens；强制 stream', () => {
  const body = toCodexResponsesBody(
    {
      model: 'gpt-5.5',
      messages: [
        { role: 'system', content: '简洁' },
        { role: 'user', content: '什么是熵' },
        { role: 'assistant', content: '无序程度' },
        { role: 'user', content: '再短一点' },
      ],
      temperature: 0.2,
      max_tokens: 128,
      stream: false,
      reasoning_effort: 'low',
    },
    { upstreamModel: 'gpt-5.5' },
  )
  assert.equal(body.model, 'gpt-5.5')
  assert.equal(body.instructions, '简洁')
  assert.equal(body.stream, true)
  assert.equal(body.store, false)
  assert.equal(body.temperature, undefined)
  assert.equal(body.max_tokens, undefined)
  assert.equal(body.max_output_tokens, undefined)
  assert.equal(body.input[0].type, 'message')
  assert.equal(body.input[0].role, 'user')
  assert.equal(body.input[0].content[0].type, 'input_text')
  assert.equal(body.input[1].content[0].type, 'output_text')
  assert.equal(body.reasoning.effort, 'low')
})

test('toOpenAIFromCodex：从 output[] 抽出文本与 usage', () => {
  const out = toOpenAIFromCodex(
    {
      id: 'resp_x',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex-ok' }] }],
      usage: { input_tokens: 9, output_tokens: 3 },
    },
    'gpt-5.5',
  )
  assert.equal(out.choices[0].message.content, 'codex-ok')
  assert.equal(out.usage.prompt_tokens, 9)
  assert.equal(out.usage.completion_tokens, 3)
  assert.equal(textFromCodexOutput([{ type: 'message', content: [{ type: 'output_text', text: 'codex-ok' }] }]), 'codex-ok')
})

test('Codex SSE → OpenAI chunk（含 usage）', () => {
  const t = createCodexSseTranslator({ id: 'chatcmpl-x', model: 'gpt-5.5', created: 1 })
  const a = t.push('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"codex-ok"}\n\n')
  assert.match(a.join(''), /codex-ok/)
  const b = t.push('data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2}}}\n\n')
  void b
  const end = t.end()
  assert.match(end.join(''), /\[DONE\]/)
  assert.equal(t.usage.prompt_tokens, 4)
  assert.equal(t.usage.completion_tokens, 2)
  assert.equal(t.text, 'codex-ok')
})
