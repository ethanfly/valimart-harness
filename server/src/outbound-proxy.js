/**
 * 服务以 SYSTEM 运行，不继承登录用户的代理，直连 api.x.ai 会 fetch failed。
 * 优先级：HTTPS_PROXY / HTTP_PROXY → 本机正在监听的常见本地代理端口。
 * 命中后只把 https 请求经 HTTP CONNECT 转出去，127.0.0.1 仍直连。
 * ponytail: 只认这几个端口；代理不在列表里就设 HTTPS_PROXY。
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { Readable } from 'node:stream'

const LOCAL_PROXY_PORTS = [7897, 7890, 10809, 1080, 20171]

export function proxyFromEnv() {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || ''
}

function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (ok) => { socket.removeAllListeners(); socket.destroy(); resolve(ok) }
    socket.setTimeout(300)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** 第一个有进程在听的本地代理端口，没有就空串。 */
export async function detectLocalProxy() {
  for (const port of LOCAL_PROXY_PORTS) if (await listening(port)) return `http://127.0.0.1:${port}`
  return ''
}

export function proxyUrl() {
  const raw = proxyFromEnv()
  if (!raw) return ''
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
}

function localHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

function headerObject(headers) {
  const out = {}
  if (!headers) return out
  if (typeof headers.forEach === 'function') headers.forEach((v, k) => { out[k] = v })
  else Object.assign(out, headers)
  return out
}

function connectFetch(proxy, target, init) {
  let agent
  try { agent = new URL(proxy) } catch { return Promise.reject(new Error('代理地址无效')) }
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: agent.hostname,
      port: agent.port || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
    })
    const fail = (err) => reject(Object.assign(err instanceof Error ? err : new Error(String(err)), { message: err?.message || 'fetch failed' }))
    if (init.signal) {
      if (init.signal.aborted) { fail(new Error('aborted')); return }
      init.signal.addEventListener('abort', () => req.destroy(), { once: true })
    }
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); fail(new Error(`proxy CONNECT ${res.statusCode}`)); return }
      const creq = https.request({
        host: target.hostname,
        servername: target.hostname,
        path: `${target.pathname}${target.search}`,
        method: init.method || 'GET',
        headers: headerObject(init.headers),
        socket,
        agent: false,
      }, (cres) => {
        resolve(new Response(Readable.toWeb(cres), { status: cres.statusCode, headers: cres.headers }))
      })
      creq.on('error', fail)
      if (init.body != null) creq.write(init.body)
      creq.end()
    })
    req.once('error', fail)
    req.end()
  })
}

/** 有代理就把 https 的 fetch 转出去。返回用了哪个地址。 */
export async function applyOutboundProxy() {
  const url = proxyUrl() || await detectLocalProxy()
  if (!url) return ''
  const orig = globalThis.fetch
  globalThis.fetch = (input, init = {}) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let target
    try { target = new URL(href) } catch { return orig(input, init) }
    if (target.protocol !== 'https:' || localHost(target.hostname)) return orig(input, init)
    return connectFetch(url, target, init)
  }
  return url
}
