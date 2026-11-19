/**
 * Codex 侧登录态（~/.codex/valimart-desk.json）。
 * 与 Claude / pi 的登录态分开，避免一个 CLI 登出影响另一个。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

export function statePath() {
  return process.env.VALIMART_DESK_STATE || path.join(codexHome(), 'valimart-desk.json')
}

export function defaultDriveDir() {
  return process.env.VALIMART_DRIVE_DIR || path.join(codexHome(), 'valimart-drive')
}

export function defaults() {
  return {
    gatewayUrl: '',
    sessionToken: null,
    gatewayToken: null,
    user: null,
    company: null,
    quota: null,
    models: [],
    defaultModel: null,
    driveDir: defaultDriveDir(),
    loggedInAt: null,
    lastSyncAt: null,
    currentTaskId: null,
    projectDir: null,
    needsRelogin: false,
    lastError: null,
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
  fs.mkdirSync(path.dirname(statePath()), { recursive: true })
  const next = { ...loadState(), ...patch }
  fs.writeFileSync(statePath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  return next
}

export function publicView(state = loadState()) {
  const user = state.user
  return {
    loggedIn: isLoggedIn(state),
    needsRelogin: !!state.needsRelogin,
    lastError: state.lastError,
    gatewayUrl: state.gatewayUrl || null,
    user: user && { id: user.id, username: user.username, displayName: user.displayName, role: user.role, roleLabel: user.roleLabel, department: user.department },
    company: state.company && { id: state.company.id, name: state.company.name, plan: state.company.plan, defaultModel: state.company.defaultModel },
    quota: state.quota,
    models: state.models,
    defaultModel: state.defaultModel,
    driveDir: state.driveDir || defaultDriveDir(),
    lastSyncAt: state.lastSyncAt ?? null,
    currentTaskId: state.currentTaskId || null,
  }
}

export function isLoggedIn(state = loadState()) {
  return Boolean(state.sessionToken && state.gatewayToken && state.user)
}
