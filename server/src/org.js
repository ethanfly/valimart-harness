/**
 * 岗位 / 部门目录，以及周额度解析（金额或 token 总量）。
 * 额度优先级：个人覆盖 → 岗位 → 角色 → 公司默认。
 */
import { newId } from './db.js'

export const QUOTA_KINDS = ['cny', 'tokens']

function orgError(message, code = 'bad_request') {
  const err = new Error(message)
  err.code = code
  return err
}

export function assertSafeLabel(name, label = '名称') {
  const s = String(name ?? '').trim()
  if (!s || s.length > 40) throw orgError(`${label}不合法`)
  if (s.includes('/') || s.includes('\\') || s.includes('..')) throw orgError(`${label}不能含路径`)
  return s
}

export function normalizeQuota({ quotaKind, weeklyQuotaCny, weeklyQuotaTokens } = {}) {
  const kind = quotaKind == null || quotaKind === '' ? undefined : String(quotaKind)
  if (kind && !QUOTA_KINDS.includes(kind)) throw orgError('额度类型只能是 cny 或 tokens')
  const cny = weeklyQuotaCny === undefined || weeklyQuotaCny === null || weeklyQuotaCny === '' ? undefined : Number(weeklyQuotaCny)
  const tokens = weeklyQuotaTokens === undefined || weeklyQuotaTokens === null || weeklyQuotaTokens === '' ? undefined : Number(weeklyQuotaTokens)
  if (cny !== undefined && (!Number.isFinite(cny) || cny < 0)) throw orgError('金额额度必须是 ≥0 的数字（0 = 不限额）')
  if (tokens !== undefined && (!Number.isFinite(tokens) || tokens < 0 || !Number.isInteger(tokens))) throw orgError('token 额度必须是 ≥0 的整数（0 = 不限额）')
  if (kind === 'cny' && cny === undefined) throw orgError('金额额度未填写')
  if (kind === 'tokens' && tokens === undefined) throw orgError('token 额度未填写')
  return { quotaKind: kind, weeklyQuotaCny: cny, weeklyQuotaTokens: tokens }
}

export function resolveWeeklyQuota({ user, userSettings = {}, position, company = {}, cfg = {} } = {}) {
  const us = userSettings ?? {}
  if (us.quotaKind === 'tokens' && Number.isFinite(us.weeklyQuotaTokens)) {
    return { kind: 'tokens', limit: us.weeklyQuotaTokens, source: 'user' }
  }
  if (Number.isFinite(us.weeklyQuotaCny)) {
    return { kind: 'cny', limit: us.weeklyQuotaCny, source: 'user' }
  }
  if (position) {
    if (position.quotaKind === 'tokens' && Number.isFinite(position.weeklyQuotaTokens)) {
      return { kind: 'tokens', limit: position.weeklyQuotaTokens, source: 'position' }
    }
    if (Number.isFinite(position.weeklyQuotaCny)) {
      return { kind: 'cny', limit: position.weeklyQuotaCny, source: 'position' }
    }
  }
  const byRole = { ...(cfg.quota?.byRole ?? {}), ...(company.quotaByRole ?? {}) }
  if (user?.role && typeof byRole[user.role] === 'number') return { kind: 'cny', limit: byRole[user.role], source: 'role' }
  return { kind: 'cny', limit: company.weeklyQuotaCny ?? cfg.quota?.weeklyCny ?? 200, source: 'company' }
}

export function openOrg(db) {
  const read = () => {
    const c = db.companySettings() ?? {}
    return {
      positions: Array.isArray(c.positions) ? c.positions : [],
      departments: Array.isArray(c.departments) ? c.departments : [],
    }
  }

  const listPositions = () => read().positions.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))

  const getPosition = (id) => listPositions().find((p) => p.id === id) ?? null

  const listDepartments = () => {
    const named = new Map(read().departments.map((d) => [d.name, { ...d }]))
    for (const u of db.listUsers()) {
      const name = u.department || '未分组'
      if (!named.has(name)) named.set(name, { name })
    }
    return [...named.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }

  const createPosition = (input = {}) => {
    const name = assertSafeLabel(input.name, '岗位名')
    if (listPositions().some((p) => p.name === name)) throw orgError('岗位已存在', 'conflict')
    const quota = normalizeQuota(input)
    const pos = { id: newId('pos-'), name, createdAt: new Date().toISOString(), ...quota }
    db.updateCompanySettings({ positions: [...read().positions, pos] })
    return pos
  }

  const updatePosition = (id, input = {}) => {
    const positions = read().positions
    const i = positions.findIndex((p) => p.id === id)
    if (i < 0) throw orgError('岗位不存在', 'not_found')
    const next = { ...positions[i] }
    if (input.name !== undefined) {
      const name = assertSafeLabel(input.name, '岗位名')
      if (positions.some((p) => p.id !== id && p.name === name)) throw orgError('岗位已存在', 'conflict')
      next.name = name
    }
    if (input.quotaKind !== undefined || input.weeklyQuotaCny !== undefined || input.weeklyQuotaTokens !== undefined) {
      Object.assign(next, normalizeQuota({
        quotaKind: input.quotaKind !== undefined ? input.quotaKind : next.quotaKind,
        weeklyQuotaCny: input.weeklyQuotaCny !== undefined ? input.weeklyQuotaCny : next.weeklyQuotaCny,
        weeklyQuotaTokens: input.weeklyQuotaTokens !== undefined ? input.weeklyQuotaTokens : next.weeklyQuotaTokens,
      }))
    }
    next.updatedAt = new Date().toISOString()
    const copy = positions.slice()
    copy[i] = next
    db.updateCompanySettings({ positions: copy })
    return next
  }

  const deletePosition = (id) => {
    const positions = read().positions
    if (!positions.some((p) => p.id === id)) throw orgError('岗位不存在', 'not_found')
    db.updateCompanySettings({ positions: positions.filter((p) => p.id !== id) })
    for (const u of db.listUsers()) {
      if (u.positionId === id) db.updateUser(u.id, { positionId: null })
    }
    return { ok: true }
  }

  const createDepartment = (input = {}) => {
    const name = assertSafeLabel(input.name, '部门名')
    const current = read().departments
    if (current.some((d) => d.name === name) || db.listUsers().some((u) => (u.department || '未分组') === name)) {
      throw orgError('部门已存在', 'conflict')
    }
    const dep = { name }
    db.updateCompanySettings({ departments: [...current, dep] })
    return dep
  }

  const renameDepartment = (oldName, newName) => {
    const from = assertSafeLabel(oldName, '原部门名')
    const to = assertSafeLabel(newName, '新部门名')
    const current = read().departments
    const next = current.filter((d) => d.name !== from)
    if (!next.some((d) => d.name === to)) next.push({ name: to })
    db.updateCompanySettings({ departments: next })
    for (const u of db.listUsers()) {
      if ((u.department || '未分组') === from) db.updateUser(u.id, { department: to })
    }
    return { name: to }
  }

  const deleteDepartment = (name) => {
    const n = assertSafeLabel(name, '部门名')
    db.updateCompanySettings({ departments: read().departments.filter((d) => d.name !== n) })
    return { ok: true }
  }

  const assignUser = (userId, { positionId, department } = {}) => {
    const patch = {}
    if (positionId !== undefined) {
      if (positionId && !getPosition(positionId)) throw orgError('岗位不存在', 'not_found')
      patch.positionId = positionId || null
    }
    if (department !== undefined) patch.department = String(department).trim() || '未分组'
    return db.updateUser(userId, patch)
  }

  const adminView = () => ({
    positions: listPositions(),
    departments: listDepartments(),
  })

  return {
    listPositions,
    getPosition,
    listDepartments,
    createPosition,
    updatePosition,
    deletePosition,
    createDepartment,
    renameDepartment,
    deleteDepartment,
    assignUser,
    adminView,
  }
}

export function groupSkillFiles(files = []) {
  const groups = new Map()
  for (const f of files) {
    const rel = String(f.path || f.name || '')
    const parts = rel.replace(/^_shared\/skills\/?/, '').split('/').filter(Boolean)
    const key = parts.length > 1 ? parts[0] : '（根目录）'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(f)
  }
  return [...groups.entries()]
    .map(([name, items]) => ({ name, files: items, bytes: items.reduce((s, f) => s + (f.size || 0), 0) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}
