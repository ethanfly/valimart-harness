/**
 * 公司网关 HTTP 客户端（pi CLI → 网关）。
 * /v1/* 用网关令牌；/api/* 用登录会话令牌。
 */
import os from 'node:os'
import { isLoggedIn, loadState, saveState } from './state.mjs'

export class GatewayError extends Error {
  constructor(status, message, code, body) {
    super(message)
    this.status = status
    this.code = code
    this.body = body
  }
}

export function normalizeGatewayUrl(url) {
  const s = String(url ?? '').trim().replace(/\/+$/, '')
  if (!s) return ''
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.origin
  } catch {
    return ''
  }
}

export async function request(method, apiPath, { body, token, timeoutMs = 30_000, baseUrl, raw, headers = {} } = {}) {
  const state = loadState()
  const root = (baseUrl ?? state.gatewayUrl ?? '').replace(/\/+$/, '')
  if (!root) throw new GatewayError(0, '未配置公司网关地址', 'no_gateway')
  const url = `${root}${apiPath}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  let res
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      signal: ac.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    throw new GatewayError(0, `无法连接公司网关 ${root}：${err.message}`, 'unreachable')
  }
  try {
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) {
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new GatewayError(res.status, json?.error?.message ?? `网关返回 ${res.status}`, json?.error?.code ?? 'gateway_error', json)
      return json
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (!res.ok) throw new GatewayError(res.status, buf.toString('utf8').slice(0, 300) || `网关返回 ${res.status}`, 'gateway_error')
    return buf
  } finally {
    clearTimeout(timer)
  }
}

/** 给 DriveMirror 用的会话令牌客户端（与 desk-host GatewayClient 同一套 /api）。 */
export function makeApiClient() {
  const auth = () => sessionAuth()
  return {
    get: (p, o) => request('GET', p, { ...auth(), ...o }),
    post: (p, body, o) => request('POST', p, { ...auth(), ...o, body }),
    patch: (p, body, o) => request('PATCH', p, { ...auth(), ...o, body }),
    put: (p, body, o) => request('PUT', p, { ...auth(), ...o, body, raw: o?.raw ?? Buffer.isBuffer(body), timeoutMs: o?.timeoutMs ?? 120_000 }),
  }
}

export function sessionAuth() {
  const state = loadState()
  if (!state.sessionToken) throw new GatewayError(401, '未登录公司网关，请先 /desk-login 或 /login valimart', 'not_logged_in')
  return { token: state.sessionToken, baseUrl: state.gatewayUrl }
}

export function gatewayAuth() {
  const state = loadState()
  if (!state.gatewayToken) throw new GatewayError(401, '没有网关令牌，请重新 /desk-login', 'no_gateway_token')
  return { token: state.gatewayToken, baseUrl: state.gatewayUrl }
}

export async function login({ gatewayUrl, username, password, device }) {
  const url = normalizeGatewayUrl(gatewayUrl)
  if (!url) throw new GatewayError(0, '网关地址无效', 'bad_url')
  const name = String(username ?? '').trim()
  if (!name) throw new GatewayError(0, '请填写账号', 'bad_username')
  if (!password) throw new GatewayError(0, '请填写密码', 'bad_password')
  const payload = await request('POST', '/api/auth/login', {
    baseUrl: url,
    body: {
      username: name,
      password: String(password),
      device: device || `pi-agent (${os.hostname()})`,
    },
  })
  let gatewayToken = payload.gatewayToken ?? null
  if (!gatewayToken && payload.sessionToken) {
    const issued = await request('POST', '/api/auth/gateway-token', {
      baseUrl: url,
      token: payload.sessionToken,
      body: {},
    })
    gatewayToken = issued.gatewayToken ?? null
  }
  if (!gatewayToken) throw new GatewayError(0, '登录成功但未签发网关令牌', 'no_gateway_token')
  const company = payload.company ?? null
  const models = Array.isArray(company?.models) ? company.models : []
  return saveState({
    gatewayUrl: url,
    sessionToken: payload.sessionToken,
    gatewayToken,
    user: payload.user ?? null,
    company,
    quota: payload.quota ?? null,
    models,
    defaultModel: company?.defaultModel ?? models[0]?.id ?? null,
    loggedInAt: new Date().toISOString(),
    needsRelogin: false,
    lastError: null,
  })
}

export async function logout() {
  const state = loadState()
  if (state.sessionToken && state.gatewayUrl) {
    try {
      await request('POST', '/api/auth/logout', { token: state.sessionToken, baseUrl: state.gatewayUrl, body: {} })
    } catch {
      /* 令牌已失效也算登出 */
    }
  }
  return saveState({
    sessionToken: null,
    gatewayToken: null,
    user: null,
    quota: null,
    models: [],
    defaultModel: null,
    loggedInAt: null,
    needsRelogin: false,
    lastError: null,
  })
}

export async function fetchMe() {
  const { token, baseUrl } = sessionAuth()
  const me = await request('GET', '/api/auth/me', { token, baseUrl })
  const company = me.company ?? loadState().company
  const models = Array.isArray(company?.models) ? company.models : loadState().models
  return saveState({
    user: me.user ?? loadState().user,
    company,
    quota: me.quota ?? null,
    models,
    defaultModel: company?.defaultModel ?? loadState().defaultModel,
    needsRelogin: false,
    lastError: null,
  })
}

export async function fetchV1Models() {
  const { token, baseUrl } = gatewayAuth()
  return request('GET', '/v1/models', { token, baseUrl })
}

export async function searchKnowledge(q, { limit = 20, kinds } = {}) {
  const { token, baseUrl } = sessionAuth()
  const params = new URLSearchParams({ q: String(q ?? ''), limit: String(limit) })
  if (kinds) params.set('kinds', String(kinds))
  return request('GET', `/api/knowledge/search?${params}`, { token, baseUrl })
}

export async function listTasks() {
  const { token, baseUrl } = sessionAuth()
  return request('GET', '/api/tasks', { token, baseUrl })
}

export async function listPeople() {
  const { token, baseUrl } = sessionAuth()
  return request('GET', '/api/people', { token, baseUrl })
}

export async function createTask(body) {
  const { token, baseUrl } = sessionAuth()
  return request('POST', '/api/tasks', { token, baseUrl, body })
}

export async function getTask(id) {
  const { token, baseUrl } = sessionAuth()
  return request('GET', `/api/tasks/${encodeURIComponent(id)}`, { token, baseUrl })
}

export async function patchTask(id, body) {
  const { token, baseUrl } = sessionAuth()
  return request('PATCH', `/api/tasks/${encodeURIComponent(id)}`, { token, baseUrl, body })
}

export async function addTaskLog(id, body) {
  const { token, baseUrl } = sessionAuth()
  return request('POST', `/api/tasks/${encodeURIComponent(id)}/log`, { token, baseUrl, body })
}

export async function addDeliverables(id, files) {
  const { token, baseUrl } = sessionAuth()
  return request('POST', `/api/tasks/${encodeURIComponent(id)}/deliverables`, { token, baseUrl, body: { files } })
}

export async function submitTask(id, { reviewerId }) {
  const { token, baseUrl } = sessionAuth()
  return request('POST', `/api/tasks/${encodeURIComponent(id)}/submit`, { token, baseUrl, body: { reviewerId } })
}

export async function reviewTask(id, { decision, comment }) {
  const { token, baseUrl } = sessionAuth()
  return request('POST', `/api/tasks/${encodeURIComponent(id)}/review`, { token, baseUrl, body: { decision, comment } })
}

export async function finalizeTask(id, { decision, comment }) {
  const { token, baseUrl } = sessionAuth()
  return request('POST', `/api/tasks/${encodeURIComponent(id)}/final`, { token, baseUrl, body: { decision, comment } })
}

export { isLoggedIn, loadState }
