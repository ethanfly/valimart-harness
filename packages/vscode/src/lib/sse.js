/**
 * OpenAI-style SSE for /v1/chat/completions?stream=true.
 * 公司网关在 stream:true 时推 text/event-stream；非 SSE 响应走 JSON 回退。
 */
export function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
}

export function parseSseBlock(block) {
  const lines = String(block ?? '').split(/\r?\n/)
  const datas = []
  for (const line of lines) {
    if (line.startsWith('data:')) datas.push(line.slice(5).trimStart())
  }
  if (!datas.length) return null
  const raw = datas.join('\n').trim()
  if (!raw) return null
  if (raw === '[DONE]') return '[DONE]'
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function createChatAccumulator() {
  const toolCalls = []
  let content = ''
  let reasoning = ''
  let finishReason = null
  let usage = null
  let id = null
  let model = null

  function slot(index) {
    const i = Number.isInteger(index) ? index : 0
    while (toolCalls.length <= i) {
      toolCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } })
    }
    return toolCalls[i]
  }

  function applyDelta(delta, reason) {
    if (!delta || typeof delta !== 'object') {
      if (reason) finishReason = reason
      return
    }
    if (typeof delta.content === 'string') content += delta.content
    else if (Array.isArray(delta.content)) content += contentToText(delta.content)
    const think = delta.reasoning_content ?? delta.reasoning
    if (typeof think === 'string') reasoning += think
    for (const tc of delta.tool_calls ?? []) {
      const cur = slot(tc.index ?? 0)
      if (tc.id) cur.id = tc.id
      if (tc.type) cur.type = tc.type
      if (tc.function?.name) cur.function.name += tc.function.name
      if (typeof tc.function?.arguments === 'string') cur.function.arguments += tc.function.arguments
    }
    if (reason) finishReason = reason
  }

  function applyEvent(ev) {
    if (!ev || ev === '[DONE]') return
    if (ev.id) id = ev.id
    if (ev.model) model = ev.model
    if (ev.usage) usage = ev.usage
    const choice = ev.choices?.[0]
    if (!choice) return
    if (choice.delta) applyDelta(choice.delta, choice.finish_reason)
    else if (choice.message) {
      content = contentToText(choice.message.content)
      reasoning = contentToText(choice.message.reasoning_content ?? choice.message.reasoning)
      const calls = choice.message.tool_calls
      if (Array.isArray(calls)) {
        toolCalls.length = 0
        for (const [i, tc] of calls.entries()) {
          const cur = slot(i)
          cur.id = tc.id ?? cur.id
          cur.type = tc.type ?? 'function'
          cur.function.name = tc.function?.name ?? ''
          cur.function.arguments =
            typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {})
        }
      }
      finishReason = choice.finish_reason ?? finishReason
    }
  }

  function snapshot() {
    return { content, reasoning, toolCalls: toolCalls.map((c) => ({ ...c, function: { ...c.function } })) }
  }

  function finish() {
    const message = { role: 'assistant', content: content || (toolCalls.length ? null : '') }
    if (reasoning) message.reasoning_content = reasoning
    if (toolCalls.length) message.tool_calls = toolCalls.filter((c) => c.function.name || c.function.arguments)
    return { id, model, message, finishReason: finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop'), usage, reasoning }
  }

  return { applyDelta, applyEvent, snapshot, finish, get content() { return content }, get reasoning() { return reasoning } }
}

export async function consumeOpenAiSse(res, { onDelta } = {}) {
  const acc = createChatAccumulator()
  const body = res.body
  if (!body) {
    const text = await res.text()
    const acc2 = createChatAccumulator()
    for (const block of String(text).split(/\r?\n\r?\n/)) {
      const ev = parseSseBlock(block)
      if (ev === '[DONE]') break
      if (ev) {
        acc2.applyEvent(ev)
        onDelta?.({ text: acc2.content, reasoning: acc2.reasoning })
      }
    }
    const done = acc2.finish()
    return {
      id: done.id,
      model: done.model,
      choices: [{ index: 0, message: done.message, finish_reason: done.finishReason }],
      usage: done.usage,
    }
  }
  const reader = typeof body.getReader === 'function' ? body.getReader() : null
  if (!reader) {
    const text = await new Response(body).text()
    return consumeOpenAiSse(new Response(text, { headers: res.headers }), { onDelta })
  }
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const parts = buf.split(/\r?\n\r?\n/)
    buf = parts.pop() ?? ''
    for (const block of parts) {
      const ev = parseSseBlock(block)
      if (!ev) continue
      if (ev === '[DONE]') {
        const doneMsg = acc.finish()
        return {
          id: doneMsg.id,
          model: doneMsg.model,
          choices: [{ index: 0, message: doneMsg.message, finish_reason: doneMsg.finishReason }],
          usage: doneMsg.usage,
        }
      }
      acc.applyEvent(ev)
      onDelta?.({ text: acc.content, reasoning: acc.reasoning })
    }
  }
  if (buf.trim()) {
    const ev = parseSseBlock(buf)
    if (ev && ev !== '[DONE]') {
      acc.applyEvent(ev)
      onDelta?.({ text: acc.content, reasoning: acc.reasoning })
    }
  }
  const doneMsg = acc.finish()
  return {
    id: doneMsg.id,
    model: doneMsg.model,
    choices: [{ index: 0, message: doneMsg.message, finish_reason: doneMsg.finishReason }],
    usage: doneMsg.usage,
  }
}

export function jsonToCompletion(json, { onDelta } = {}) {
  const choice = json?.choices?.[0]
  const message = choice?.message ?? { role: 'assistant', content: '' }
  const text = contentToText(message.content)
  const reasoning = contentToText(message.reasoning_content ?? message.reasoning)
  if (text || reasoning) onDelta?.({ text, reasoning, done: true })
  return json
}
