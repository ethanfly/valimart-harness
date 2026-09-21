/**
 * pi 侧登录态（~/.pi/agent/valimart-desk.json）。
 * 只存登录会话令牌 + 网关令牌；上游模型密钥永远不会出现在这里。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function statePath() {
  const home = process.env.PI_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
  return path.join(home, 'valimart-desk.json')
}

export function defaults() {
  return {
    gatewayUrl: process.env.DESK_GATEWAY_URL || 'http://127.0.0.1:8790',
    sessionToken: null,
    gatewayToken: null,
    user: null,
    company: null,
    quota: null,
    models: [],
    defaultModel: null,
    loggedInAt: null,
    lastError: null,
    needsRelogin: false,
  }
}

export function loadState() {
  try {
    return { ...defaults(), ...JSON.parse(fs.readFileSync(statePath(), 'utf8')) }
  } catch {
    return defaults()
  }
}

export function saveState(patch) {
  const next = { ...loadState(), ...patch }
  const file = statePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, file)
  return next
}

export function clearLogin(reason) {
  return saveState({
    sessionToken: null,
    gatewayToken: null,
    user: null,
    quota: null,
    models: [],
    defaultModel: null,
    loggedInAt: null,
    needsRelogin: Boolean(reason),
    lastError: reason ?? null,
  })
}

export function isLoggedIn(state = loadState()) {
  return Boolean(state.sessionToken && state.gatewayToken && state.user)
}

export function publicView(state = loadState()) {
  return {
    loggedIn: isLoggedIn(state),
    gatewayUrl: state.gatewayUrl,
    user: state.user,
    company: state.company && typeof state.company === 'object' ? { name: state.company.name, plan: state.company.plan } : state.company,
    quota: state.quota,
    defaultModel: state.defaultModel,
    models: Array.isArray(state.models) ? state.models.map((m) => m.id ?? m) : [],
    loggedInAt: state.loggedInAt,
    needsRelogin: !!state.needsRelogin,
    lastError: state.lastError,
  }
}
