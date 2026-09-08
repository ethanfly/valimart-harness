import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGeminiSseTranslator, fromGeminiResponse, sendGeminiRequest, setupGeminiProject, toGeminiBody } from '../src/upstream-gemini.js'

const model = { id: 'gemini-test', upstreamModel: 'gemini-3.1-pro-preview', maxTokens: 4096 }
const wrap = (parts, finishReason, usageMetadata) => ({ response: { candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }], ...(usageMetadata ? { usageMetadata } : {}) } })
const event = (data) => `data: ${JSON.stringify(data)}\r\n\r\n`

test('Gemini：系统指令、图片、JSON schema 和工具选择正确转换', () => {
  const r = toGeminiBody({ messages: [
    { role: 'system', content: '规则' }, { role: 'developer', content: '补充' },
    { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] },
  ], tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }],
  tool_choice: { type: 'function', function: { name: 'lookup' } }, max_tokens: 100, temperature: 0,
  reasoning_effort: 'low', response_format: { type: 'json_schema', json_schema: { schema: { type: 'object' } } },
  }, model, 'project-one')
  assert.equal(r.project, 'project-one')
  assert.equal(r.model, model.upstreamModel)
  assert.equal(r.enabled_credit_types, undefined)
  assert.equal(r.request.systemInstruction.parts.length, 2)
  assert.deepEqual(r.request.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'YQ==' } })
  assert.equal(r.request.generationConfig.maxOutputTokens, 100)
  assert.equal(r.request.generationConfig.temperature, 0)
  assert.equal(r.request.generationConfig.responseMimeType, 'application/json')
  assert.equal(r.request.generationConfig.thinkingConfig.thinkingLevel, 'LOW')
  assert.deepEqual(r.request.toolConfig.functionCallingConfig, { mode: 'ANY', allowedFunctionNames: ['lookup'] })
  assert.equal(r.request.tools[0].functionDeclarations[0].parametersJsonSchema.type, 'object')
  assert.throws(() => toGeminiBody({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://127.0.0.1/private' } }] }] }, model, 'p'), /base64/)
})

test('Gemini：工具调用签名穿过 OpenAI tool id 往返，连续工具结果合并', () => {
  const reply = fromGeminiResponse(wrap([
    { functionCall: { name: 'lookup', args: { q: 'a' } }, thoughtSignature: 'opaque-signature+/=' },
    { functionCall: { name: 'lookup', args: { q: 'b' } } },
  ], 'STOP'), model.id)
  const msg = reply.choices[0].message
  assert.equal(reply.choices[0].finish_reason, 'tool_calls')
  assert.equal(msg.tool_calls[0].index, undefined)
  const r = toGeminiBody({ messages: [
    { role: 'user', content: '查询' }, msg,
    ...msg.tool_calls.map((call) => ({ role: 'tool', tool_call_id: call.id, content: '{"ok":true}' })),
  ] }, model, 'p')
  assert.equal(r.request.contents[1].parts[0].thoughtSignature, 'opaque-signature+/=')
  assert.deepEqual(r.request.contents[1].parts[0].functionCall.args, { q: 'a' })
  assert.equal(r.request.contents[2].parts.length, 2)
  assert.deepEqual(r.request.contents[2].parts[0].functionResponse, { name: 'lookup', response: { output: { ok: true } } })
  assert.throws(() => toGeminiBody({ messages: [{ role: 'tool', tool_call_id: 'missing', content: 'x' }] }, model, 'p'), /对应/)
})

test('Gemini：流式半包、CRLF、中文、思考和工具调用及末尾用量', () => {
  const t = createGeminiSseTranslator({ model: model.id })
  const raw = event(wrap([{ text: '思考', thought: true }])) + event(wrap([{ text: '你好' }])) + event(wrap([{ functionCall: { name: 'lookup', args: { q: '中文' } }, thoughtSignature: 'sig' }], 'STOP')) + event({ response: { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, thoughtsTokenCount: 3, totalTokenCount: 19, cachedContentTokenCount: 5 } } })
  const pieces = []
  for (const char of raw) pieces.push(...t.push(char))
  pieces.push(...t.end())
  const chunks = pieces.filter((p) => !p.includes('[DONE]')).map((p) => JSON.parse(p.slice(6)))
  assert.equal(chunks[1].choices[0].delta.reasoning_content, '思考')
  assert.equal(chunks[2].choices[0].delta.content, '你好')
  assert.equal(chunks[3].choices[0].delta.tool_calls[0].function.arguments, '{"q":"中文"}')
  assert.equal(chunks[4].choices[0].finish_reason, 'tool_calls')
  assert.equal(chunks.at(-1).usage.completion_tokens, 7)
  assert.equal(t.usage.prompt_tokens_details.cached_tokens, 5)
  assert.equal(pieces.at(-1), 'data: [DONE]\n\n')
  assert.deepEqual(t.end(), [])
})

test('Gemini：拦截、截断和服务端错误不能伪装成成功', () => {
  assert.equal(fromGeminiResponse({ response: { promptFeedback: { blockReason: 'SAFETY' } } }, model.id).choices[0].finish_reason, 'content_filter')
  assert.equal(fromGeminiResponse(wrap([{ text: '半句' }], 'MAX_TOKENS'), model.id).choices[0].finish_reason, 'length')
  const t = createGeminiSseTranslator({ model: model.id })
  t.push(event(wrap([{ text: '半句' }])))
  assert.throws(() => t.end(), /提前结束/)
  assert.throws(() => createGeminiSseTranslator({ model: model.id }).push(event({ error: { message: 'secret response' } })), /生成错误/)
  assert.throws(() => fromGeminiResponse({ response: {} }, model.id), /候选/)
})

test('Gemini：加载项目、首次开通和轮询 operation', async () => {
  const seen = []
  const fetchImpl = async (url, opts) => {
    seen.push({ url, opts, body: opts.body && JSON.parse(opts.body) })
    if (url.endsWith(':loadCodeAssist')) return Response.json({ allowedTiers: [{ id: 'free-tier', isDefault: true }] })
    if (url.endsWith(':onboardUser')) return Response.json({ name: 'operations/new', done: false })
    return Response.json({ done: true, response: { cloudaicompanionProject: { id: 'managed-p' } } })
  }
  const project = await setupGeminiProject({ credential: 'token', baseUrl: 'http://mock', projectId: 'ignored-for-free', fetchImpl, pollMs: 0 })
  assert.equal(project, 'managed-p')
  assert.equal(seen[1].body.cloudaicompanionProject, undefined)
  assert.equal(seen[2].url, 'http://mock/v1internal/operations/new')
  assert.equal(seen[2].opts.method, 'GET')
  assert.equal(seen[0].opts.headers.authorization, 'Bearer token')
  assert.equal(await setupGeminiProject({ credential: 'token', fetchImpl: async () => Response.json({ currentTier: { id: 'standard-tier' }, cloudaicompanionProject: 'paid-project' }) }), 'paid-project')
  await assert.rejects(setupGeminiProject({ credential: 'token', fetchImpl: async () => new Response('', { status: 403 }) }), /HTTP 403/)
  await assert.rejects(setupGeminiProject({ credential: 'token', fetchImpl: async () => Response.json({ currentTier: { id: 'standard-tier' } }) }), /projectId/)
})

test('Gemini：HTTP 传输走 Code Assist，返回 OpenAI 格式并传播错误状态', async () => {
  let sent
  const upstream = { baseUrl: 'http://mock/v1internal', resolvedKey: 'access', googleProjectId: 'p' }
  const fetchImpl = async (url, opts) => { sent = { url, opts }; return Response.json(wrap([{ text: '你好' }], 'STOP', { promptTokenCount: 2, candidatesTokenCount: 3 })) }
  const res = await sendGeminiRequest(upstream, { messages: [{ role: 'user', content: 'hi' }] }, model, { fetchImpl })
  assert.equal(sent.url, 'http://mock/v1internal:generateContent')
  assert.equal(JSON.parse(sent.opts.body).project, 'p')
  assert.equal((await res.json()).choices[0].message.content, '你好')
  const error = await sendGeminiRequest(upstream, {}, model, { fetchImpl: async () => Response.json({ error: 'quota_exceeded' }, { status: 429 }) })
  assert.equal(error.status, 429)
  const raw = new TextEncoder().encode(event(wrap([{ text: '中文' }], 'STOP')))
  const streamed = await sendGeminiRequest(upstream, {}, model, { stream: true, fetchImpl: async (url) => {
    assert.equal(url, 'http://mock/v1internal:streamGenerateContent?alt=sse')
    return new Response(new ReadableStream({ start(controller) { for (const byte of raw) controller.enqueue(Uint8Array.of(byte)); controller.close() } }))
  } })
  const text = await streamed.text()
  assert.match(text, /中文/)
  assert.match(text, /\[DONE\]/)
})

test('Gemini：轮询中间响应省略 name 时继续等待原任务', async () => {
  let polls = 0
  const project = await setupGeminiProject({ credential: 'token', pollMs: 0, fetchImpl: async (url) => {
    if (url.endsWith(':loadCodeAssist')) return Response.json({ allowedTiers: [{ id: 'free-tier', isDefault: true }] })
    if (url.endsWith(':onboardUser')) return Response.json({ name: 'operations/first' })
    assert.ok(url.endsWith('/operations/first'))
    if (++polls < 3) return Response.json({ done: false })
    return Response.json({ done: true, response: { cloudaicompanionProject: { id: 'assigned' } } })
  } })
  assert.equal(project, 'assigned')
  assert.equal(polls, 3)
})

test('Gemini：项目兼容字符串/对象，开通响应缺项目时有限复查', async () => {
  for (const value of ['assigned', { id: 'assigned' }]) {
    assert.equal(await setupGeminiProject({ credential: 'token', fetchImpl: async () => Response.json({ currentTier: {}, cloudaicompanionProject: value }) }), 'assigned')
    let loads = 0, onboards = 0
    assert.equal(await setupGeminiProject({ credential: 'token', pollMs: 0, fetchImpl: async (url) => {
      if (url.endsWith(':onboardUser')) { onboards++; return Response.json({ done: true }) }
      if (++loads < 3) return Response.json({ allowedTiers: [{ id: 'free-tier', isDefault: true }] })
      return Response.json({ currentTier: {}, cloudaicompanionProject: value })
    } }), 'assigned')
    assert.equal(onboards, 1)
    assert.equal(loads, 3)
  }
})

test('Gemini：已完成但未分配项目不能假报接入，复查次数有限', async () => {
  let requests = 0
  await assert.rejects(setupGeminiProject({ credential: 'token', pollMs: 0, fetchImpl: async (url) => {
    requests++
    if (url.endsWith(':onboardUser')) return Response.json({ done: true })
    return Response.json({ allowedTiers: [{ id: 'free-tier', isDefault: true }] })
  } }), (err) => err.code === 'gemini_project_unassigned')
  assert.equal(requests, 5)
})

test('Gemini：识别个人版客户端停用，显示迁移说明而非项目配置建议', async () => {
  for (const status of [200, 403]) {
    const reason = 'This client is no longer supported for Gemini Code Assist for individuals. Please migrate to the Antigravity suite. private-response-marker'
    const payload = status === 403 ? { error: { message: reason } } : { ineligibleTiers: [{ reasonMessage: reason }] }
    await assert.rejects(setupGeminiProject({ credential: 'token', fetchImpl: async () => Response.json(payload, { status }) }), (err) => {
      assert.equal(err.code, 'gemini_client_retired')
      assert.match(err.message, /2026-06-18/)
      assert.match(err.message, /尚未实现 Antigravity/)
      assert.doesNotMatch(err.message, /private-response-marker/)
      return true
    })
  }
})
