/**
 * 网关 HTTP 客户端（本机 Host → 公司网关）。所有 /api 调用都带登录会话令牌。
 */
export class GatewayError extends Error {
  constructor(status, message, code, body) {
    super(message)
    this.status = status
    this.code = code
    this.body = body
  }
}

export class GatewayClient {
  constructor(state) {
    this.state = state
  }

  get baseUrl() {
    return (this.state.data.gatewayUrl ?? '').replace(/\/+$/, '')
  }

  async request(method, apiPath, { body, raw, token, timeoutMs = 30_000, headers = {} } = {}) {
    const url = `${this.baseUrl}${apiPath}`
    const auth = token ?? this.state.data.sessionToken
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    let res
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
          ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
        signal: ac.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      throw new GatewayError(0, `无法连接公司网关 ${this.baseUrl}：${err.message}`, 'unreachable')
    }
    clearTimeout(timer)
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) {
      const json = await res.json()
      if (!res.ok) throw new GatewayError(res.status, json?.error?.message ?? `网关返回 ${res.status}`, json?.error?.code ?? 'gateway_error', json)
      return json
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (!res.ok) throw new GatewayError(res.status, buf.toString('utf8').slice(0, 300) || `网关返回 ${res.status}`, 'gateway_error')
    return buf
  }

  get(p, o) {
    return this.request('GET', p, o)
  }
  post(p, body, o) {
    return this.request('POST', p, { ...o, body })
  }
  patch(p, body, o) {
    return this.request('PATCH', p, { ...o, body })
  }
  put(p, body, o) {
    return this.request('PUT', p, { ...o, body })
  }
  delete(p, o) {
    return this.request('DELETE', p, o)
  }
}
