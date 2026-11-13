/**
 * valimart code 的本机目录与登录态。
 *
 * 根目录 ~/.valimart（VALIMART_HOME 可改）同时是 Qwen Code 的 QWEN_HOME：会话、设置、技能、扩展都在这里，
 * 和本机原版 qwen（~/.qwen）互不影响。
 * 登录态 valimart-desk.json 只存登录会话令牌 + 网关令牌；上游模型密钥永远不会出现在这里。
 * 与 pi（~/.pi/agent）、Claude 插件（~/.claude）的登录态分开，几个客户端不会互相登出。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function valimartHome() {
  const configured = process.env.VALIMART_HOME
  if (!configured) return path.join(os.homedir(), '.valimart')
  if (configured === '~') return os.homedir()
  if (configured.startsWith('~/') || configured.startsWith('~\\')) return path.join(os.homedir(), configured.slice(2))
  return path.resolve(configured)
}

export function statePath() {
  return process.env.VALIMART_DESK_STATE || path.join(valimartHome(), 'valimart-desk.json')
}

export function defaultDriveDir() {
  return path.join(valimartHome(), 'valimart-drive')
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
    driveDir: defaultDriveDir(),
    lastSyncAt: null,
    currentTaskId: null,
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
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
  return next
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
    driveDir: state.driveDir || defaultDriveDir(),
    lastSyncAt: state.lastSyncAt ?? null,
    currentTaskId: state.currentTaskId || null,
  }
}
