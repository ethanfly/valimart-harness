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

function openaiImageUrl(part) {
  if (!part || typeof part !== 'object') return ''
  const raw = part.image_url
  if (typeof raw === 'string') return raw
  if (raw && typeof raw.url === 'string') return raw.url
  if (typeof part.url === 'string') return part.url
  return ''
}

function toCodexContent(content, role) {
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  if (typeof content === 'string') return content ? [{ type: textType, text: content }] : []
  if (!Array.isArray(content)) return []
  const parts = []
  for (const p of content) {
    if (typeof p === 'string') {
      if (p) parts.push({ type: textType, text: p })
      continue
    }
    if (!p || typeof p !== 'object') continue
    if (p.type === 'image_url' || p.type === 'image' || p.image_url) {
      const url = openaiImageUrl(p)
      if (url && role !== 'assistant') parts.push({ type: 'input_image', image_url: url })
      continue
    }
    const t = p.text ?? p.content
    if (typeof t === 'string' && t) parts.push({ type: textType, text: t })
  }
  return parts
}

export function toCodexResponsesBody(openaiBody, model) {
  const instructions = []
  const input = []
  for (const m of openaiBody.messages ?? []) {
    if (!m || !m.role) continue
    if (m.role === 'system' || m.role === 'developer') {
      const t = textOf(m.content)
      if (t) instructions.push(t)
      continue
    }
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: textOf(m.content) })
      continue
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const parts = toCodexContent(m.content, m.role)
    if (parts.length) input.push({
      type: 'message',
      role: m.role,
      content: parts,
    })
    if (m.role === 'assistant') {
      for (const call of m.tool_calls ?? []) {
        if (call.type !== 'function') continue
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })
      }
    }
  }
  const tools = (openaiBody.tools ?? []).filter((t) => t.type === 'function').map(({ function: fn }) => ({
    type: 'function', name: fn.name, description: fn.description,
    parameters: fn.parameters, strict: fn.strict ?? false,
  }))
  const choice = openaiBody.tool_choice
  const body = {
    model: model?.upstreamModel ?? openaiBody.model,
    input,
    stream: true,
    store: false,
    parallel_tool_calls: openaiBody.parallel_tool_calls ?? false,
    tool_choice: choice?.type === 'function' ? { type: 'function', name: choice.function.name } : choice ?? (tools.length ? 'auto' : 'none'),
    tools,
  }
  if (instructions.length) body.instructions = instructions.join('\n\n')
  const effort = openaiBody.reasoning_effort || openaiBody.reasoning?.effort
  if (effort) body.reasoning = { effort, summary: openaiBody.reasoning?.summary ?? 'auto' }
  return body
}

/** ChatGPT 订阅（Codex）没有 /images/*，出图走 Responses 的 image_generation 工具。 */
export const CODEX_IMAGE_TOOL = 'image_generation'

/** aspect_ratio / size → 图片工具支持的尺寸。 */
export function codexImageSize(body = {}) {
  const explicit = String(body.size ?? '').trim()
  if (/^\d{3,4}x\d{3,4}$/.test(explicit) || explicit === 'auto') return explicit
  const ratio = String(body.aspect_ratio ?? '').trim()
  const map = { '1:1': '1024x1024', '16:9': '1536x1024', '4:3': '1536x1024', '9:16': '1024x1536', '3:4': '1024x1536' }
  return map[ratio] ?? '1024x1024'
}

function imageRefToUrl(ref) {
  const s = String(ref ?? '')
  if (!s) return ''
  if (/^(data:|https?:)/i.test(s)) return s
  return `data:image/png;base64,${s}`
}

/** OpenAI /images/generations|edits 的 body → Codex responses（带 image_generation 工具）。 */
export function toCodexImageBody(openaiBody, driverModel) {
  const content = []
  const ref = openaiBody.image ?? openaiBody.image_url ?? (Array.isArray(openaiBody.images) ? openaiBody.images[0] : null)
  const url = imageRefToUrl(ref)
  if (url) content.push({ type: 'input_image', image_url: url })
  content.push({ type: 'input_text', text: String(openaiBody.prompt ?? '') })
  const tool = { type: CODEX_IMAGE_TOOL, size: codexImageSize(openaiBody) }
  if (openaiBody.quality) tool.quality = String(openaiBody.quality)
  if (openaiBody.background) tool.background = String(openaiBody.background)
  return {
    model: driverModel,
    input: [{ type: 'message', role: 'user', content }],
    tools: [tool],
    stream: true,
    store: false,
  }
}

/** 从 Codex SSE 流里取出图片（image_generation_call.result）与用量。 */
export function parseCodexImageStream(text) {
  let b64 = ''
  let revisedPrompt = ''
  let size = ''
  let outputFormat = ''
  let usage = null
  let error = ''
  for (const block of String(text ?? '').split(/\n\n/)) {
    const line = /^data: (.*)$/m.exec(block)
    if (!line) continue
    let ev
    try {
      ev = JSON.parse(line[1])
    } catch {
      continue
    }
    if (ev.type === 'response.output_item.done' && ev.item?.type === 'image_generation_call') {
      if (ev.item.result) {
        b64 = ev.item.result
        revisedPrompt = ev.item.revised_prompt ?? ''
        size = ev.item.size ?? ''
        outputFormat = ev.item.output_format ?? ''
      } else if (ev.item.status === 'failed') {
        error = ev.item.error?.message ?? '订阅通道图片生成失败'
      }
      continue
    }
    if (ev.type === 'response.completed') {
      const u = ev.response?.usage
      if (u) {
        usage = {
          prompt_tokens: u.input_tokens ?? 0,
          completion_tokens: u.output_tokens ?? 0,
          total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
        }
      }
      continue
    }
    if (ev.type === 'response.failed') {
      error = ev.response?.error?.message ?? (error || '订阅通道返回失败')
      continue
    }
    if (ev.error?.message && !error) error = ev.error.message
  }
  return { b64, revisedPrompt, size, outputFormat, usage, error }
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
  const calls = (codexJson?.output ?? []).filter((item) => item.type === 'function_call').map((item) => ({
    id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments },
  }))
  const usage = usageFromCodex(codexJson?.usage)
  return {
    id: codexJson?.id ? `chatcmpl-${codexJson.id}` : `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, message: { role: 'assistant', content: text || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: codexJson?.status === 'incomplete' ? 'length' : calls.length ? 'tool_calls' : 'stop' }],
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
  let completed = false
  let ended = false
  const texts = []
  const calls = []
  const byItem = new Map()
  const byOutput = new Map()
  const byCall = new Map()
  const chunk = (delta, finish_reason = null) => ({ id: chatId, object: 'chat.completion.chunk', created: ts, model, choices: [{ index: 0, delta, finish_reason }] })
  const encode = (obj) => `data: ${JSON.stringify(obj)}\n\n`

  function ensureCall(item, outputIndex, emit) {
    let call = byCall.get(item.call_id) ?? byItem.get(item.id) ?? byOutput.get(outputIndex)
    if (!call) {
      if (!item.call_id || !item.name) throw new Error('Codex function call is missing its call_id or name')
      call = { index: calls.length, id: item.call_id, type: 'function', function: { name: item.name, arguments: '' } }
      calls.push(call)
      emit(chunk({ tool_calls: [{ ...call, function: { ...call.function } }] }))
    }
    if (item.id) byItem.set(item.id, call)
    if (item.call_id) byCall.set(item.call_id, call)
    if (outputIndex !== undefined) byOutput.set(outputIndex, call)
    return call
  }
  function appendArguments(call, delta, emit) {
    if (!delta) return
    call.function.arguments += delta
    emit(chunk({ tool_calls: [{ index: call.index, function: { arguments: delta } }] }))
  }
  function finishArguments(call, full, emit) {
    if (typeof full !== 'string') return
    if (!full.startsWith(call.function.arguments)) throw new Error('Codex function call arguments disagree with streamed arguments')
    appendArguments(call, full.slice(call.function.arguments.length), emit)
  }
  const self = {
    usage: undefined,
    finishReason: undefined,
    get text() { return texts.join('') },
    get message() {
      return { role: 'assistant', content: self.text || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls.map(({ index, ...call }) => ({ ...call, function: { ...call.function } })) } : {}) }
    },
    push(value) {
      if (ended) return []
      pending += value
      const out = []
      const emit = (obj) => out.push(encode(obj))
      if (!started) {
        started = true
        emit(chunk({ role: 'assistant', content: '' }))
      }
      let idx
      while ((idx = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, idx).replace(/\r$/, '')
        pending = pending.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        // A complete SSE data line must contain valid JSON. Never silently drop tool calls.
        const obj = JSON.parse(payload)
        const type = obj.type || ''
        if (type === 'error' || type === 'response.failed') throw new Error(obj.response?.error?.message ?? obj.error?.message ?? obj.message ?? 'Codex response failed')
        if (completed) continue
        if (type === 'response.output_text.delta') {
          const delta = typeof obj.delta === 'string' ? obj.delta : obj.delta?.text ?? obj.text ?? ''
          if (delta) {
            texts.push(delta)
            emit(chunk({ content: delta }))
          }
        }
        if ((type === 'response.output_item.added' || type === 'response.output_item.done') && obj.item?.type === 'function_call') {
          const call = ensureCall(obj.item, obj.output_index, emit)
          finishArguments(call, obj.item.arguments, emit)
        }
        if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
          const call = byItem.get(obj.item_id) ?? byOutput.get(obj.output_index)
          if (!call) throw new Error('Codex function call arguments arrived without a function call')
          if (type.endsWith('.delta')) appendArguments(call, obj.delta, emit)
          else finishArguments(call, obj.arguments, emit)
        }
        if (type === 'response.completed' || type === 'response.done' || type === 'response.incomplete') {
          const response = obj.response ?? obj
          if (response.status === 'failed' || response.error) throw new Error(response.error?.message ?? 'Codex response failed')
          self.usage = usageFromCodex(response.usage) ?? self.usage
          if (!texts.length) {
            const fallback = textFromCodexOutput(response.output)
            if (fallback) {
              texts.push(fallback)
              emit(chunk({ content: fallback }))
            }
          }
          for (const [index, item] of (response.output ?? []).entries()) {
            if (item.type !== 'function_call') continue
            finishArguments(ensureCall(item, index, emit), item.arguments, emit)
          }
          self.finishReason = type === 'response.incomplete' || response.status === 'incomplete' ? 'length' : calls.length ? 'tool_calls' : 'stop'
          completed = true
          emit(chunk({}, self.finishReason))
        }
      }
      return out
    },
    end() {
      if (ended) return []
      const out = pending.trim() ? self.push('\n') : []
      if (!completed) throw new Error('Codex stream ended before response completion')
      ended = true
      if (self.usage) out.push(encode({ id: chatId, object: 'chat.completion.chunk', created: ts, model, choices: [], usage: self.usage }))
      out.push('data: [DONE]\n\n')
      return out
    },
  }
  return self
}
