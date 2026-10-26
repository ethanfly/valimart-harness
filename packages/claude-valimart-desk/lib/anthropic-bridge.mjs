/**
 * Claude Code 的 Anthropic Messages → 公司网关的 OpenAI Chat Completions。
 * 网关对外只有 /v1/chat/completions（见 server/src/llm-proxy.js）。
 * 工具调用要保留：Claude Code 靠 tool_use / tool_result 改文件。
 */

const STOP_TO_ANTHROPIC = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'end_turn',
}

export function anthropicStopReason(finish) {
  return STOP_TO_ANTHROPIC[finish] || 'end_turn'
}

function textFromBlocks(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => {
      if (typeof b === 'string') return b
      if (b?.type === 'text') return b.text ?? ''
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function imageToOpenAI(block) {
  const src = block?.source
  if (!src || typeof src !== 'object') return null
  if (src.type === 'base64' && src.data) {
    const media = src.media_type || 'image/png'
    return { type: 'image_url', image_url: { url: `data:${media};base64,${src.data}` } }
  }
  if (src.type === 'url' && src.url) return { type: 'image_url', image_url: { url: src.url } }
  return null
}

/** 一条 Anthropic user/assistant 消息拆成若干条 OpenAI 消息（工具结果要单独成 role:tool）。 */
export function anthropicMessageToOpenAI(message) {
  if (!message || !message.role) return []
  const content = message.content
  if (typeof content === 'string') {
    return [{ role: message.role === 'assistant' ? 'assistant' : 'user', content }]
  }
  if (!Array.isArray(content)) return []

  if (message.role === 'assistant') {
    const texts = []
    const toolCalls = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && block.text) texts.push(block.text)
      if (block.type === 'thinking' && block.thinking) {
        /* 网关 compat 要求带上推理，但普通文本模型不吃 thinking 块；折进 content 会污染回复，丢掉。 */
      }
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: String(block.id || `toolu_${toolCalls.length}`),
          type: 'function',
          function: {
            name: String(block.name || ''),
            arguments: JSON.stringify(block.input ?? {}),
          },
        })
      }
    }
    if (!texts.length && !toolCalls.length) return []
    const out = { role: 'assistant', content: texts.join('\n') }
    if (toolCalls.length) out.tool_calls = toolCalls
    return [out]
  }

  const parts = []
  const tools = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && block.text) parts.push({ type: 'text', text: block.text })
    if (block.type === 'image') {
      const img = imageToOpenAI(block)
      if (img) parts.push(img)
    }
    if (block.type === 'tool_result') {
      tools.push({
        role: 'tool',
        tool_call_id: String(block.tool_use_id || ''),
        content: textFromBlocks(block.content) || (typeof block.content === 'string' ? block.content : ''),
      })
    }
  }
  const out = []
  if (parts.length) {
    const onlyText = parts.every((p) => p.type === 'text')
    out.push({ role: 'user', content: onlyText ? parts.map((p) => p.text).join('\n') : parts })
  }
  out.push(...tools)
  return out
}

export function toOpenAITools(tools) {
  if (!Array.isArray(tools)) return undefined
  const out = []
  for (const tool of tools) {
    if (!tool?.name) continue
    out.push({
      type: 'function',
      function: {
        name: String(tool.name),
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: tool.input_schema && typeof tool.input_schema === 'object' ? tool.input_schema : { type: 'object', properties: {} },
      },
    })
  }
  return out.length ? out : undefined
}

export function toOpenAIToolChoice(choice) {
  if (!choice || choice.type === 'auto') return undefined
  if (choice.type === 'any') return 'required'
  if (choice.type === 'none') return 'none'
  if (choice.type === 'tool' && choice.name) return { type: 'function', function: { name: choice.name } }
  return undefined
}

/**
 * @returns {object} OpenAI chat.completions body
 */
export function toOpenAIBody(anthropicBody, { defaultModel } = {}) {
  const src = anthropicBody && typeof anthropicBody === 'object' ? anthropicBody : {}
  const messages = []
  const system = textFromBlocks(src.system)
  if (system) messages.push({ role: 'system', content: system })
  for (const message of src.messages ?? []) messages.push(...anthropicMessageToOpenAI(message))
  if (!messages.some((m) => m.role === 'user' || m.role === 'tool')) {
    messages.push({ role: 'user', content: '.' })
  }
  const maxTokens = Number(src.max_tokens)
  const body = {
    model: String(src.model || defaultModel || ''),
    messages,
    stream: src.stream === true,
  }
  if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens
  if (src.temperature !== undefined) body.temperature = src.temperature
  if (src.stop_sequences) body.stop = src.stop_sequences
  const tools = toOpenAITools(src.tools)
  if (tools) body.tools = tools
  const choice = toOpenAIToolChoice(src.tool_choice)
  if (choice) body.tool_choice = choice
  return body
}

function toolUseBlocks(toolCalls) {
  if (!Array.isArray(toolCalls)) return []
  return toolCalls.map((call, i) => {
    let input = {}
    try {
      input = JSON.parse(call?.function?.arguments || '{}')
    } catch {
      input = { _raw: call?.function?.arguments ?? '' }
    }
    return {
      type: 'tool_use',
      id: String(call?.id || `toolu_${i}`),
      name: String(call?.function?.name || ''),
      input,
    }
  })
}

export function toAnthropicMessage(openaiJson) {
  const choice = openaiJson?.choices?.[0] ?? {}
  const message = choice.message ?? {}
  const content = []
  if (typeof message.content === 'string' && message.content) content.push({ type: 'text', text: message.content })
  content.push(...toolUseBlocks(message.tool_calls))
  if (!content.length) content.push({ type: 'text', text: '' })
  const usage = openaiJson?.usage
  return {
    id: String(openaiJson?.id || `msg_${Date.now()}`),
    type: 'message',
    role: 'assistant',
    model: openaiJson?.model || '',
    stop_reason: anthropicStopReason(choice.finish_reason),
    stop_sequence: null,
    content,
    usage: {
      input_tokens: Number(usage?.prompt_tokens ?? 0),
      output_tokens: Number(usage?.completion_tokens ?? 0),
    },
  }
}

/**
 * OpenAI SSE 文本增量 → Anthropic SSE 事件。
 * 跨调用保持工具参数的半截 JSON，结束时再发 content_block_stop / message_delta。
 */
export function createOpenAIToAnthropicStream({ model }) {
  let pending = ''
  let block = -1
  let textOpen = false
  let messageId = `msg_${Date.now()}`
  let inputTokens = 0
  let outputTokens = 0
  let stopReason = 'end_turn'
  const tools = new Map()

  function openBlock(kind) {
    block += 1
    const index = block
    if (kind === 'text') textOpen = true
    return index
  }

  function eventsForDelta(choice) {
    const out = []
    const delta = choice?.delta ?? {}
    if (typeof delta.content === 'string' && delta.content) {
      if (!textOpen) {
        const index = openBlock('text')
        out.push(event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }))
      }
      out.push(event('content_block_delta', { type: 'content_block_delta', index: block, delta: { type: 'text_delta', text: delta.content } }))
    }
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? 0
      if (!tools.has(index)) {
        if (textOpen) {
          out.push(event('content_block_stop', { type: 'content_block_stop', index: block }))
          textOpen = false
        }
        const contentIndex = openBlock('tool')
        const id = call.id || `toolu_${index}`
        const name = call.function?.name || ''
        tools.set(index, { contentIndex, id, name, args: '' })
        out.push(event('content_block_start', {
          type: 'content_block_start',
          index: contentIndex,
          content_block: { type: 'tool_use', id, name, input: {} },
        }))
      }
      const piece = call.function?.arguments
      if (piece) {
        const known = tools.get(index)
        known.args += piece
        out.push(event('content_block_delta', {
          type: 'content_block_delta',
          index: known.contentIndex,
          delta: { type: 'input_json_delta', partial_json: piece },
        }))
      }
    }
    if (choice?.finish_reason) stopReason = anthropicStopReason(choice.finish_reason)
    return out
  }

  function event(name, obj) {
    return `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`
  }

  return {
    start(id) {
      if (id) messageId = id
      return event('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: model || '',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
    },
    push(chunk) {
      pending += chunk
      const out = []
      let idx
      while ((idx = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, idx).replace(/\r$/, '')
        pending = pending.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let obj
        try { obj = JSON.parse(payload) } catch { continue }
        if (obj.id) messageId = obj.id
        if (obj.usage) {
          inputTokens = Number(obj.usage.prompt_tokens ?? inputTokens)
          outputTokens = Number(obj.usage.completion_tokens ?? outputTokens)
        }
        for (const choice of obj.choices ?? []) out.push(...eventsForDelta(choice))
      }
      return out.join('')
    },
    end() {
      const out = []
      if (textOpen || tools.size) {
        out.push(event('content_block_stop', { type: 'content_block_stop', index: block }))
      }
      out.push(event('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }))
      out.push(event('message_stop', { type: 'message_stop' }))
      return { text: out.join(''), usage: { input_tokens: inputTokens, output_tokens: outputTokens } }
    },
  }
}
