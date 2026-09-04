/**
 * 模型网关：OpenAI Chat Completions 兼容端点（/v1/models、/v1/chat/completions）。
 * - 员工端只持有按人签发的网关令牌，上游真实密钥仅在服务端内存中。
 * - 每次请求：校验令牌（吊销即时生效）→ 周额度检查 → 转发上游 → 按人记账。
 */
import { HttpError, readBody, sendJson, bearer } from './http.js'
import { estimateCostCny } from './ledger.js'
import {
  anthropicHeaders,
  anthropicMessagesUrl,
  createAnthropicSseTranslator,
  toAnthropicBody,
  toOpenAIResponse,
  usesAnthropicMessages,
} from './upstream-anthropic.js'

export class LlmProxy {
  constructor({ db, cfg, ledger, catalog }) {
    this.db = db
    this.cfg = cfg
    this.ledger = ledger
    this.catalog = catalog
  }

  authenticate(req) {
    const token = bearer(req)
    const item = this.db.findGatewayToken(token)
    if (!item) throw new HttpError(401, '网关令牌无效或已被吊销，请重新登录客户端', 'invalid_token')
    const user = this.db.getUser(item.userId)
    if (!user || user.disabled) throw new HttpError(403, '账号已停用', 'account_disabled')
    this.db.touchGatewayToken(item.id)
    this.db.updateUser(user.id, { lastSeenAt: new Date().toISOString() })
    return { user, tokenItem: item }
  }

  findModel(id) {
    return this.catalog().find((m) => m.id === id)
  }

  async handleModels(req, res) {
    this.authenticate(req)
    sendJson(res, 200, {
      object: 'list',
      data: this.catalog().map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: m.provider, display_name: m.name })),
    })
  }

  async handleChat(req, res) {
    const { user } = this.authenticate(req)
    const raw = await readBody(req)
    let body
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new HttpError(400, 'invalid JSON body')
    }
    const model = this.findModel(body.model)
    if (!model) throw new HttpError(404, `模型 ${body.model} 不在公司目录里`, 'model_not_found')
    if (this.ledger.exceeded(user, model.provider)) {
      throw new HttpError(429, `本周 ${model.providerLabel} 额度已用完，刷新时间 ${this.ledger.quotaView(user, [{ id: model.provider }])[0]?.refreshAt ?? ''}`, 'quota_exceeded')
    }
    const upstream = this.cfg.upstreams[model.provider]
    const started = Date.now()
    const stream = body.stream === true
    const finish = (usage, status, extra = {}) => {
      const cost = estimateCostCny(model, usage)
      this.ledger.record({
        userId: user.id,
        username: user.username,
        provider: model.provider,
        model: model.id,
        stream,
        status,
        latencyMs: Date.now() - started,
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        cachedTokens: usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0,
        costCny: cost,
        ...extra,
      })
    }

    if (upstream.kind === 'mock') return this.mock(body, model, res, stream, finish)

    const ac = new AbortController()
    req.on('close', () => ac.abort())
    let upstreamRes
    try {
      upstreamRes = await this.fetchUpstream(upstream, body, model, { stream, signal: ac.signal })
    } catch (err) {
      if (ac.signal.aborted) return
      finish(undefined, 'upstream_unreachable')
      throw new HttpError(502, `上游 ${model.providerLabel} 不可达：${err.message}`, 'upstream_unreachable')
    }
    if (!upstreamRes.ok) {
      const text = await upstreamRes.text()
      finish(undefined, `upstream_${upstreamRes.status}`)
      res.writeHead(upstreamRes.status, { 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' })
      res.end(text)
      return
    }
    const anthropic = usesAnthropicMessages(upstream)
    if (!stream) {
      const text = await upstreamRes.text()
      let payload = text
      let usage
      if (anthropic) {
        try {
          const converted = toOpenAIResponse(JSON.parse(text), model.id)
          usage = converted.usage
          payload = JSON.stringify(converted)
        } catch {
          /* 原样回传 */
        }
      } else {
        try {
          usage = JSON.parse(text).usage
        } catch {
          /* ignore */
        }
      }
      finish(usage, 'ok')
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(payload)
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    res.flushHeaders?.()
    if (anthropic) return this.pipeAnthropicStream(upstreamRes, res, model, finish, ac)
    return this.pipeOpenAIStream(upstreamRes, res, finish, ac)
  }

  fetchUpstream(upstream, body, model, { stream, signal }) {
    if (usesAnthropicMessages(upstream)) {
      const forward = toAnthropicBody({ ...body, stream }, model)
      return fetch(anthropicMessagesUrl(upstream.baseUrl), {
        method: 'POST',
        headers: { ...anthropicHeaders(upstream.resolvedKey), accept: stream ? 'text/event-stream' : 'application/json' },
        body: JSON.stringify(forward),
        signal,
      })
    }
    const forward = { ...body, model: model.upstreamModel }
    if (stream) forward.stream_options = { ...(body.stream_options ?? {}), include_usage: true }
    return fetch(`${upstream.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${upstream.resolvedKey}`, accept: stream ? 'text/event-stream' : 'application/json' },
      body: JSON.stringify(forward),
      signal,
    })
  }

  async pipeOpenAIStream(upstreamRes, res, finish, ac) {
    const reader = upstreamRes.body.getReader()
    const decoder = new TextDecoder()
    let usage
    let pending = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        res.write(Buffer.from(value))
        pending += decoder.decode(value, { stream: true })
        let idx
        while ((idx = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, idx).trim()
          pending = pending.slice(idx + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          if (!payload.includes('"usage"')) continue
          try {
            const obj = JSON.parse(payload)
            if (obj.usage && typeof obj.usage === 'object') usage = obj.usage
          } catch {
            /* 半截 JSON：忽略 */
          }
        }
      }
      finish(usage, 'ok')
      res.end()
    } catch {
      finish(usage, ac.signal.aborted ? 'client_aborted' : 'stream_error')
      try {
        res.end()
      } catch {
        /* ignore */
      }
    }
  }

  async pipeAnthropicStream(upstreamRes, res, model, finish, ac) {
    const translator = createAnthropicSseTranslator({ model: model.id })
    const reader = upstreamRes.body.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        for (const piece of translator.push(decoder.decode(value, { stream: true }))) res.write(piece)
      }
      for (const piece of translator.end()) res.write(piece)
      finish(translator.usage, 'ok')
      res.end()
    } catch {
      finish(translator.usage, ac.signal.aborted ? 'client_aborted' : 'stream_error')
      try {
        res.end()
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 服务端内部一次性非流式补全（快速推理、标题生成等），同样走额度与记账。
   * @returns {Promise<{content: string, usage: any, latencyMs: number, model: string}>}
   */
  async completeOnce(user, modelId, messages, { maxTokens = 512, tag = 'quick-inference' } = {}) {
    const model = this.findModel(modelId)
    if (!model) throw new HttpError(404, `模型 ${modelId} 不在公司目录里`, 'model_not_found')
    if (this.ledger.exceeded(user, model.provider)) throw new HttpError(429, `本周 ${model.providerLabel} 额度已用完`, 'quota_exceeded')
    const upstream = this.cfg.upstreams[model.provider]
    const started = Date.now()
    let content = ''
    let usage
    if (upstream.kind === 'mock') {
      const last = [...messages].reverse().find((m) => m.role === 'user')
      content = `【Mock 快速推理】${typeof last?.content === 'string' ? last.content.slice(0, 120) : ''} → 好的，已处理。`
      usage = { prompt_tokens: Math.ceil(JSON.stringify(messages).length / 3), completion_tokens: Math.ceil(content.length / 1.5) }
    } else {
      const body = { model: model.upstreamModel, messages, stream: false, max_tokens: maxTokens }
      if (model.compat?.thinkingFormat === 'deepseek' && model.reasoningEfforts) body.thinking = { type: 'disabled' }
      const r = await this.fetchUpstream(upstream, body, model, { stream: false })
      const text = await r.text()
      if (!r.ok) throw new HttpError(502, `上游返回 ${r.status}: ${text.slice(0, 300)}`, 'upstream_error')
      const json = usesAnthropicMessages(upstream) ? toOpenAIResponse(JSON.parse(text), model.id) : JSON.parse(text)
      content = json.choices?.[0]?.message?.content ?? ''
      usage = json.usage
    }
    const latencyMs = Date.now() - started
    this.ledger.record({
      userId: user.id,
      username: user.username,
      provider: model.provider,
      model: model.id,
      stream: false,
      status: 'ok',
      tag,
      latencyMs,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      cachedTokens: usage?.prompt_cache_hit_tokens ?? 0,
      costCny: estimateCostCny(model, usage),
    })
    return { content, usage, latencyMs, model: model.id }
  }

  async mock(body, model, res, stream, finish) {
    const messages = Array.isArray(body.messages) ? body.messages : []
    const last = [...messages].reverse().find((m) => m.role === 'user')
    const text = typeof last?.content === 'string' ? last.content : Array.isArray(last?.content) ? last.content.map((p) => p.text ?? '').join('') : ''
    const reply = `【Mock 模型】收到你的消息：「${text.slice(0, 200)}」。这是离线演示回复：网关已完成令牌校验、额度检查并记账。`
    const promptTokens = Math.ceil(JSON.stringify(messages).length / 3)
    const completionTokens = Math.ceil(reply.length / 1.5)
    const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
    const id = `chatcmpl-mock-${Date.now()}`
    const created = Math.floor(Date.now() / 1000)
    if (!stream) {
      finish(usage, 'ok')
      sendJson(res, 200, { id, object: 'chat.completion', created, model: model.id, choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage })
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    send({ id, object: 'chat.completion.chunk', created, model: model.id, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
    for (const piece of reply.match(/[\s\S]{1,6}/g) ?? []) {
      send({ id, object: 'chat.completion.chunk', created, model: model.id, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })
      await new Promise((r) => setTimeout(r, 15))
    }
    send({ id, object: 'chat.completion.chunk', created, model: model.id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    send({ id, object: 'chat.completion.chunk', created, model: model.id, choices: [], usage })
    res.write('data: [DONE]\n\n')
    finish(usage, 'ok')
    res.end()
  }
}
