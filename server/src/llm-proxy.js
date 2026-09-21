/**
 * 模型网关：OpenAI 兼容端点（/v1/models、/v1/chat/completions、/v1/images/*、/v1/videos/generations）。
 * - 员工端只持有按人签发的网关令牌，上游真实密钥仅在服务端内存中。
 * - 每次请求：校验令牌（吊销即时生效）→ 周额度检查 → 转发上游 → 按人记账。
 */
import crypto from 'node:crypto'
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
import {
  chatgptHeaders,
  chatgptResponsesUrl,
  createCodexSseTranslator,
  parseCodexImageStream,
  toCodexImageBody,
  toCodexResponsesBody,
  usesChatgptCodex,
} from './upstream-chatgpt.js'
import { isUpstreamQuotaExhausted, quotaExhaustedMessage } from './upstream-quota.js'
import { openaiCompatUrl } from './upstream-models.js'
import { sendGeminiRequest, usesCloudCodePa } from './upstream-gemini.js'
import {
  dashscopeOrigin,
  parseDashscopeImage,
  toDashscopeImageBody,
  usesDashscopeImages,
} from './upstream-dashscope.js'

export class LlmProxy {
  constructor({ db, cfg, ledger, catalog, oauth, channels, mixedAttribution = null }) {
    this.db = db
    this.cfg = cfg
    this.ledger = ledger
    this.catalog = catalog
    this.oauth = oauth
    this.channels = channels
    this.mixedAttribution = mixedAttribution
  }

  /**
   * T10：该用户当前活跃的 mixed attempt 归属 → 账本 extra。
   * 内部元数据只进本网关账本，绝不注入上游请求体（T10「剥离内部元数据后再请求上游」）。
   * - 恰好 1 个活跃 attempt → mixed: {runId, stage, attemptId[, taskId]}
   * - 多个（并发 run）→ mixed: {ambiguous: true, attemptIds}（可见，不悄悄归错）
   * - 0 个 → 空（普通会话请求不带 mixed 字段）
   */
  mixedExtra(user) {
    if (!this.mixedAttribution || !user) return {}
    const act = this.mixedAttribution.activeFor(user.id)
    if (act.length === 1) {
      const a = act[0]
      return { mixed: { runId: a.runId, stage: a.stage, attemptId: a.attemptId, ...(a.taskId ? { taskId: a.taskId } : {}) } }
    }
    if (act.length > 1) return { mixed: { ambiguous: true, attemptIds: act.map((a) => a.attemptId) } }
    return {}
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
    // JSON.parse('null') 是合法 JSON 但会得到 null，不能让它走到 body.model 上变成 500
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求体必须是 JSON 对象', 'invalid_body')
    const model = this.findModel(body.model)
    if (!model) throw new HttpError(404, '模型 ' + body.model + ' 不在公司目录里', 'model_not_found')
    const upstream = this.cfg.upstreams[model.provider]
    // 额度检查必须在锁内：锁外先查再排队，上一笔已记账超额后仍会放行。mock 也记账，同样要串行。
    return this.withProviderLock(user.id + ':' + model.provider, () => {
      if (this.ledger.exceeded(user, model.provider)) {
        throw new HttpError(429, '本周 ' + model.providerLabel + ' 额度已用完，刷新时间 ' + (this.ledger.quotaView(user, [{ id: model.provider }])[0]?.refreshAt ?? ''), 'quota_exceeded')
      }
      if (upstream.kind === 'mock') return this.mockChat(user, model, body, res, upstream)
      return this.proxyChat(user, model, body, res, upstream)
    })
  }

  findDefaultImageModel() {
    const list = this.catalog()
    return (
      list.find((m) => m.id === GROK_DEFAULT_IMAGE_MODEL) ??
      list.find((m) => /imagine-image|dall-e|gpt-image|flux|qwen-image|image-generation/i.test(m.id)) ??
      list.find((m) => /image/i.test(m.id) && !/vision|video/i.test(m.id))
    )
  }

  findDefaultVideoModel() {
    const list = this.catalog()
    return (
      list.find((m) => m.id === GROK_DEFAULT_VIDEO_MODEL) ??
      list.find((m) => /imagine-video|video-generation|text-to-video/i.test(m.id)) ??
      list.find((m) => /video/i.test(m.id) && !/vision/i.test(m.id))
    )
  }

  /**
   * OpenAI 兼容生图 / 修图。kind = generations | edits。
   * 上游走 /images/generations 或 /images/edits（xAI Grok Imagine、OpenAI 兼容通道）。
   */
  async handleImages(req, res, kind = 'generations') {
    const { user } = this.authenticate(req)
    const raw = await readBody(req)
    let body
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new HttpError(400, 'invalid JSON body')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求体必须是 JSON 对象', 'invalid_body')
    if (!String(body.prompt ?? '').trim()) throw new HttpError(400, '缺少 prompt', 'missing_prompt')
    if (kind === 'edits' && body.image == null && body.image_url == null && !Array.isArray(body.images)) {
      throw new HttpError(400, '编辑图片需要 image、image_url 或 images', 'missing_image')
    }
    let model
    if (body.model) {
      model = this.findModel(body.model)
      if (!model) throw new HttpError(404, '模型 ' + body.model + ' 不在公司目录里', 'model_not_found')
    } else {
      model = this.findDefaultImageModel()
      if (!model) throw new HttpError(404, '公司目录里没有生图模型', 'model_not_found')
    }
    const upstream = this.cfg.upstreams[model.provider]
    const path = kind === 'edits' ? '/images/edits' : '/images/generations'
    return this.withProviderLock(user.id + ':' + model.provider, () => {
      if (this.ledger.exceeded(user, model.provider)) {
        throw new HttpError(429, '本周 ' + model.providerLabel + ' 额度已用完，刷新时间 ' + (this.ledger.quotaView(user, [{ id: model.provider }])[0]?.refreshAt ?? ''), 'quota_exceeded')
      }
      if (upstream.kind === 'mock') return this.mockImages(user, model, body, res, kind)
      return this.proxyMedia(user, model, body, res, upstream, path, 'images')
    })
  }

  /**
   * OpenAI 兼容视频生成。上游走 /videos/generations（xAI Grok Imagine Video）。
   * 默认模型 grok-imagine-video-1.5。
   */
  async handleVideos(req, res) {
    const { user } = this.authenticate(req)
    const raw = await readBody(req)
    let body
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new HttpError(400, 'invalid JSON body')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求体必须是 JSON 对象', 'invalid_body')
    if (!String(body.prompt ?? '').trim()) throw new HttpError(400, '缺少 prompt', 'missing_prompt')
    let model
    if (body.model) {
      model = this.findModel(body.model)
      if (!model) throw new HttpError(404, '模型 ' + body.model + ' 不在公司目录里', 'model_not_found')
    } else {
      model = this.findDefaultVideoModel()
      if (!model) throw new HttpError(404, '公司目录里没有视频生成模型', 'model_not_found')
    }
    const upstream = this.cfg.upstreams[model.provider]
    return this.withProviderLock(user.id + ':' + model.provider, () => {
      if (this.ledger.exceeded(user, model.provider)) {
        throw new HttpError(429, '本周 ' + model.providerLabel + ' 额度已用完，刷新时间 ' + (this.ledger.quotaView(user, [{ id: model.provider }])[0]?.refreshAt ?? ''), 'quota_exceeded')
      }
      if (upstream.kind === 'mock') return this.mockVideos(user, model, body, res)
      return this.proxyMedia(user, model, body, res, upstream, '/videos/generations', 'videos')
    })
  }

  async mockImages(user, model, body, res, kind) {
    const started = Date.now()
    const n = Math.max(1, Math.min(4, Number(body.n) || 1))
    const usage = { prompt_tokens: Math.ceil(String(body.prompt).length / 4), completion_tokens: n * 1000, total_tokens: 0 }
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens
    this.ledger.record({
      userId: user.id,
      username: user.username,
      provider: model.provider,
      model: model.id,
      stream: false,
      status: 'ok',
      tag: kind === 'edits' ? 'images-edits' : 'images-generations',
      latencyMs: Date.now() - started,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      cachedTokens: 0,
      costCny: estimateCostCny(model, usage),
      usageKnown: true,
      priceKnown: !!model?.priceCnyPerM,
      ...this.mixedExtra(user),
    })
    sendJson(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: Array.from({ length: n }, () => ({ b64_json: MOCK_PNG_B64, revised_prompt: body.prompt })),
      usage,
    })
  }

  async mockVideos(user, model, body, res) {
    const started = Date.now()
    const usage = { prompt_tokens: Math.ceil(String(body.prompt).length / 4), completion_tokens: 4000, total_tokens: 0 }
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens
    this.ledger.record({
      userId: user.id,
      username: user.username,
      provider: model.provider,
      model: model.id,
      stream: false,
      status: 'ok',
      tag: 'videos-generations',
      latencyMs: Date.now() - started,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      cachedTokens: 0,
      costCny: estimateCostCny(model, usage),
      usageKnown: true,
      priceKnown: !!model?.priceCnyPerM,
      ...this.mixedExtra(user),
    })
    sendJson(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: [{ url: 'https://example.invalid/mock.mp4', revised_prompt: body.prompt }],
      usage,
    })
  }

  async proxyMedia(user, model, body, res, upstream, apiPath, kind) {
    const started = Date.now()
    const tag = apiPath.includes('edits') ? 'images-edits' : kind === 'videos' ? 'videos-generations' : 'images-generations'
    const finish = (usage, status, extra = {}) => {
      this.ledger.record({
        userId: user.id,
        username: user.username,
        provider: model.provider,
        model: model.id,
        stream: false,
        status,
        tag,
        latencyMs: Date.now() - started,
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        cachedTokens: usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0,
        costCny: estimateCostCny(model, usage),
        usageKnown: !!usage,
        priceKnown: !!model?.priceCnyPerM,
        ...this.mixedExtra(user),
        ...extra,
      })
    }
    const ac = new AbortController()
    const onResClose = () => {
      if (!res.writableEnded) ac.abort()
    }
    res.on('close', onResClose)
    let upstreamRes
    try {
      upstreamRes = await this.fetchUpstream(upstream, body, model, { stream: false, signal: ac.signal, path: apiPath })
    } catch (err) {
      if (ac.signal.aborted) return
      if (err instanceof HttpError) {
        // 网关自己的校验错误（缺参考图 / 通道不支持媒体 / 没有驱动模型）原样返回，别包装成"上游不可达"
        finish(undefined, 'rejected')
        throw err
      }
      finish(undefined, 'upstream_unreachable')
      throw new HttpError(502, '上游 ' + model.providerLabel + ' 不可达：' + err.message, 'upstream_unreachable')
    }
    const text = await upstreamRes.text()
    if (!upstreamRes.ok) {
      finish(undefined, 'upstream_' + upstreamRes.status)
      res.writeHead(upstreamRes.status, { 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' })
      res.end(text)
      return
    }
    let usage
    try {
      const json = JSON.parse(text)
      usage = json.usage
      if (!usage && Array.isArray(json.data)) {
        const n = json.data.length || 1
        usage = { prompt_tokens: Math.ceil(String(body.prompt).length / 4), completion_tokens: n * 1000, total_tokens: 0 }
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens
      }
    } catch {
      /* 原样回传 */
    }
    finish(usage, 'ok')
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(text)
  }

  /** (userId:provider) → 排队链 的简单先到先服务门闩。 */
  locks = new Map()
  async withProviderLock(key, fn) {
    const prev = this.locks.get(key) ?? Promise.resolve()
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const next = prev.then(() => gate)
    this.locks.set(key, next)
    await prev.catch(() => {})
    try {
      return await fn()
    } finally {
      release()
      if (this.locks.get(key) === next) this.locks.delete(key)
    }
  }

  async mockChat(user, model, body, res, upstream) {
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
        usageKnown: !!usage,
        priceKnown: !!model?.priceCnyPerM,
        ...this.mixedExtra(user),
        ...extra,
      })
    }
    return this.mock(body, model, res, stream, finish)
  }

  /** 真正的上游转发（在 withProviderLock 内串行执行）。 */
  async proxyChat(user, model, body, res, upstream) {
    const started = Date.now()
    const stream = body.stream === true
    const finish = (usage, status, extra = {}) => {
      const priceKnown = !!model?.priceCnyPerM
      const usageKnown = !!usage
      const cost = usageKnown && priceKnown ? estimateCostCny(model, usage) : (usageKnown ? 0 : null)
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
        usageKnown,
        priceKnown,
        ...this.mixedExtra(user),
        ...extra,
      })
    }

    const ac = new AbortController()
    // 客户端断连要取消上游（不然生成照跑、额度照扣）：req 'close' 在请求体读完的那一刻就触发过，
    // 此刻挂监听永远等不到下一次，所以挂在响应侧 —— 连接断了且响应还没写完就 abort。
    const onResClose = () => {
      if (!res.writableEnded) ac.abort()
    }
    res.on('close', onResClose)
    let upstreamRes
    try {
      upstreamRes = await this.fetchUpstream(upstream, body, model, { stream, signal: ac.signal })
    } catch (err) {
      if (ac.signal.aborted) return
      finish(undefined, 'upstream_unreachable')
      throw new HttpError(502, '上游 ' + model.providerLabel + ' 不可达：' + err.message, 'upstream_unreachable')
    }
    if (!upstreamRes.ok) {
      const text = await upstreamRes.text()
      finish(undefined, 'upstream_' + upstreamRes.status)
      if (isUpstreamQuotaExhausted(upstreamRes.status, text)) {
        throw new HttpError(429, quotaExhaustedMessage(upstream), 'upstream_quota_exhausted')
      }
      res.writeHead(upstreamRes.status, { 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' })
      res.end(text)
      return
    }
    const anthropic = usesAnthropicMessages(upstream)
    const codex = usesChatgptCodex(upstream)
    if (!stream) {
      const text = await upstreamRes.text()
      let payload = text
      let usage
      if (codex) {
        const translator = createCodexSseTranslator({ model: model.id })
        translator.push(text)
        translator.end()
        const converted = {
          id: 'chatcmpl-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: model.id,
          choices: [{ index: 0, message: translator.message, finish_reason: translator.finishReason }],
          usage: translator.usage,
        }
        usage = converted.usage
        payload = JSON.stringify(converted)
      } else if (anthropic) {
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
    if (codex) return this.pipeCodexStream(upstreamRes, res, model, finish, ac)
    if (anthropic) return this.pipeAnthropicStream(upstreamRes, res, model, finish, ac)
    return this.pipeOpenAIStream(upstreamRes, res, finish, ac)
  }


  liveUpstream(upstream) {
    return this.cfg.upstreams[upstream.id] ?? upstream
  }

  accountPool(upstream) {
    const live = this.liveUpstream(upstream)
    const accs = Array.isArray(live.accounts) && live.accounts.length
      ? live.accounts
      : live.resolvedKey
        ? [{ id: 'primary', credential: live.resolvedKey, chatgptAccountId: live.chatgptAccountId, googleProjectId: live.googleProjectId, status: 'active' }]
        : []
    const now = Date.now()
    const ready = []
    const exhausted = []
    for (const a of accs) {
      const cool = a.status === 'exhausted' && a.exhaustedUntil && Date.parse(a.exhaustedUntil) > now
      if (cool) exhausted.push(a)
      else ready.push(a)
    }
    return [...ready, ...exhausted]
  }

  withAccount(upstream, acc) {
    if (!acc) return upstream
    return {
      ...upstream,
      resolvedKey: acc.credential ?? upstream.resolvedKey,
      chatgptAccountId: acc.chatgptAccountId ?? upstream.chatgptAccountId,
      googleProjectId: acc.googleProjectId,
      authStyle: acc.authStyle ?? upstream.authStyle,
    }
  }

  async prepareUpstream(upstream, { force = false, accountId } = {}) {
    if (!this.oauth || !upstream?.channel) return this.liveUpstream(upstream)
    try {
      await this.oauth.ensureFresh(upstream.channel, { force, accountId })
    } catch (err) {
      console.warn(`[gateway] OAuth 续期失败 ${upstream.channel}: ${err.message}`)
    }
    return this.liveUpstream(upstream)
  }

  async fetchUpstream(upstream, body, model, opts) {
    const pool = this.accountPool(upstream)
    const bind = (live, acc) => {
      const fresh = (live.accounts ?? []).find((a) => a.id === acc?.id) ?? acc
      return this.withAccount(live, fresh)
    }
    if (pool.length <= 1) {
      const acc = pool[0]
      let current = bind(await this.prepareUpstream(upstream, { accountId: acc?.id }), acc)
      let res = await this.sendUpstream(current, body, model, opts)
      if (res.status === 401 && this.oauth && current.channel) {
        current = bind(await this.prepareUpstream(current, { force: true, accountId: acc?.id }), acc)
        res = await this.sendUpstream(current, body, model, opts)
      }
      if (acc?.id && isUpstreamQuotaExhausted(res.status, await res.clone().text().catch(() => ''))) {
        this.channels?.markAccountExhausted?.(upstream.channel, acc.id, { error: 'quota exhausted' })
      }
      return res
    }
    let last = null
    for (let i = 0; i < pool.length; i++) {
      const acc = pool[i]
      let current = bind(await this.prepareUpstream(upstream, { accountId: acc.id }), acc)
      let res = await this.sendUpstream(current, body, model, opts)
      if (res.status === 401 && this.oauth && current.channel) {
        current = bind(await this.prepareUpstream(current, { force: true, accountId: acc.id }), acc)
        res = await this.sendUpstream(current, body, model, opts)
      }
      if (res.ok) return res
      const peek = await res.clone().text().catch(() => '')
      if (isUpstreamQuotaExhausted(res.status, peek)) {
        this.channels?.markAccountExhausted?.(upstream.channel, acc.id, { error: peek.slice(0, 200) })
        if (i < pool.length - 1) {
          last = res
          continue
        }
      }
      return res
    }
    return last
  }

  /**
   * ChatGPT 订阅（Codex）出图：上游没有 /images/*，用 Responses 的 image_generation 工具生成，
   * 再把结果包成 OpenAI /images 的形状回给调用方。n>1 逐张生成。
   */
  async codexImages(upstream, body, model, apiPath, { signal } = {}) {
    const driver = (upstream.models ?? []).find((m) => m?.id && !/image|video|dall-e|imagine|wanx|flux/i.test(m.id))
    if (!driver) throw new HttpError(400, '该订阅通道里没有可用来驱动 image_generation 的对话模型', 'no_image_driver')
    const driverModel = driver.upstreamModel ?? driver.id
    const count = Math.max(1, Math.min(4, Number(body.n) || 1))
    const data = []
    let usage = null
    for (let i = 0; i < count; i++) {
      const reqBody = toCodexImageBody(body, driverModel)
      const res = await fetch(chatgptResponsesUrl(upstream.baseUrl), {
        method: 'POST',
        headers: chatgptHeaders(upstream.resolvedKey, { accountId: upstream.chatgptAccountId }),
        body: JSON.stringify(reqBody),
        signal,
      })
      const text = await res.text()
      if (!res.ok) {
        return new Response(text || JSON.stringify({ error: { message: `上游 HTTP ${res.status}` } }), {
          status: res.status,
          headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
        })
      }
      const parsed = parseCodexImageStream(text)
      if (!parsed.b64) throw new HttpError(502, parsed.error || '订阅通道没有返回图片', 'empty')
      data.push({ b64_json: parsed.b64, ...(parsed.revisedPrompt ? { revised_prompt: parsed.revisedPrompt } : {}) })
      usage = parsed.usage ?? usage
    }
    return new Response(JSON.stringify({ created: Math.floor(Date.now() / 1000), data, usage }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }

  /**
   * DashScope（阿里云百炼）出图：OpenAI /images/* ↔ 原生接口。
   * qwen-image 系列走同步 multimodal-generation；该模型不支持时退回异步 text2image + 轮询。
   */
  async dashscopeImages(upstream, body, model, apiPath, { signal } = {}) {
    const origin = dashscopeOrigin(upstream.baseUrl)
    const modelId = model.upstreamModel ?? model.id
    const count = Math.max(1, Math.min(4, Number(body.n) || 1))
    const data = []
    let usage = null
    for (let i = 0; i < count; i++) {
      const one = await this.dashscopeImageOnce(origin, upstream, body, modelId, { signal })
      data.push({ b64_json: one.b64, ...(one.revisedPrompt ? { revised_prompt: one.revisedPrompt } : {}) })
      usage = one.usage ?? usage
    }
    return new Response(JSON.stringify({ created: Math.floor(Date.now() / 1000), data, usage }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }

  async dashscopeImageOnce(origin, upstream, body, modelId, { signal } = {}) {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${upstream.resolvedKey}` }
    const errors = []
    const post = async (url, payload, extra = {}) => {
      const res = await fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(payload), signal })
      const text = await res.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        /* 非 JSON 上游错误：留原文 */
      }
      return { res, text, json }
    }
    const finish = async (parsed) => {
      const b64 = parsed.b64 || (parsed.url ? await this.fetchImageB64(parsed.url, signal) : '')
      if (!b64) throw new HttpError(502, errors.filter(Boolean).join('；') || 'DashScope 没有返回图片', 'empty')
      return { b64, revisedPrompt: parsed.revisedPrompt, usage: parsed.usage }
    }
    const waitTask = async (taskId) => {
      const deadline = Date.now() + 150_000
      const pollMs = Number(process.env.DESK_DASHSCOPE_POLL_MS || 2000)
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollMs))
        const res = await fetch(`${origin}/api/v1/tasks/${encodeURIComponent(taskId)}`, { headers, signal })
        const text = await res.text()
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          /* ignore */
        }
        const parsed = parseDashscopeImage(json)
        if (/SUCCEEDED/i.test(parsed.status)) return parsed
        if (/FAILED|CANCELED|UNKNOWN/i.test(parsed.status)) {
          errors.push(parsed.error || parsed.code || `任务 ${parsed.status}`)
          return null
        }
      }
      errors.push('DashScope 出图超时')
      return null
    }

    // 1) 同步多模态（qwen-image 系列）
    const sync = await post(`${origin}/api/v1/services/aigc/multimodal-generation/generation`, toDashscopeImageBody(body, modelId))
    const syncParsed = parseDashscopeImage(sync.json)
    if (sync.res.ok) {
      if (syncParsed.b64 || syncParsed.url) return finish(syncParsed)
      if (syncParsed.taskId) {
        const done = await waitTask(syncParsed.taskId)
        if (done) return finish(done)
      } else {
        errors.push(syncParsed.error || 'multimodal 返回空结果')
      }
    } else {
      errors.push(syncParsed.error || syncParsed.code || `multimodal HTTP ${sync.res.status}`)
    }

    // 2) 异步 text2image（wanx 系列）
    const asyn = await post(
      `${origin}/api/v1/services/aigc/text2image/image-synthesis`,
      toDashscopeImageBody(body, modelId, { async: true }),
      { 'x-dashscope-async': 'enable' },
    )
    const asynParsed = parseDashscopeImage(asyn.json)
    if (asyn.res.ok) {
      if (asynParsed.b64 || asynParsed.url) return finish(asynParsed)
      if (asynParsed.taskId) {
        const done = await waitTask(asynParsed.taskId)
        if (done) return finish(done)
      } else {
        errors.push(asynParsed.error || 'text2image 返回空结果')
      }
    } else {
      errors.push(asynParsed.error || asynParsed.code || `text2image HTTP ${asyn.res.status}`)
    }
    throw new HttpError(502, errors.filter(Boolean).join('；') || 'DashScope 出图失败', 'dashscope_failed')
  }

  async fetchImageB64(url, signal) {
    const raw = String(url ?? '')
    const dataUrl = /^data:image\/[^;]+;base64,(.+)$/i.exec(raw)
    if (dataUrl) return dataUrl[1]
    const res = await fetch(raw, { signal })
    if (!res.ok) throw new HttpError(502, `下载上游图片失败 HTTP ${res.status}`, 'download_failed')
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.toString('base64')
  }

  sendUpstream(upstream, body, model, { stream, signal, path: apiPath } = {}) {
    if (apiPath && apiPath !== '/chat/completions') {
      if (usesChatgptCodex(upstream)) {
        if (String(apiPath).includes('/images')) return this.codexImages(upstream, body, model, apiPath, { signal })
        throw new HttpError(400, '该上游不支持媒体接口（ChatGPT 订阅只支持对话与图片生成）', 'media_unsupported')
      }
      if (usesDashscopeImages(upstream) && String(apiPath).includes('/images')) {
        return this.dashscopeImages(upstream, body, model, apiPath, { signal })
      }
      if (usesAnthropicMessages(upstream) || usesCloudCodePa(upstream)) {
        throw new HttpError(400, '该上游不支持媒体接口（仅 OpenAI 兼容通道，如 Grok / xAI）', 'media_unsupported')
      }
      const forward = mediaForwardBody(body, model, apiPath)
      const p = apiPath.startsWith('/') ? apiPath : '/' + apiPath
      return fetch(openaiCompatUrl(upstream.baseUrl, p), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${upstream.resolvedKey}`, accept: 'application/json' },
        body: JSON.stringify(forward),
        signal,
      })
    }
    if (usesCloudCodePa(upstream)) return sendGeminiRequest(upstream, body, model, { stream, signal })
    if (usesChatgptCodex(upstream)) {
      const forward = toCodexResponsesBody({ ...body, stream: true }, model)
      return fetch(chatgptResponsesUrl(upstream.baseUrl), {
        method: 'POST',
        headers: {
          ...chatgptHeaders(upstream.resolvedKey, { accountId: upstream.chatgptAccountId }),
          session_id: crypto.randomUUID(),
        },
        body: JSON.stringify(forward),
        signal,
      })
    }
    if (usesAnthropicMessages(upstream)) {
      const forward = toAnthropicBody({ ...body, stream }, model)
      return fetch(anthropicMessagesUrl(upstream.baseUrl), {
        method: 'POST',
        headers: { ...anthropicHeaders(upstream.resolvedKey, { authStyle: upstream.authStyle }), accept: stream ? 'text/event-stream' : 'application/json' },
        body: JSON.stringify(forward),
        signal,
      })
    }
    const forward = { ...body, model: model.upstreamModel }
    if (stream) forward.stream_options = { ...(body.stream_options ?? {}), include_usage: true }
    return fetch(openaiCompatUrl(upstream.baseUrl, '/chat/completions'), {
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

  async pipeCodexStream(upstreamRes, res, model, finish, ac) {
    const translator = createCodexSseTranslator({ model: model.id })
    const reader = upstreamRes.body.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        for (const piece of translator.push(decoder.decode(value, { stream: true }))) res.write(piece)
      }
      for (const piece of translator.push(decoder.decode())) res.write(piece)
      for (const piece of translator.end()) res.write(piece)
      finish(translator.usage, 'ok')
      res.end()
    } catch (err) {
      finish(translator.usage, ac.signal.aborted ? 'client_aborted' : 'stream_error')
      try {
        if (!ac.signal.aborted) res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'upstream_error', code: 'codex_stream_error' } })}\n\n`)
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
    const upstream = this.cfg.upstreams[model.provider]
    return this.withProviderLock(user.id + ':' + model.provider, async () => {
      if (this.ledger.exceeded(user, model.provider)) throw new HttpError(429, `本周 ${model.providerLabel} 额度已用完`, 'quota_exceeded')
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
        let json
        if (usesChatgptCodex(upstream)) {
          const translator = createCodexSseTranslator({ model: model.id })
          translator.push(text)
          translator.end()
          json = {
            choices: [{ message: { role: 'assistant', content: translator.text } }],
            usage: translator.usage,
          }
        } else {
          json = usesAnthropicMessages(upstream) ? toOpenAIResponse(JSON.parse(text), model.id) : JSON.parse(text)
        }
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
        usageKnown: !!usage,
        priceKnown: !!model?.priceCnyPerM,
        ...this.mixedExtra(user),
      })
      return { content, usage, latencyMs, model: model.id }
    })
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

/** Grok 默认生图模型。请求未带 model 时优先用它。 */
const GROK_DEFAULT_IMAGE_MODEL = 'grok-imagine-image-2.0'

/** Grok 默认视频生成模型。请求未带 model 时优先用它。 */
const GROK_DEFAULT_VIDEO_MODEL = 'grok-imagine-video-1.5'

/** 1×1 PNG（mock 生图用）。 */
const MOCK_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function mediaForwardBody(body, model, apiPath) {
  const forward = { ...body, model: model.upstreamModel ?? model.id }
  delete forward.stream
  delete forward.stream_options
  delete forward.messages
  delete forward.max_tokens
  delete forward.thinking
  const video = typeof apiPath === 'string' && apiPath.includes('/videos')
  if (video) {
    if (forward.duration == null) forward.duration = 6
    if (forward.aspect_ratio == null) forward.aspect_ratio = '16:9'
    return forward
  }
  if (forward.n == null) forward.n = 1
  if (!forward.response_format) forward.response_format = 'b64_json'
  return forward
}
