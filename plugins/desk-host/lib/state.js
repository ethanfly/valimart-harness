/**
 * 本机登录态与索引（$DSH_HOME/profiles/desk/desk-state.json）。
 * 只保存本人的登录会话令牌与网关令牌；上游模型密钥永远不会出现在这里。
 */
import fs from 'node:fs'
import path from 'node:path'

export class DeskState {
  constructor(stateDir) {
    this.dir = stateDir
    this.file = path.join(stateDir, 'desk-state.json')
    this.data = this.#load()
  }

  #load() {
    try {
      return { ...defaults(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }
    } catch {
      return defaults()
    }
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    fs.renameSync(tmp, this.file)
  }

  get loggedIn() {
    return !!(this.data.sessionToken && this.data.user)
  }

  setLogin({ gatewayUrl, sessionToken, gatewayToken, user, company, quota }) {
    Object.assign(this.data, { gatewayUrl, sessionToken, gatewayToken, user, company, quota, loggedInAt: new Date().toISOString(), needsRelogin: false, lastError: null })
    this.save()
  }

  clearLogin(reason) {
    Object.assign(this.data, { sessionToken: null, gatewayToken: null, user: null, quota: null, needsRelogin: false, lastError: reason ?? null })
    this.save()
  }

  bindTaskSession(taskId, sessionId) {
    this.data.taskSessions[sessionId] = taskId
    this.save()
  }

  unbindTaskSession(taskId, sessionId) {
    if (this.data.taskSessions[sessionId] !== taskId) return false
    delete this.data.taskSessions[sessionId]
    this.save()
    return true
  }

  taskOfSession(sessionId) {
    return sessionId ? this.data.taskSessions[sessionId] : undefined
  }

  sessionsOfTask(taskId) {
    return Object.entries(this.data.taskSessions)
      .filter(([, t]) => t === taskId)
      .map(([s]) => s)
  }

  /** 公开给客户端的视图（不含令牌）。 */
  publicView() {
    const d = this.data
    const tok = d.gatewayToken
    return {
      loggedIn: this.loggedIn,
      gatewayUrl: d.gatewayUrl,
      user: d.user,
      company: d.company,
      quota: d.quota,
      loggedInAt: d.loggedInAt,
      loginAt: d.loggedInAt,
      needsRelogin: !!d.needsRelogin,
      lastError: d.lastError,
      notice: d.needsRelogin ? d.lastError : d.lastError && !this.loggedIn ? d.lastError : null,
      online: this.loggedIn && !d.needsRelogin && !!d.lastHeartbeatOk,
      lastHeartbeatAt: d.lastHeartbeatAt ?? null,
      tokenHint: tok ? `${tok.slice(0, 6)}…${tok.slice(-4)}` : null,
      driveDir: d.driveDir,
      lastSyncAt: d.lastSyncAt ?? null,
      modelCount: d.company?.models?.length ?? 0,
      defaultModel: d.company?.defaultModel ?? null,
      taskSessions: d.taskSessions,
      device: d.device,
    }
  }
}

function defaults() {
  return {
    gatewayUrl: null,
    sessionToken: null,
    gatewayToken: null,
    user: null,
    company: null,
    quota: null,
    loggedInAt: null,
    needsRelogin: false,
    lastError: null,
    driveDir: null,
    device: null,
    taskSessions: {},
    /** 搜索密钥（AnySearch）是否已由公司配置下发到本机凭据；null = 还没同步过。 */
    searchKeyConfigured: null,
  }
}
