/**
 * ChatGPT 订阅 / Codex 后端：OpenAI Chat Completions ↔ Responses API。
 * 端点是 chatgpt.com/backend-api/codex/responses，不是 api.openai.com/v1/chat/completions。
 */
import { inferUpstreamApi } from './upstream-anthropic.js'

export { inferUpstreamApi }

export const CODEX_ORIGINATOR = 'codex_cli_rs'

export function usesChatgptCodex(upstream) {
  if (!upstream) return false
  if (upstream.api === 'chatgpt-codex') return true
  if (upstream.api === 'openai-compatible' || upstream.api === 'anthropic-messages') return false
  return inferUpstreamApi(upstream.baseUrl) === 'chatgpt-codex'
}

export function chatgptResponsesUrl(baseUrl) {
  const u = String(baseUrl ?? '').replace(/\/+$/, '')
  if (u.endsWith('/responses')) return u
  return `${u}/responses`
}

export function chatgptHeaders(accessToken, { accountId } = {}) {
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${accessToken}`,
    accept: 'text/event-stream',
    'openai-beta': 'responses=experimental',
    originator: CODEX_ORIGINATOR,
  }
  if (accountId) headers['chatgpt-account-id'] = String(accountId)
  return headers
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((p) => (typeof p === 'string' ? p : p?.text ?? p?.content ?? '')).join('')
}

export function toCodexResponsesBody(openaiBody, model) {
  const instructions = []
  const input = []
  for (const m of openaiBody.messages ?? []) {
    if (!m || !m.role) continue
    if (m.role === 'system') {
      const t = textOf(m.content)
      if (t) instructions.push(t)
      continue
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const t = textOf(m.content)
    if (!t) continue
    input.push({
      type: 'message',
      role: m.role,
      content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: t }],
    })
  }
  const body = {
    model: model?.upstreamModel ?? openaiBody.model,
    input,
    stream: true,
    store: false,
    parallel_tool_calls: false,
    tool_choice: 'none',
    tools: [],
  }
  if (instructions.length) body.instructions = instructions.join('\n\n')
  const effort = openaiBody.reasoning_effort || openaiBody.reasoning?.effort
  if (effort) body.reasoning = { effort, summary: openaiBody.reasoning?.summary ?? 'auto' }
  return body
}

export function textFromCodexOutput(output) {
  if (!Array.isArray(output)) return ''
  const parts = []
  for (const item of output) {
    if (item?.type && item.type !== 'message') continue
    for (const c of item?.content ?? []) {
      if (c?.type === 'output_text' || c?.type === 'text') parts.push(c.text ?? '')
    }
  }
  return parts.join('')
}

export function usageFromCodex(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const prompt = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0)
  const completion = Number(usage.output_tokens ?? usage.completion_tokens ?? 0)
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
}

export function toOpenAIFromCodex(codexJson, modelId) {
  const text = textFromCodexOutput(codexJson?.output)
  const usage = usageFromCodex(codexJson?.usage)
  return {
    id: codexJson?.id ? `chatcmpl-${codexJson.id}` : `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage,
  }
}

/**
 * 把 Codex Responses SSE 转成 OpenAI chat.completion.chunk。
 */
export function createCodexSseTranslator({ id, model, created } = {}) {
  const chatId = id ?? `chatcmpl-${Date.now()}`
  const ts = created ?? Math.floor(Date.now() / 1000)
  let pending = ''
  let started = false
  const texts = []
  const self = {
    usage: undefined,
    get text() {
      return texts.join('')
    },
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
        if (!line || line.startsWith(':')) continue
        if (line.startsWith('event:')) continue
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let obj
        try {
          obj = JSON.parse(payload)
        } catch {
          continue
        }
        const type = obj.type || ''
        if (type === 'response.output_text.delta') {
          const delta = typeof obj.delta === 'string' ? obj.delta : obj.delta?.text ?? obj.text ?? ''
          if (delta) {
            texts.push(delta)
            emit({ id: chatId, object: 'chat.completion.chunk', created: ts, model, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })
          }
        }
        if (type === 'response.completed' || type === 'response.done') {
          const usage = usageFromCodex(obj.response?.usage ?? obj.usage)
          if (usage) self.usage = usage
          if (!texts.length) {
            const fallback = textFromCodexOutput(obj.response?.output ?? obj.output)
            if (fallback) {
              texts.push(fallback)
              emit({ id: chatId, object: 'chat.completion.chunk', created: ts, model, choices: [{ index: 0, delta: { content: fallback }, finish_reason: null }] })
            }
          }
          emit({ id: chatId, object: 'chat.completion.chunk', created: ts, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        }
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
