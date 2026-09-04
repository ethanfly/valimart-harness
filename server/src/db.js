/**
 * 数据集合：users / loginSessions / gatewayTokens / tasks / settings + usage 账本（JSONL）。
 */
import path from 'node:path'
import crypto from 'node:crypto'
import { createPersistence, ensureDir } from './store.js'

export const ROLES = ['admin', 'director', 'employee']
export const ROLE_LABELS = { admin: '管理员', director: '总监', employee: '员工' }

export function newId(prefix, bytes = 5) {
  return `${prefix}${crypto.randomBytes(bytes).toString('hex')}`
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 32).toString('hex')
  return { salt, hash }
}

export function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(password, salt, 32)
  const expected = Buffer.from(hash, 'hex')
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)
}

export class Db {
  constructor(dataDir) {
    this.dataDir = ensureDir(dataDir)
    this.persist = createPersistence(dataDir)
    this.users = this.persist.file('users.json', () => ({ items: [] }))
    this.loginSessions = this.persist.file('login-sessions.json', () => ({ items: [] }))
    this.gatewayTokens = this.persist.file('gateway-tokens.json', () => ({ items: [] }))
    this.tasks = this.persist.file('tasks.json', () => ({ items: [] }))
    this.settings = this.persist.file('settings.json', () => ({ company: {}, users: {} }))
    this.usage = this.persist.log('usage.jsonl')
    this.driveRoot = ensureDir(path.join(dataDir, 'drive'))
  }

  // ---- users ----
  listUsers() {
    return this.users.load().items
  }
  getUser(id) {
    return this.listUsers().find((u) => u.id === id)
  }
  getUserByName(username) {
    const n = String(username ?? '').trim().toLowerCase()
    return this.listUsers().find((u) => u.username.toLowerCase() === n)
  }
  createUser({ username, password, displayName, role, department, seed = false }) {
    if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(username)) throw new Error('账号只能包含字母、数字、._-，长度 2-32')
    if (!ROLES.includes(role)) throw new Error(`未知角色 ${role}`)
    if (this.getUserByName(username)) throw new Error(`账号 ${username} 已存在`)
    if (typeof password !== 'string' || password.length < 6) throw new Error('密码至少 6 位')
    const { salt, hash } = hashPassword(password)
    const user = {
      id: newId('u-', 4),
      username,
      displayName: displayName || username,
      role,
      department: department || '未分组',
      disabled: false,
      seed,
      passwordSalt: salt,
      passwordHash: hash,
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
      lastSeenAt: null,
    }
    this.users.update((d) => d.items.push(user))
    return user
  }
  updateUser(id, patch) {
    return this.users.update((d) => {
      const u = d.items.find((x) => x.id === id)
      if (!u) throw new Error('用户不存在')
      Object.assign(u, patch)
      return u
    })
  }

  // ---- login sessions（客户端本机 host 持有）----
  createLoginSession(userId, ttlDays, device) {
    const token = crypto.randomBytes(32).toString('base64url')
    const now = Date.now()
    const item = {
      id: newId('ls-'),
      userId,
      tokenHash: sha256(token),
      device: device ?? 'unknown',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlDays * 86400_000).toISOString(),
      revokedAt: null,
    }
    this.loginSessions.update((d) => d.items.push(item))
    return { token, item }
  }
  findLoginSession(token) {
    if (!token) return undefined
    const h = sha256(token)
    const item = this.loginSessions.load().items.find((s) => s.tokenHash === h)
    if (!item || item.revokedAt) return undefined
    if (Date.parse(item.expiresAt) < Date.now()) return undefined
    return item
  }
  revokeLoginSessions(userId, exceptId) {
    this.loginSessions.update((d) => {
      for (const s of d.items) if (s.userId === userId && s.id !== exceptId && !s.revokedAt) s.revokedAt = new Date().toISOString()
    })
  }
  revokeLoginSession(id) {
    this.loginSessions.update((d) => {
      const s = d.items.find((x) => x.id === id)
      if (s) s.revokedAt = new Date().toISOString()
    })
  }

  // ---- gateway tokens（模型网关按人令牌：一人一座，每台登录中的电脑一枚，绑定它的登录会话）----
  /**
   * 签发网关令牌。绑定登录会话（sessionId）：同一台电脑重新签发会吊销它自己之前的令牌，
   * 别的电脑上的令牌不受影响（换电脑不把上一台踢下线；管理页 / 网页登录也不会打断桌面端）。
   * 管理员「吊销令牌」/ 停用账号仍然一次吊销这个人所有电脑上的令牌（revokeGatewayTokens）。
   */
  issueGatewayToken(userId, label, sessionId = null) {
    const token = `dgw_${crypto.randomBytes(24).toString('base64url')}`
    const item = {
      id: newId('gt-'),
      userId,
      sessionId,
      tokenHash: sha256(token),
      prefix: token.slice(0, 12),
      label: label ?? 'desktop',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    }
    this.gatewayTokens.update((d) => {
      for (const t of d.items) {
        if (t.userId !== userId || t.revokedAt) continue
        // 同一登录会话重签 → 旧的作废；未绑定会话的历史令牌（旧版签发）也一并收回
        if (!t.sessionId || t.sessionId === sessionId) t.revokedAt = item.createdAt
      }
      d.items.push(item)
    })
    return { token, item }
  }
  /** 某个登录会话（某台电脑）当前有效的网关令牌。 */
  gatewayTokenForSession(sessionId) {
    if (!sessionId) return undefined
    return this.gatewayTokens.load().items.find((t) => t.sessionId === sessionId && !t.revokedAt)
  }
  /** 登出：只收回这台电脑的令牌。 */
  revokeGatewayTokensForSession(sessionId) {
    if (!sessionId) return 0
    let count = 0
    this.gatewayTokens.update((d) => {
      for (const t of d.items)
        if (t.sessionId === sessionId && !t.revokedAt) {
          t.revokedAt = new Date().toISOString()
          count++
        }
    })
    return count
  }
  findGatewayToken(token) {
    if (!token) return undefined
    const h = sha256(token)
    const item = this.gatewayTokens.load().items.find((t) => t.tokenHash === h)
    if (!item || item.revokedAt) return undefined
    return item
  }
  touchGatewayToken(id) {
    this.gatewayTokens.update((d) => {
      const t = d.items.find((x) => x.id === id)
      if (t) t.lastUsedAt = new Date().toISOString()
    })
  }
  revokeGatewayTokens(userId) {
    let count = 0
    this.gatewayTokens.update((d) => {
      for (const t of d.items)
        if (t.userId === userId && !t.revokedAt) {
          t.revokedAt = new Date().toISOString()
          count++
        }
    })
    return count
  }
  activeGatewayToken(userId) {
    return this.gatewayTokens.load().items.find((t) => t.userId === userId && !t.revokedAt)
  }

  // ---- settings ----
  companySettings() {
    return this.settings.load().company
  }
  updateCompanySettings(patch) {
    return this.settings.update((d) => Object.assign(d.company, patch))
  }
  userSettings(userId) {
    return this.settings.load().users[userId] ?? {}
  }
  updateUserSettings(userId, patch) {
    return this.settings.update((d) => {
      d.users[userId] = { ...(d.users[userId] ?? {}), ...patch }
      return d.users[userId]
    })
  }
}

/** 对外安全视图：去掉密码散列等。 */
export function publicUser(u) {
  if (!u) return undefined
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    roleLabel: ROLE_LABELS[u.role] ?? u.role,
    department: u.department,
    disabled: !!u.disabled,
    seed: !!u.seed,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
    lastSeenAt: u.lastSeenAt,
  }
}
