/**
 * ChatGPT Codex 上游：OpenAI chat/completions ↔ Responses（不打公网）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
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
