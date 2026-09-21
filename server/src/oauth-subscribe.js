/**
 * 订阅通道官方 OAuth（授权码 + PKCE / 设备码）。
 * 令牌只落在服务端，与手动粘贴同一套 channels.connect；不抓 cookie、不伪造登录页。
 * ChatGPT 对齐 Codex CLI 设备码；Grok 对齐 Grok CLI 的 RFC 8628 设备码；Claude 对齐 Claude Code 浏览器授权（回调页贴回授权码）。
 * Antigravity 对齐 CPA / CLIProxyAPI 的 Cloud Code 客户端（端口 51121）。
 */
import crypto from 'node:crypto'
import { HttpError, readJson, sendJson, parseUrl } from './http.js'
import { providerSpec } from './oauth-providers/index.js'
import { accountIdFromToken, decodeJwtPayload, needsRefresh, resolveConnectBaseUrl } from './oauth-tokens.js'
import { setupGeminiProject } from './upstream-gemini.js'
import { accountsOf, normalizeModels } from './channels.js'
import { discoverUpstreamModels, mergeDiscoveredModels } from './upstream-models.js'

const SESSION_TTL_MS = 10 * 60 * 1000
const CALLBACK_PATH = '/api/oauth/callback'

export function callbackUrl(cfg) {
  const base = String(cfg.publicUrl ?? '').replace(/\/+$/, '')
  return `${base}${CALLBACK_PATH}`
}

function envKey(channelId, suffix) {
  return `OAUTH_${String(channelId).toUpperCase()}_${suffix}`
}

function pick(cfgVal, envVal) {
  const fromCfg = cfgVal == null ? '' : String(cfgVal).trim()
  if (fromCfg) return fromCfg
  const fromEnv = envVal == null ? '' : String(envVal).trim()
  return fromEnv
}

/** Claude Code 回调页常见 `CODE#STATE`，或整段 callback URL。 */
export function parsePastedOAuth(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return { code: '', state: '' }
  try {
    const u = new URL(s)
    const fromQuery = u.searchParams.get('code')
    if (fromQuery) return { code: fromQuery.split('#')[0], state: u.searchParams.get('state') || '' }
    if (u.hash) {
      const h = new URLSearchParams(u.hash.replace(/^#/, ''))
      if (h.get('code')) return { code: h.get('code'), state: h.get('state') || '' }
    }
  } catch {
    /* 不是 URL */
  }
  const hash = s.indexOf('#')
  if (hash >= 0) {
    return {
      code: s.slice(0, hash).replace(/^code=/i, '').trim(),
      state: s.slice(hash + 1).trim(),
    }
  }
  return { code: s.replace(/^code=/i, '').trim(), state: '' }
}

export function parsePastedOAuthCode(raw) {
  return parsePastedOAuth(raw).code
}

export function resolveProviderConfig(channelId, cfg) {
  const spec = providerSpec(channelId)
  if (!spec?.oauth) return null
  const fromCfg = cfg.oauth?.[channelId] ?? {}
  return {
    ...spec,
    clientId: pick(fromCfg.clientId, process.env[envKey(channelId, 'CLIENT_ID')]) || spec.clientId,
    clientSecret: pick(fromCfg.clientSecret, process.env[envKey(channelId, 'CLIENT_SECRET')]) || (pick(fromCfg.clientId, process.env[envKey(channelId, 'CLIENT_ID')]) ? undefined : spec.clientSecret),
    projectId: pick(fromCfg.projectId, process.env[envKey(channelId, 'PROJECT_ID')]),
    authorizeUrl: pick(fromCfg.authorizeUrl, process.env[envKey(channelId, 'AUTHORIZE_URL')]) || spec.authorizeUrl,
    tokenUrl: pick(fromCfg.tokenUrl, process.env[envKey(channelId, 'TOKEN_URL')]) || spec.tokenUrl,
    scope: pick(fromCfg.scope, process.env[envKey(channelId, 'SCOPE')]) || spec.scope,
    redirectUri: pick(fromCfg.redirectUri, process.env[envKey(channelId, 'REDIRECT_URI')]) || spec.redirectUri,
    deviceUserCodeUrl: pick(fromCfg.deviceUserCodeUrl, process.env[envKey(channelId, 'DEVICE_USERCODE_URL')]) || spec.deviceUserCodeUrl,
    devicePollUrl: pick(fromCfg.devicePollUrl, process.env[envKey(channelId, 'DEVICE_POLL_URL')]) || spec.devicePollUrl,
    verificationUri: pick(fromCfg.verificationUri, process.env[envKey(channelId, 'VERIFICATION_URI')]) || spec.verificationUri,
    deviceRedirectUri: pick(fromCfg.deviceRedirectUri, process.env[envKey(channelId, 'DEVICE_REDIRECT_URI')]) || spec.deviceRedirectUri,
    flow: fromCfg.flow || spec.flow || 'authorization_code',
    deviceStyle: fromCfg.deviceStyle || spec.deviceStyle || (spec.flow === 'device_code' ? 'codex' : null),
    tokenBody: fromCfg.tokenBody || spec.tokenBody || 'form',
    authStyle: fromCfg.authStyle || spec.authStyle || 'bearer',
  }
}

export function describeOAuth(channel, cfg) {
  const redirect = callbackUrl(cfg)
  if (!channel || channel.kind !== 'subscription') {
    return { available: false, configured: false, flow: null, reason: null, callbackUrl: redirect }
  }
  const spec = providerSpec(channel.id)
  if (!spec?.oauth) {
    return {
      available: false,
      configured: false,
      flow: null,
      reason: spec?.reason ?? '该平台无官方 OAuth，仍需粘贴令牌',
      detail: spec?.detail ?? null,
      callbackUrl: redirect,
    }
  }
  const resolved = resolveProviderConfig(channel.id, cfg)
  const configured = !!resolved?.clientId
  const flow = resolved.flow || 'authorization_code'
  return {
    available: true,
    configured,
    flow,
    reason: configured ? null : `请先配置 OAuth 应用：环境变量 ${envKey(channel.id, 'CLIENT_ID')} 或 config.json 的 oauth.${channel.id}.clientId`,
    callbackUrl: flow === 'authorization_code' ? redirect : resolved.redirectUri || redirect,
    providerLabel: spec.label,
    detail: spec.detail ?? null,
    pasteHint: spec.pasteHint ?? null,
  }
}

export function decorateChannels(list, cfg) {
  return (list ?? []).map((c) => ({ ...c, oauth: describeOAuth(c, cfg) }))
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

function positiveInt(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function publicModels(session) {
  if (session.status !== 'authorized') return undefined
  return (session.discoveredModels ?? []).map((m) => ({
    id: m.id,
    ...(m.name ? { name: m.name } : {}),
  }))
}

function publicStatus(session) {
  return {
    status: session.status,
    error: session.error ?? null,
    channel: session.channel ?? null,
    flow: session.flow ?? null,
    userCode: session.userCode ?? null,
    verificationUri: session.verificationUri ?? null,
    models: publicModels(session),
  }
}

function renderCallbackPage(ok, message) {
  const text = String(message ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>订阅授权</title>
<style>body{font:14px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:32px;color:#1c1c1c}</style>
</head><body>
<p>${text || (ok ? '已登录。请回到原窗口选择要接入的模型。' : '授权失败')}</p>
<script>try{if(window.opener)window.opener.postMessage({type:'desk-oauth-subscribe',ok:${ok ? 'true' : 'false'}},window.location.origin)}catch(e){}</script>
</body></html>`
}

export class OAuthSubscribe {
  constructor({ cfg, channels, fetchImpl } = {}) {
    this.cfg = cfg
    this.channels = channels
    this.fetchImpl = fetchImpl ?? fetch
    this.sessions = new Map()
    this.refreshing = new Map()
  }

  gc() {
    const now = Date.now()
    for (const [state, s] of this.sessions) {
      if (now - s.createdAt > SESSION_TTL_MS) this.sessions.delete(state)
    }
  }

  newSession(channelId, user, input, extra = {}) {
    this.channels.find(channelId)
    const models = String(input.models ?? '').trim()
    const state = crypto.randomBytes(24).toString('base64url')
    const session = {
      state,
      channelId,
      userId: user.id,
      username: user.username,
      models,
      contextWindow: input.contextWindow,
      maxTokens: input.maxTokens,
      reasoningEfforts: input.reasoningEfforts,
      baseUrl: input.baseUrl,
      status: 'pending',
      createdAt: Date.now(),
      ...extra,
    }
    this.gc()
    this.sessions.set(state, session)
    return session
  }

  start(channelId, user, input = {}) {
    if (!this.channels) throw new HttpError(500, '通道模块未启用')
    const channel = this.channels.find(channelId)
    const desc = describeOAuth(channel, this.cfg)
    if (!desc.available) throw new HttpError(400, desc.reason, 'oauth_unsupported')
    if (!desc.configured) throw new HttpError(400, desc.reason, 'oauth_not_configured')
    const provider = resolveProviderConfig(channelId, this.cfg)
    if (provider.flow === 'device_code') return this.startDevice(channel, user, input, provider)
    return this.startAuthorize(channel, user, input, provider)
  }

  startAuthorize(channel, user, input, provider) {
    const { verifier, challenge } = pkce()
    const redirectUri = provider.redirectUri || callbackUrl(this.cfg)
    const session = this.newSession(channel.id, user, input, {
      flow: provider.flow || 'authorization_code',
      verifier,
      redirectUri,
    })
    const url = new URL(provider.authorizeUrl)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', provider.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('scope', provider.scope)
    url.searchParams.set('state', session.state)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    for (const [key, value] of Object.entries(provider.authorizeParams ?? {})) url.searchParams.set(key, value)
    console.log(`[gateway] OAuth 发起 ${channel.label} state=${session.state.slice(0, 6)}…`)
    return {
      flow: session.flow,
      authorizeUrl: url.toString(),
      state: session.state,
      callbackUrl: redirectUri,
    }
  }

  async startDevice(channel, user, input, provider) {
    if ((provider.deviceStyle || 'codex') === 'rfc8628') return this.startDeviceRfc(channel, user, input, provider)
    if (!provider.deviceUserCodeUrl) throw new HttpError(500, '未配置设备码端点', 'oauth_no_device')
    let res
    try {
      res = await this.fetchImpl(provider.deviceUserCodeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'valimart-harness' },
        body: JSON.stringify({ client_id: provider.clientId }),
      })
    } catch (err) {
      throw new HttpError(502, `设备码端点不可达：${err.message}`, 'oauth_device_unreachable')
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !(data.user_code || data.usercode) || !data.device_auth_id) {
      throw new HttpError(502, '申请设备码失败', 'oauth_device_failed')
    }
    const userCode = data.user_code || data.usercode
    const verificationUri = provider.verificationUri || data.verification_uri || data.verification_url
    const session = this.newSession(channel.id, user, input, {
      flow: 'device_code',
      deviceStyle: 'codex',
      userCode,
      deviceAuthId: data.device_auth_id,
      verificationUri,
      intervalMs: Math.max(1000, Number(data.interval ?? 5) * 1000),
    })
    console.log(`[gateway] OAuth 设备码 ${channel.label} state=${session.state.slice(0, 6)}…`)
    return {
      flow: 'device_code',
      state: session.state,
      userCode,
      verificationUri,
      verificationUriComplete: data.verification_uri_complete || verificationUri,
      interval: Number(data.interval ?? 5),
    }
  }

  async startDeviceRfc(channel, user, input, provider) {
    if (!provider.deviceUserCodeUrl) throw new HttpError(500, '未配置设备码端点', 'oauth_no_device')
    let res
    try {
      res = await this.fetchImpl(provider.deviceUserCodeUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'user-agent': 'valimart-harness',
        },
        body: new URLSearchParams({
          client_id: provider.clientId,
          scope: provider.scope || '',
        }),
      })
    } catch (err) {
      throw new HttpError(502, `设备码端点不可达：${err.message}`, 'oauth_device_unreachable')
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !(data.user_code || data.usercode) || !data.device_code) {
      throw new HttpError(502, '申请设备码失败', 'oauth_device_failed')
    }
    const userCode = data.user_code || data.usercode
    const verificationUri = data.verification_uri || data.verification_url || provider.verificationUri
    const session = this.newSession(channel.id, user, input, {
      flow: 'device_code',
      deviceStyle: 'rfc8628',
      userCode,
      deviceCode: data.device_code,
      verificationUri,
      intervalMs: Math.max(0, Number(data.interval ?? 5) * 1000),
    })
    console.log(`[gateway] OAuth 设备码 ${channel.label} state=${session.state.slice(0, 6)}…`)
    return {
      flow: 'device_code',
      state: session.state,
      userCode,
      verificationUri,
      verificationUriComplete: data.verification_uri_complete || verificationUri,
      interval: Number(data.interval ?? 5),
    }
  }

  async status(state, user) {
    const s = this.sessions.get(state)
    if (!s) throw new HttpError(404, '授权会话不存在或已过期', 'oauth_state_unknown')
    if (s.userId !== user.id) throw new HttpError(403, '不是你发起的授权', 'forbidden')
    if (s.flow === 'device_code' && s.status === 'pending') {
      try {
        await this.pollDeviceOnce(s)
      } catch (err) {
        if (err instanceof HttpError && err.code === 'oauth_device_pending') {
          /* 用户还没在浏览器里确认 */
        } else if (err instanceof HttpError) {
          s.status = 'error'
          s.error = err.message
        } else {
          s.status = 'error'
          s.error = err.message
        }
      }
    }
    return publicStatus(s)
  }

  async complete(channelId, user, input = {}) {
    const state = String(input.state ?? '')
    const s = this.sessions.get(state)
    if (!s) throw new HttpError(400, '无效或过期的 state', 'oauth_bad_state')
    if (s.userId !== user.id) throw new HttpError(403, '不是你发起的授权', 'forbidden')
    if (s.channelId !== channelId) throw new HttpError(400, '通道与授权会话不一致', 'oauth_channel_mismatch')
    const pasted = parsePastedOAuth(input.code)
    if (resolveProviderConfig(channelId, this.cfg)?.requirePastedState && !pasted.state) throw new HttpError(400, '请粘贴含 code 和 state 的完整回调网址。', 'oauth_state_required')
    if (pasted.state && pasted.state !== s.state) throw new HttpError(400, '授权码与本次登录不匹配', 'oauth_state_mismatch')
    await this.finishWithCode(s, { code: pasted.code })
    return publicStatus(s)
  }

  async handleCallback(query) {
    const state = String(query.state ?? '')
    const s = this.sessions.get(state)
    if (!s) throw new HttpError(400, '无效或过期的 state', 'oauth_bad_state')
    await this.finishWithCode(s, query)
    return s
  }

  async finishWithCode(s, query) {
    if (s.status !== 'pending') throw new HttpError(400, '该授权已处理', 'oauth_replay')
    if (Date.now() - s.createdAt > SESSION_TTL_MS) {
      s.status = 'error'
      s.error = '授权已过期'
      throw new HttpError(400, '授权已过期', 'oauth_expired')
    }
    if (query.error) {
      s.status = 'error'
      s.error = String(query.error_description || query.error)
      throw new HttpError(400, s.error, 'oauth_denied')
    }
    const code = parsePastedOAuthCode(query.code)
    if (!code) throw new HttpError(400, '缺少授权码', 'oauth_no_code')
    const provider = resolveProviderConfig(s.channelId, this.cfg)
    const tokens = await this.exchange(provider, code, s)
    await this.authorizeTokens(s, provider, tokens)
    return s
  }

  async authorizeTokens(s, provider, tokens) {
    const access = tokens.access_token
    if (!access) throw new HttpError(502, '令牌端点未返回 access_token', 'oauth_no_token')
    const expiresIn = Number(tokens.expires_in)
    const channelDef = this.channels.find(s.channelId)
    const baseUrl = resolveConnectBaseUrl(s.baseUrl, provider, channelDef.baseUrl)
    const googleProjectId = provider.upstreamApi === 'gemini-code-assist'
      ? await setupGeminiProject({ credential: access, baseUrl, projectId: provider.projectId, fetchImpl: this.fetchImpl })
      : undefined
    const discovered = await discoverUpstreamModels({
      baseUrl,
      credential: access,
      api: provider.upstreamApi ?? channelDef.api,
      authStyle: provider.authStyle,
      channel: channelDef,
      fetchImpl: this.fetchImpl,
    }).catch((err) => ({ models: [], source: 'error', reason: err.message }))
    let catalog = discovered.models ?? []
    if (catalog.length === 0) catalog = normalizeModels(s.models)
    if (catalog.length === 0) catalog = normalizeModels(channelDef.hint)
    if (catalog.length === 0) {
      s.status = 'error'
      s.error = '未能自动发现模型，请手动填写模型 id'
      throw new HttpError(400, s.error, 'models_required')
    }
    s.pending = {
      access,
      refreshToken: tokens.refresh_token,
      expiresIn,
      baseUrl,
      authStyle: provider.authStyle,
      api: provider.upstreamApi,
      oauthProvider: s.channelId,
      googleProjectId,
      googleAccountId: provider.upstreamApi === 'gemini-code-assist' || provider.upstreamApi === 'antigravity' ? decodeJwtPayload(tokens.id_token)?.sub : undefined,
      chatgptAccountId: accountIdFromToken(tokens.id_token || access),
    }
    s.discoveredModels = catalog
    s.verifier = undefined
    s.deviceAuthId = undefined
    s.deviceCode = undefined
    s.status = 'authorized'
    s.channel = { id: channelDef.id, label: channelDef.label, connected: false, models: catalog.map((m) => m.id) }
    console.log(`[gateway] OAuth 已登录 ${channelDef.label}，待选模型 ${catalog.length} 个 state=${s.state.slice(0, 6)}…`)
    return s
  }

  async commit(channelId, user, input = {}) {
    const state = String(input.state ?? '')
    const s = this.sessions.get(state)
    if (!s) throw new HttpError(400, '无效或过期的 state', 'oauth_bad_state')
    if (s.userId !== user.id) throw new HttpError(403, '不是你发起的授权', 'forbidden')
    if (s.channelId !== channelId) throw new HttpError(400, '通道与授权会话不一致', 'oauth_channel_mismatch')
    if (s.status !== 'authorized' || !s.pending) throw new HttpError(400, '请先完成登录再选择模型', 'oauth_not_authorized')
    if (Date.now() - s.createdAt > SESSION_TTL_MS) {
      s.status = 'error'
      s.error = '授权已过期'
      throw new HttpError(400, '授权已过期', 'oauth_expired')
    }
    const selected = normalizeModels(input.models)
    if (selected.length === 0) throw new HttpError(400, '请至少选择一个模型', 'models_required')
    const channelDef = this.channels.find(s.channelId)
    const contextWindow = positiveInt(input.contextWindow) ?? s.contextWindow
    const maxTokens = positiveInt(input.maxTokens) ?? s.maxTokens
    const reasoningEfforts = input.reasoningEfforts ?? s.reasoningEfforts
    const overrides = { ...s, contextWindow, maxTokens, reasoningEfforts }
    const models = mergeDiscoveredModels(selected, s.discoveredModels, overrides, channelDef)
    const p = s.pending
    const channel = this.channels.connect(
      s.channelId,
      {
        credential: p.access,
        googleProjectId: p.googleProjectId,
        googleAccountId: p.googleAccountId,
        models,
        contextWindow,
        maxTokens,
        reasoningEfforts,
        baseUrl: p.baseUrl,
        refreshToken: p.refreshToken,
        oauthProvider: p.oauthProvider,
        authStyle: p.authStyle,
        tokenExpiresAt: Number.isFinite(p.expiresIn) ? new Date(Date.now() + p.expiresIn * 1000).toISOString() : undefined,
        api: p.api,
        chatgptAccountId: p.chatgptAccountId,
      },
      { id: s.userId, username: s.username },
    )
    s.pending = undefined
    s.status = 'success'
    s.channel = { id: channel.id, label: channel.label, connected: channel.connected, models: channel.models }
    console.log(`[gateway] OAuth 接入 ${channel.label} state=${s.state.slice(0, 6)}…`)
    return publicStatus(s)
  }

  async pollDeviceOnce(s) {
    const provider = resolveProviderConfig(s.channelId, this.cfg)
    if ((s.deviceStyle || provider.deviceStyle) === 'rfc8628') return this.pollDeviceRfc(s, provider)
    let res
    try {
      res = await this.fetchImpl(provider.devicePollUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'valimart-harness' },
        body: JSON.stringify({ device_auth_id: s.deviceAuthId, user_code: s.userCode }),
      })
    } catch (err) {
      throw new HttpError(502, `设备码轮询不可达：${err.message}`, 'oauth_device_unreachable')
    }
    const data = await res.json().catch(() => ({}))
    if (res.status === 403 || res.status === 404 || data.error === 'authorization_pending' || data.status === 'pending') {
      throw new HttpError(202, '等待浏览器确认', 'oauth_device_pending')
    }
    if (!res.ok || data.error) throw new HttpError(400, String(data.error_description || data.error || `设备码轮询失败 HTTP ${res.status}`), 'oauth_denied')
    const code = data.authorization_code || data.code
    if (!code) throw new HttpError(502, '设备码未返回授权码', 'oauth_no_code')
    if (data.code_verifier) s.verifier = data.code_verifier
    s.redirectUri = provider.deviceRedirectUri || s.redirectUri
    const tokens = await this.exchange(provider, code, s)
    await this.authorizeTokens(s, provider, tokens)
  }

  async pollDeviceRfc(s, provider) {
    let res
    try {
      const { headers, body } = this.tokenRequest(provider, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: s.deviceCode,
        client_id: provider.clientId,
      })
      res = await this.fetchImpl(provider.tokenUrl, { method: 'POST', headers, body })
    } catch (err) {
      throw new HttpError(502, `设备码轮询不可达：${err.message}`, 'oauth_device_unreachable')
    }
    const data = await res.json().catch(() => ({}))
    const err = data.error
    if (err === 'authorization_pending' || err === 'slow_down' || data.status === 'pending') {
      throw new HttpError(202, '等待浏览器确认', 'oauth_device_pending')
    }
    if (!res.ok || err) {
      throw new HttpError(400, String(data.error_description || err || `设备码轮询失败 HTTP ${res.status}`), 'oauth_denied')
    }
    if (!data.access_token) throw new HttpError(502, '令牌端点未返回 access_token', 'oauth_no_token')
    await this.authorizeTokens(s, provider, data)
  }

  async ensureFresh(channelId, { force = false, accountId } = {}) {
    const item = this.channels?.store?.load()?.items?.[channelId]
    if (!item) return null
    const accounts = accountsOf(item)
    const targets = accountId ? accounts.filter((a) => a.id === accountId) : accounts.length ? accounts : [item]
    let last = item
    for (const acc of targets) {
      if (!acc.refreshToken) continue
      if (!force && !needsRefresh(acc.refreshToken ? acc : item)) continue
      const key = `${channelId}:${acc.id ?? 'primary'}`
      const inflight = this.refreshing.get(key)
      if (inflight) {
        last = await inflight
        continue
      }
      const p = this.refreshNow(channelId, { ...item, ...acc }, acc.id).finally(() => this.refreshing.delete(key))
      this.refreshing.set(key, p)
      last = await p
    }
    return last
  }

  async refreshNow(channelId, item, accountId) {
    const provider = resolveProviderConfig(channelId, this.cfg)
    if (!provider?.tokenUrl) throw new HttpError(400, '该通道不能续期', 'oauth_no_refresh')
    const tokens = await this.exchangeRefresh(provider, item.refreshToken)
    const access = tokens.access_token
    if (!access) throw new HttpError(502, '续期未返回 access_token', 'oauth_no_token')
    const expiresIn = Number(tokens.expires_in)
    this.channels.updateTokens(channelId, {
      credential: access,
      refreshToken: tokens.refresh_token || item.refreshToken,
      tokenExpiresAt: Number.isFinite(expiresIn) ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
      chatgptAccountId: accountIdFromToken(tokens.id_token || access) || item.chatgptAccountId,
    }, accountId)
    console.log(`[gateway] OAuth 续期 ${channelId}${accountId ? `/${accountId}` : ''}`)
    return this.channels.store.load().items[channelId]
  }

  tokenRequest(provider, payload) {
    const headers = { accept: 'application/json', 'user-agent': 'valimart-harness' }
    if (provider.clientSecret) {
      if (provider.clientSecretInBody) payload = { ...payload, client_secret: provider.clientSecret }
      else headers.authorization = `Basic ${Buffer.from(`${provider.clientId}:${provider.clientSecret}`).toString('base64')}`
    }
    if (provider.tokenBody === 'json') {
      headers['content-type'] = 'application/json'
      return { headers, body: JSON.stringify(payload) }
    }
    headers['content-type'] = 'application/x-www-form-urlencoded'
    return { headers, body: new URLSearchParams(payload) }
  }

  async postToken(provider, payload, failCode = 'oauth_token_failed') {
    const { headers, body } = this.tokenRequest(provider, payload)
    let res
    try {
      res = await this.fetchImpl(provider.tokenUrl, { method: 'POST', headers, body })
    } catch (err) {
      throw new HttpError(502, `令牌端点不可达：${err.message}`, 'oauth_token_unreachable')
    }
    const text = await res.text()
    if (!res.ok) {
      console.warn(`[gateway] OAuth 换票失败 HTTP ${res.status}（响应已打码）`)
      throw new HttpError(502, failCode === 'oauth_refresh_failed' ? '刷新访问令牌失败' : '换取访问令牌失败', failCode)
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new HttpError(502, '令牌端点返回无法解析', 'oauth_token_bad_json')
    }
  }

  async exchange(provider, code, session) {
    const payload = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: session.redirectUri,
      client_id: provider.clientId,
      code_verifier: session.verifier,
    }
    if (provider.tokenBody === 'json' && session.state) payload.state = session.state
    return this.postToken(provider, payload)
  }

  async exchangeRefresh(provider, refreshToken) {
    return this.postToken(provider, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: provider.clientId,
    }, 'oauth_refresh_failed')
  }
}

export function registerOAuthSubscribe(router, { cfg, channels, auth, requireAdmin, oauth } = {}) {
  const svc = oauth ?? new OAuthSubscribe({ cfg, channels })

  router.post('/api/channels/:id/oauth/start', async (req, res) => {
    const { user } = auth(req)
    requireAdmin(user)
    if (!channels) throw new HttpError(500, '通道模块未启用')
    const body = await readJson(req)
    sendJson(res, 200, await svc.start(req.params.id, user, body))
  })

  router.get('/api/channels/:id/oauth/status', async (req, res) => {
    const { user } = auth(req)
    requireAdmin(user)
    const state = parseUrl(req).searchParams.get('state')
    if (!state) throw new HttpError(400, '缺少 state')
    sendJson(res, 200, await svc.status(state, user))
  })

  router.post('/api/channels/:id/oauth/complete', async (req, res) => {
    const { user } = auth(req)
    requireAdmin(user)
    const body = await readJson(req)
    sendJson(res, 200, await svc.complete(req.params.id, user, body))
  })

  router.post('/api/channels/:id/oauth/commit', async (req, res) => {
    const { user } = auth(req)
    requireAdmin(user)
    const body = await readJson(req)
    sendJson(res, 200, await svc.commit(req.params.id, user, body))
  })

  router.get(CALLBACK_PATH, async (req, res) => {
    const q = parseUrl(req).searchParams
    try {
      const session = await svc.handleCallback({
        code: q.get('code'),
        state: q.get('state'),
        error: q.get('error'),
        error_description: q.get('error_description'),
      })
      const html = renderCallbackPage(true, `已登录 ${session.channel?.label || ''}。请回到原窗口选择要接入的模型。`)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      const html = renderCallbackPage(false, err.message)
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
    }
  })
}
