/**
 * 极简路由 + 请求/响应工具（无第三方依赖）。
 */
import { URL } from 'node:url'
import zlib from 'node:zlib'

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code ?? 'error'
  }
}

export function createRouter() {
  const routes = []
  const add = (method, pattern, handler) => {
    const keys = []
    const regex = new RegExp(
      '^' +
        pattern.replace(/\/:([a-zA-Z_]+)/g, (_m, key) => {
          keys.push(key)
          return '/([^/]+)'
        }) +
        '/?$',
    )
    routes.push({ method, regex, keys, handler })
  }
  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    patch: (p, h) => add('PATCH', p, h),
    delete: (p, h) => add('DELETE', p, h),
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue
        const m = route.regex.exec(pathname)
        if (!m) continue
        const params = {}
        route.keys.forEach((k, i) => {
          params[k] = decodeURIComponent(m[i + 1])
        })
        return { handler: route.handler, params }
      }
      return undefined
    },
  }
}

export function parseUrl(req) {
  return new URL(req.url ?? '/', 'http://localhost')
}

export async function readBody(req, limit = 64 * 1024 * 1024) {
  const chunks = []
  let size = 0
  let overflow = false
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) overflow = true
    // 超限后继续把请求体读完（丢弃），而不是半路抛错：keep-alive 连接上残留未读字节
    // 会污染下一个请求的帧解析（400 / 串包），也会让客户端等不到 413
    if (!overflow) chunks.push(chunk)
  }
  if (overflow) throw new HttpError(413, 'request body too large')
  return Buffer.concat(chunks)
}

export async function readJson(req) {
  const buf = await readBody(req)
  if (buf.length === 0) return {}
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid JSON body')
  }
}

// 小于这个尺寸的响应不压缩：省下的字节抵不过 gzip 头和 CPU
const GZIP_MIN_BYTES = 1024

export function acceptsGzip(req) {
  return /\bgzip\b/i.test(String(req?.headers?.['accept-encoding'] ?? ''))
}

/**
 * 发送完整响应体；客户端声明 Accept-Encoding: gzip 且体积够大时压缩。
 * 跨网段的安全设备会卡住 100KB 级的大响应，压缩后通常只剩 1/4~1/5。
 * `gzipped` 可传预先压好的同一份内容（静态页启动时压一次）。
 */
export function sendBody(res, status, headers, body, gzipped) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
  const out = { ...headers, vary: 'accept-encoding' }
  if (buf.length >= GZIP_MIN_BYTES && acceptsGzip(res.req)) {
    const zipped = gzipped ?? zlib.gzipSync(buf)
    res.writeHead(status, { ...out, 'content-encoding': 'gzip', 'content-length': zipped.length })
    res.end(zipped)
    return
  }
  res.writeHead(status, { ...out, 'content-length': buf.length })
  res.end(buf)
}

export function sendJson(res, status, payload) {
  sendBody(res, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify(payload))
}

export function sendError(res, err) {
  const status = err instanceof HttpError ? err.status : 500
  const payload = { error: { message: err.message ?? String(err), code: err.code ?? 'internal' } }
  if (status === 500) console.error('[gateway] 500', err)
  sendJson(res, status, payload)
}

export function bearer(req) {
  const h = req.headers.authorization
  if (!h) return undefined
  const m = /^Bearer\s+(.+)$/i.exec(h)
  return m ? m[1].trim() : undefined
}

export function nowIso() {
  return new Date().toISOString()
}
