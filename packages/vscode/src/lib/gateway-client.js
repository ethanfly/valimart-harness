/**
 * company-desk HTTP client.
 * /api/* uses sessionToken; /v1/* uses gatewayToken. Upstream keys never leave the server.
 */
/** Agent turns may run minutes of tool calls + reasoning; /api/* stays short. */
export const DEFAULT_CHAT_TIMEOUT_MS = 300_000
export const DEFAULT_API_TIMEOUT_MS = 30_000

import { consumeOpenAiSse, jsonToCompletion } from './sse.js'

export class GatewayError extends Error {
  constructor(status, message, code, body) {
    super(message)
    this.status = status
    this.code = code
    this.body = body
  }
}

export function isAbortError(err) {
  return err?.name === 'AbortError' || err?.code === 'aborted' || err?.code === 'cancelled'
}

export class GatewayClient {
  constructor(store, { fetchImpl, log } = {}) {
    this.store = store
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.log = log ?? null
  }

  get baseUrl() {
    return String(this.store.data.gatewayUrl ?? '').replace(/\/+$/, '')
  }

  async request(method, apiPath, {
    body,
    token,
    timeoutMs = DEFAULT_API_TIMEOUT_MS,
    headers = {},
    baseUrl,
    raw = false,
    responseText = false,
    signal,
    stream = false,
    onDelta,
  } = {}) {
    const root = (baseUrl ?? this.baseUrl).replace(/\/+$/, '')
    if (!root) throw new GatewayError(0, '未配置网关地址', 'no_gateway')
    const url = `${root}${apiPath}`
    const ac = new AbortController()
    const onOuterAbort = () => ac.abort()
    if (signal) {
      if (signal.aborted) ac.abort()
      else signal.addEventListener('abort', onOuterAbort, { once: true })
    }
    const timer = setTimeout(() => ac.abort('timeout'), timeoutMs)
    const started = Date.now()
    this.log?.info(`${method} ${apiPath}`, { stream: !!stream, timeoutMs })
    let res
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': raw ? 'application/octet-stream' : 'application/json' } : {}),
          ...(stream ? { accept: 'text/event-stream' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
        signal: ac.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onOuterAbort)
      if (isAbortError(err)) {
        if (signal?.aborted) throw new GatewayError(0, '已停止生成', 'cancelled')
        throw new GatewayError(0, `请求超时：${url}`, 'timeout')
      }
      throw new GatewayError(0, `无法连接公司网关 ${root}：${err.message}`, 'unreachable')
    }
    try {
      if (!res.ok) {
        const text = await res.text()
        let json
        try {
          json = text ? JSON.parse(text) : {}
        } catch {
          json = { text }
        }
        throw new GatewayError(
          res.status,
          json?.error?.message ?? json?.text?.slice?.(0, 300) ?? `网关返回 ${res.status}`,
          json?.error?.code ?? 'gateway_error',
          json,
        )
      }
      if (stream) {
        const ctype = String(res.headers?.get?.('content-type') ?? '')
        if (ctype.includes('text/event-stream')) {
          const json = await consumeOpenAiSse(res, { onDelta })
          this.log?.info(`${method} ${apiPath} sse ${Date.now() - started}ms`)
          return json
        }
        const text = await res.text()
        let json
        try {
          json = text ? JSON.parse(text) : {}
        } catch {
          json = { text }
        }
        this.log?.info(`${method} ${apiPath} json-fallback ${Date.now() - started}ms`)
        return jsonToCompletion(json, { onDelta })
      }
      const text = await res.text()
      if (responseText) return text
      let json
      try {
        json = text ? JSON.parse(text) : {}
      } catch {
        json = { text }
      }
      this.log?.info(`${method} ${apiPath} ${Date.now() - started}ms`)
      return json
    } catch (err) {
      if (isAbortError(err) || err?.code === 'cancelled') {
        if (signal?.aborted) throw new GatewayError(0, '已停止生成', 'cancelled')
        throw new GatewayError(0, `等待响应超时（${Math.round(timeoutMs / 1000)} 秒）：${url}`, 'timeout')
      }
      throw err
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onOuterAbort)
    }
  }

  async login({ gatewayUrl, username, password, device }) {
    const url = String(gatewayUrl ?? '').replace(/\/+$/, '')
    const json = await this.request('POST', '/api/auth/login', {
      baseUrl: url,
      token: null,
      body: { username, password, device },
    })
    this.store.setLogin({
      gatewayUrl: url,
      sessionToken: json.sessionToken,
      gatewayToken: json.gatewayToken,
      user: json.user,
      company: json.company,
      quota: json.quota,
      device,
    })
    return json
  }

  me() {
    return this.request('GET', '/api/auth/me', { token: this.store.data.sessionToken })
  }

  async logout() {
    try {
      if (this.store.data.sessionToken && this.baseUrl) {
        await this.request('POST', '/api/auth/logout', { token: this.store.data.sessionToken, body: {} })
      }
    } finally {
      this.store.clearLogin()
    }
    return { ok: true }
  }

  listModels() {
    return this.request('GET', '/v1/models', { token: this.store.data.gatewayToken })
  }

  /** Agent turns carry tool results and reasoning; give them a much longer budget than /api/*. */
  chatCompletions(body, { timeoutMs = DEFAULT_CHAT_TIMEOUT_MS, signal, onDelta, stream } = {}) {
    const wantStream = stream === true || typeof onDelta === 'function'
    return this.request('POST', '/v1/chat/completions', {
      token: this.store.data.gatewayToken,
      body: wantStream ? { ...body, stream: true } : body,
      timeoutMs,
      signal,
      stream: wantStream,
      onDelta,
    })
  }
}
