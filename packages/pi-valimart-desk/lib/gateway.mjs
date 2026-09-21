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

async function request(method, apiPath, { body, token, timeoutMs = 30_000, baseUrl } = {}) {
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
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    throw new GatewayError(0, `无法连接公司网关 ${root}：${err.message}`, 'unreachable')
  }
  try {
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!res.ok) {
      const msg = json?.error?.message ?? (text || `网关返回 ${res.status}`).slice(0, 300)
      throw new GatewayError(res.status, msg, json?.error?.code ?? 'gateway_error', json)
    }
    return json
  } finally {
    clearTimeout(timer)
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

export async function getTask(id) {
  const { token, baseUrl } = sessionAuth()
  return request('GET', `/api/tasks/${encodeURIComponent(id)}`, { token, baseUrl })
}

export { isLoggedIn, loadState }
