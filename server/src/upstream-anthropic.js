/**
 * Anthropic Messages API ↔ OpenAI Chat Completions 互转。
 * Claude / Anthropic 官方端点是 POST /v1/messages，不是 /chat/completions。
 */

export const ANTHROPIC_VERSION = '2023-06-01'

export function inferUpstreamApi(baseUrl) {
  try {
    const u = new URL(String(baseUrl ?? ''))
    if (u.hostname === 'chatgpt.com' && u.pathname.includes('/backend-api/codex')) return 'chatgpt-codex'
    if (u.hostname === 'api.anthropic.com' || /\/messages\/?$/.test(u.pathname)) return 'anthropic-messages'
  } catch {
    /* 非法 URL：按 OpenAI 兼容处理 */
  }
  return 'openai-compatible'
}

export function usesAnthropicMessages(upstream) {
  if (!upstream) return false
  if (upstream.api === 'anthropic-messages') return true
  if (upstream.api === 'openai-compatible') return false
  return inferUpstreamApi(upstream.baseUrl) === 'anthropic-messages'
}

export function anthropicMessagesUrl(baseUrl) {
  const u = String(baseUrl ?? '').replace(/\/+$/, '')
  if (u.endsWith('/messages')) return u
  return `${u}/messages`
}

export function anthropicHeaders(apiKey, { authStyle } = {}) {
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  }
  if (authStyle === 'anthropic-oauth') {
    headers.authorization = `Bearer ${apiKey}`
    headers['anthropic-beta'] = 'oauth-2025-04-20'
    return headers
  }
  headers['x-api-key'] = apiKey
  return headers
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((p) => (typeof p === 'string' ? p : p?.text ?? p?.content ?? '')).join('')
}

/** OpenAI messages → Anthropic { system, messages }（保证 user 开头、角色交替）。 */
export function toAnthropicMessages(openaiMessages) {
  const systemParts = []
  const raw = []
  for (const m of openaiMessages ?? []) {
    if (!m || !m.role) continue
    if (m.role === 'system') {
      const t = textOf(m.content)
      if (t) systemParts.push(t)
      continue
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    raw.push({ role, content: textOf(m.content) })
  }
  const merged = []
  for (const m of raw) {
    const last = merged[merged.length - 1]
    if (last && last.role === m.role) last.content = [last.content, m.content].filter(Boolean).join('\n')
    else merged.push({ ...m })
  }
  if (merged.length && merged[0].role !== 'user') merged.unshift({ role: 'user', content: '.' })
  if (merged.length === 0) merged.push({ role: 'user', content: '.' })
  const system = systemParts.join('\n\n')
  return { system: system || undefined, messages: merged }
}

export function toAnthropicBody(openaiBody, model) {
  const { system, messages } = toAnthropicMessages(openaiBody.messages)
  const maxTokens = Number(openaiBody.max_tokens ?? openaiBody.max_completion_tokens ?? model?.maxTokens ?? 4096)
  const body = {
    model: model?.upstreamModel ?? openaiBody.model,
    max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 4096,
    messages,
    stream: openaiBody.stream === true,
  }
  if (system) body.system = system
  if (openaiBody.temperature !== undefined) body.temperature = openaiBody.temperature
  if (openaiBody.stop) body.stop_sequences = Array.isArray(openaiBody.stop) ? openaiBody.stop : [openaiBody.stop]
  const thinking = reasoningToAnthropicThinking(openaiBody, model)
  if (thinking) body.thinking = thinking
  return body
}

const THINKING_BUDGET = { low: 4096, medium: 10240, high: 16384, xhigh: 24576, max: 32000 }

export function reasoningToAnthropicThinking(openaiBody) {
  const effort = openaiBody?.reasoning_effort ?? openaiBody?.reasoning?.effort
  if (!effort || effort === 'off' || effort === 'none' || effort === 'minimal') return undefined
  const budget = THINKING_BUDGET[effort] ?? 10240
  return { type: 'enabled', budget_tokens: budget }
}

export function usageFromAnthropic(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const prompt = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0)
  const completion = Number(usage.output_tokens ?? usage.completion_tokens ?? 0)
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
}

export function toOpenAIResponse(anthropicJson, modelId) {
  const text = (anthropicJson.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
  const usage = usageFromAnthropic(anthropicJson.usage)
  const stop = anthropicJson.stop_reason === 'max_tokens' ? 'length' : 'stop'
  return {
    id: anthropicJson.id ? `chatcmpl-${anthropicJson.id}` : `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: stop }],
    usage,
  }
}

/**
 * 把 Anthropic SSE 转成 OpenAI chat.completion.chunk。
 * @returns {{ push(chunk: string): string[], end(): string[], usage?: object }}
 */
export function createAnthropicSseTranslator({ id, model, created }) {
  const chatId = id ?? `chatcmpl-${Date.now()}`
  const ts = created ?? Math.floor(Date.now() / 1000)
  let pending = ''
  let eventName = ''
  let inputTokens = 0
  let outputTokens = 0
  let started = false
  const self = {
    usage: undefined,
    push(chunk) {
      pending += chunk
      const out = []
      const emit = (obj) => out.push(`data: ${JSON.stringify(obj)}\n\n`)
      if (!started) {
        started = true
        emit({ id: chatId, object: 'chat.completion.chunk', created: ts, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
      }
      let idx
      while ((idx = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, idx).replace(/\r$/, '')
        pending = pending.slice(idx + 1)
        if (!line) {
          eventName = ''
          continue
        }
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
          continue
        }
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        let obj
        try {
          obj = JSON.parse(payload)
        } catch {
          continue
        }
        const type = obj.type || eventName
        if (type === 'message_start' && obj.message?.usage) {
          inputTokens = Number(obj.message.usage.input_tokens ?? 0)
        }
        if (type === 'content_block_delta' && obj.delta?.type === 'text_delta' && obj.delta.text) {
          emit({ id: chatId, object: 'chat.completion.chunk', created: ts, model, choices: [{ index: 0, delta: { content: obj.delta.text }, finish_reason: null }] })
        }
        if (type === 'message_delta') {
          if (obj.usage?.output_tokens != null) outputTokens = Number(obj.usage.output_tokens)
          const reason = obj.delta?.stop_reason === 'max_tokens' ? 'length' : 'stop'
          emit({ id: chatId, object: 'chat.completion.chunk', created: ts, model, choices: [{ index: 0, delta: {}, finish_reason: reason }] })
        }
      }
      if (inputTokens || outputTokens) {
        self.usage = { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
      }
      return out
    },
    end() {
      const out = []
      if (self.usage) {
        out.push(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created: ts, model, choices: [], usage: self.usage })}\n\n`)
      }
      out.push('data: [DONE]\n\n')
      return out
    },
  }
  return self
}
