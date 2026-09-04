/**
 * 极简路由 + 请求/响应工具（无第三方依赖）。
 */
import { URL } from 'node:url'

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
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'request body too large')
    chunks.push(chunk)
  }
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

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function sendError(res, err) {
  const status = err instanceof HttpError ? err.status : 500
  const payload = { error: { message: err.message ?? String(err), code: err.code ?? 'internal' } }
  if (status >= 500) console.error('[gateway] 500', err)
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
