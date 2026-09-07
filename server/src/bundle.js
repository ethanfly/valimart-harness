/**
 * 公司配置导入导出：知识库、skill、工具目录、人员、岗位、部门。
 * 人员导出不含密码；导入已有账号只改资料，新建必须带密码。
 */
import { publicUser } from './db.js'
import { groupSkillFiles } from './org.js'
import { MEMORY_LAYERS, normalizeRel } from './drive.js'

export const BUNDLE_KIND = 'valimart-harness-org'
export const BUNDLE_KINDS = ['knowledge', 'skills', 'tools', 'personnel', 'positions', 'departments']

const TEXT_MAX = 2 * 1024 * 1024

function bundleError(message, code = 'bad_request') {
  const err = new Error(message)
  err.code = code
  return err
}

function parseKinds(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const kinds = list.filter((k) => BUNDLE_KINDS.includes(k))
  return kinds.length ? kinds : BUNDLE_KINDS
}

function safeSharedRel(rel) {
  const n = normalizeRel(rel)
  if (!n || n.includes('..')) throw bundleError('非法路径')
  if (n.startsWith('_shared/handbook/') || n.startsWith('_shared/skills/') || n.startsWith('_shared/_memory/')) return n
  throw bundleError('只能导入公司盘共享区：handbook / skills / _memory')
}

function readTextFile(drive, rel) {
  const buf = drive.read(rel)
  if (buf.length > TEXT_MAX) return null
  return buf.toString('utf8')
}

function collectKnowledge(drive, knowledge, user) {
  const col = knowledge.collections(user)
  const out = []
  for (const f of col.handbook) {
    const content = readTextFile(drive, f.path)
    if (content != null) out.push({ path: f.path, content, size: f.size })
  }
  for (const layer of MEMORY_LAYERS) {
    for (const f of col.shared[layer.dir]?.files ?? []) {
      const content = readTextFile(drive, f.path)
      if (content != null) out.push({ path: f.path, content, size: f.size })
    }
  }
  return out
}

function collectSkills(drive, knowledge, user) {
  const col = knowledge.collections(user)
  return col.skills
    .map((f) => {
      const content = readTextFile(drive, f.path)
      return content == null ? null : { path: f.path, content, size: f.size }
    })
    .filter(Boolean)
}

export function exportBundle({ db, drive, knowledge, org, user, kinds, tools = [] } = {}) {
  if (!user) throw bundleError('未登录', 'unauthenticated')
  const pick = parseKinds(kinds)
  const bundle = { kind: BUNDLE_KIND, version: 1, exportedAt: new Date().toISOString(), kinds: pick }
  if (pick.includes('personnel')) {
    bundle.personnel = db.listUsers().map((u) => {
      const s = db.userSettings(u.id)
      return {
        ...publicUser(u),
        positionId: u.positionId ?? null,
        weeklyQuotaCny: s.weeklyQuotaCny ?? null,
        weeklyQuotaTokens: s.weeklyQuotaTokens ?? null,
        quotaKind: s.quotaKind ?? null,
      }
    })
  }
  if (pick.includes('positions')) bundle.positions = org.listPositions()
  if (pick.includes('departments')) bundle.departments = org.listDepartments()
  if (pick.includes('knowledge')) bundle.knowledge = collectKnowledge(drive, knowledge, user)
  if (pick.includes('skills')) bundle.skills = collectSkills(drive, knowledge, user)
  if (pick.includes('tools')) {
    bundle.tools = (tools || []).map((t) => (Array.isArray(t) ? { id: t[0], description: t[1] } : t))
    bundle.skillGroups = groupSkillFiles(knowledge.collections(user).skills)
  }
  return bundle
}

export function importBundle({ db, drive, org, user, bundle, kinds } = {}) {
  if (!user) throw bundleError('未登录', 'unauthenticated')
  if (!bundle || bundle.kind !== BUNDLE_KIND) throw bundleError('不是本公司的导入包')
  const pick = parseKinds(kinds ?? bundle.kinds)
  const result = { kinds: pick, created: {}, updated: {}, skipped: {} }

  if (pick.includes('departments') && Array.isArray(bundle.departments)) {
    let created = 0
    const have = new Set(org.listDepartments().map((d) => d.name))
    for (const d of bundle.departments) {
      const name = String(d?.name ?? '').trim()
      if (!name || have.has(name)) continue
      org.createDepartment({ name })
      have.add(name)
      created++
    }
    result.created.departments = created
  }

  if (pick.includes('positions') && Array.isArray(bundle.positions)) {
    let created = 0
    let updated = 0
    for (const p of bundle.positions) {
      const existing = org.listPositions().find((x) => x.id === p.id || x.name === p.name)
      if (existing) {
        org.updatePosition(existing.id, { name: p.name, quotaKind: p.quotaKind, weeklyQuotaCny: p.weeklyQuotaCny, weeklyQuotaTokens: p.weeklyQuotaTokens })
        updated++
      } else {
        org.createPosition({ name: p.name, quotaKind: p.quotaKind, weeklyQuotaCny: p.weeklyQuotaCny, weeklyQuotaTokens: p.weeklyQuotaTokens })
        created++
      }
    }
    result.created.positions = created
    result.updated.positions = updated
  }

  if (pick.includes('personnel') && Array.isArray(bundle.personnel)) {
    let created = 0
    let updated = 0
    let skipped = 0
    for (const row of bundle.personnel) {
      const username = String(row?.username ?? '').trim()
      if (!username) continue
      const found = db.getUserByName(username)
      if (found) {
        const patch = {}
        if (row.displayName !== undefined) patch.displayName = row.displayName
        if (row.role !== undefined) patch.role = row.role
        if (row.department !== undefined) patch.department = row.department
        if (row.positionId !== undefined) patch.positionId = row.positionId
        if (row.disabled !== undefined && !found.seed) patch.disabled = !!row.disabled
        db.updateUser(found.id, patch)
        const settings = {}
        if (row.weeklyQuotaCny !== undefined) settings.weeklyQuotaCny = row.weeklyQuotaCny
        if (row.weeklyQuotaTokens !== undefined) settings.weeklyQuotaTokens = row.weeklyQuotaTokens
        if (row.quotaKind !== undefined) settings.quotaKind = row.quotaKind
        if (Object.keys(settings).length) db.updateUserSettings(found.id, settings)
        updated++
      } else if (row.password) {
        const createdUser = db.createUser({
          username,
          password: row.password,
          displayName: row.displayName,
          role: row.role ?? 'employee',
          department: row.department,
          positionId: row.positionId,
        })
        if (row.weeklyQuotaCny != null || row.weeklyQuotaTokens != null || row.quotaKind) {
          db.updateUserSettings(createdUser.id, {
            weeklyQuotaCny: row.weeklyQuotaCny,
            weeklyQuotaTokens: row.weeklyQuotaTokens,
            quotaKind: row.quotaKind,
          })
        }
        created++
      } else {
        skipped++
      }
    }
    result.created.personnel = created
    result.updated.personnel = updated
    result.skipped.personnel = skipped
  }

  const writeFiles = (list) => {
    let n = 0
    for (const f of list || []) {
      const rel = safeSharedRel(f.path)
      drive.write(rel, String(f.content ?? ''))
      n++
    }
    return n
  }
  if (pick.includes('knowledge') && Array.isArray(bundle.knowledge)) result.updated.knowledge = writeFiles(bundle.knowledge)
  if (pick.includes('skills') && Array.isArray(bundle.skills)) result.updated.skills = writeFiles(bundle.skills)
  if (pick.includes('tools')) result.skipped.tools = (bundle.tools || []).length

  return result
}
