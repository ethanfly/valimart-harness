/**
 * 本机 Anthropic 兼容入口。只听 127.0.0.1。
 * Claude Code 把 ANTHROPIC_BASE_URL 指到这里，Authorization 用占位符；
 * 真正的网关令牌从本机登录态读取，不进 Claude Code 的环境变量。
 */
import http from 'node:http'
import { createOpenAIToAnthropicStream, toAnthropicMessage, toOpenAIBody } from './anthropic-bridge.mjs'
import { GatewayError, gatewayAuth, request } from './gateway.mjs'
import { loadState } from './state.mjs'

const PORT_FILE_ENV = 'VALIMART_DESK_PORT'

export function listenPort() {
  const fromEnv = Number(process.env[PORT_FILE_ENV] || process.env.VALIMART_BRIDGE_PORT || 0)
  return Number.isInteger(fromEnv) && fromEnv >= 0 ? fromEnv : 0
}

function sendJson(res, status, body) {
  const raw = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(raw) })
  res.end(raw)
}

function anthropicError(res, status, message, type = 'invalid_request_error') {
  sendJson(res, status, { type: 'error', error: { type, message } })
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 20 * 1024 * 1024) {
      const err = new Error('请求体超过 20MB')
      err.status = 413
      throw err
    }
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const err = new Error('请求体不是 JSON')
    err.status = 400
    throw err
  }
}

export async function handleMessages(req, res) {
  const state = loadState()
  if (!state.gatewayToken) {
    anthropicError(res, 401, '未登录公司网关。在 Claude Code 里运行 /valimart-desk:desk-login', 'authentication_error')
    return
  }
  let body
  try {
    body = await readJson(req)
  } catch (err) {
    anthropicError(res, err.status || 400, err.message)
    return
  }
  const openai = toOpenAIBody(body, { defaultModel: state.defaultModel })
  if (!openai.model) {
    anthropicError(res, 400, '公司目录里没有默认模型，请先在管理页设置或重新登录')
    return
  }
  const { token, baseUrl } = gatewayAuth()
  if (openai.stream) {
    await pipeStream(res, openai, { token, baseUrl })
    return
  }
  try {
    const json = await request('POST', '/v1/chat/completions', { token, baseUrl, body: openai, timeoutMs: 120_000 })
    sendJson(res, 200, toAnthropicMessage(json))
  } catch (err) {
    const status = err instanceof GatewayError && err.status ? err.status : 502
    anthropicError(res, status, err.message || '公司网关请求失败', status === 401 ? 'authentication_error' : 'api_error')
  }
}

async function pipeStream(res, openai, auth) {
  const root = auth.baseUrl.replace(/\/+$/, '')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 120_000)
  let upstream
  try {
    upstream = await fetch(`${root}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(openai),
      signal: ac.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    anthropicError(res, 502, `无法连接公司网关：${err.message}`, 'api_error')
    return
  }
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '')
    clearTimeout(timer)
    let message = `网关返回 ${upstream.status}`
    try { message = JSON.parse(text)?.error?.message || message } catch { /* 保持摘要 */ }
    anthropicError(res, upstream.status || 502, message, upstream.status === 401 ? 'authentication_error' : 'api_error')
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
  const bridge = createOpenAIToAnthropicStream({ model: openai.model })
  res.write(bridge.start())
  try {
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const text = bridge.push(decoder.decode(value, { stream: true }))
      if (text) res.write(text)
    }
    const tail = bridge.end()
    if (tail.text) res.write(tail.text)
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } })}\n\n`)
  } finally {
    clearTimeout(timer)
    res.end()
  }
}

export function createBridgeServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/health') {
      const state = loadState()
      sendJson(res, 200, { ok: true, loggedIn: Boolean(state.gatewayToken && state.user), user: state.user?.username ?? null })
      return
    }
    if (req.method === 'POST' && (url.pathname === '/v1/messages' || url.pathname === '/messages')) {
      await handleMessages(req, res)
      return
    }
    anthropicError(res, 404, `没有这个路径：${url.pathname}`, 'not_found_error')
  })
}

export function startBridge({ port = listenPort() } = {}) {
  const server = createBridgeServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ server, port: addr.port, baseUrl: `http://127.0.0.1:${addr.port}` })
    })
  })
}
