import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  anthropicMessagesUrl,
  createAnthropicSseTranslator,
  inferUpstreamApi,
  toAnthropicBody,
  toAnthropicMessages,
  toOpenAIResponse,
  usesAnthropicMessages,
} from '../src/upstream-anthropic.js'

test('infer / uses：官方 Anthropic 走 messages，其它走 OpenAI 兼容', () => {
  assert.equal(inferUpstreamApi('https://api.anthropic.com/v1'), 'anthropic-messages')
  assert.equal(inferUpstreamApi('https://api.openai.com/v1'), 'openai-compatible')
  assert.equal(usesAnthropicMessages({ api: 'anthropic-messages', baseUrl: 'https://proxy.example/v1' }), true)
  assert.equal(usesAnthropicMessages({ api: 'openai-compatible', baseUrl: 'https://api.anthropic.com/v1' }), false)
  assert.equal(usesAnthropicMessages({ baseUrl: 'https://api.anthropic.com/v1' }), true)
  assert.equal(anthropicMessagesUrl('https://api.anthropic.com/v1/'), 'https://api.anthropic.com/v1/messages')
  assert.equal(anthropicMessagesUrl('https://api.anthropic.com/v1/messages'), 'https://api.anthropic.com/v1/messages')
})

test('toAnthropicMessages：抽出 system、合并连续同角色、保证 user 开头', () => {
  const { system, messages } = toAnthropicMessages([
    { role: 'system', content: '你是公司助手' },
    { role: 'assistant', content: '先说一句' },
    { role: 'user', content: '任务卡怎么交' },
    { role: 'user', content: '再补一句' },
  ])
  assert.equal(system, '你是公司助手')
  assert.equal(messages[0].role, 'user')
  assert.equal(messages.at(-1).content, '任务卡怎么交\n再补一句')
})

test('toAnthropicBody / toOpenAIResponse 往返字段', () => {
  const body = toAnthropicBody(
    { model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hi' }], max_tokens: 128, stream: false },
    { upstreamModel: 'claude-opus-4-6', maxTokens: 4096 },
  )
  assert.equal(body.model, 'claude-opus-4-6')
  assert.equal(body.max_tokens, 128)
  assert.equal(body.stream, false)
  const openai = toOpenAIResponse(
    {
      id: 'msg_1',
      content: [{ type: 'text', text: '你好' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 9, output_tokens: 3 },
    },
    'claude-opus-4-6',
  )
  assert.equal(openai.choices[0].message.content, '你好')
  assert.equal(openai.usage.prompt_tokens, 9)
  assert.equal(openai.usage.completion_tokens, 3)
  assert.equal(openai.object, 'chat.completion')
})

test('Anthropic SSE → OpenAI chunk（含 usage）', () => {
  const t = createAnthropicSseTranslator({ id: 'chatcmpl-x', model: 'claude-opus-4-6', created: 1 })
  const out = [
    ...t.push('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11}}}\n\n'),
    ...t.push('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}\n\n'),
    ...t.push('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n'),
    ...t.end(),
  ].join('')
  assert.match(out, /"role":"assistant"/)
  assert.match(out, /"content":"你好"/)
  assert.match(out, /"finish_reason":"stop"/)
  assert.match(out, /"prompt_tokens":11/)
  assert.match(out, /"completion_tokens":2/)
  assert.match(out, /data: \[DONE\]/)
})
