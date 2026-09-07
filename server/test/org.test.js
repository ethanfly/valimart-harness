import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Db } from '../src/db.js'
import { Ledger } from '../src/ledger.js'
import { openOrg, resolveWeeklyQuota, groupSkillFiles, assertSafeLabel } from '../src/org.js'

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-org-'))
  const db = new Db(dir)
  t.after(() => {
    try {
      db.persist.close()
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, db }
}

test('assertSafeLabel：拒路径', () => {
  assert.equal(assertSafeLabel('设计师'), '设计师')
  assert.throws(() => assertSafeLabel('../x'), /路径/)
  assert.throws(() => assertSafeLabel(''), /不合法/)
})

test('resolveWeeklyQuota：个人 → 岗位 → 角色 → 公司', () => {
  const user = { role: 'employee' }
  const company = { weeklyQuotaCny: 80, quotaByRole: { employee: 50 }, positions: [] }
  const cfg = { quota: { weeklyCny: 200 } }
  assert.deepEqual(resolveWeeklyQuota({ user, company, cfg }), { kind: 'cny', limit: 50, source: 'role' })
  assert.deepEqual(
    resolveWeeklyQuota({ user, position: { quotaKind: 'tokens', weeklyQuotaTokens: 10000 }, company, cfg }),
    { kind: 'tokens', limit: 10000, source: 'position' },
  )
  assert.deepEqual(
    resolveWeeklyQuota({ user, userSettings: { weeklyQuotaCny: 12 }, position: { weeklyQuotaCny: 9 }, company, cfg }),
    { kind: 'cny', limit: 12, source: 'user' },
  )
})

test('openOrg：岗位 CRUD + 删岗位清人', (t) => {
  const { db } = tmp(t)
  const org = openOrg(db)
  const pos = org.createPosition({ name: '设计师', quotaKind: 'tokens', weeklyQuotaTokens: 8000 })
  assert.equal(pos.quotaKind, 'tokens')
  assert.equal(org.listPositions().length, 1)
  const u = db.createUser({ username: 'ada', password: 'ada123456', role: 'employee', department: '设计部', positionId: pos.id })
  assert.equal(u.positionId, pos.id)
  org.updatePosition(pos.id, { weeklyQuotaTokens: 9000, quotaKind: 'tokens' })
  assert.equal(org.getPosition(pos.id).weeklyQuotaTokens, 9000)
  org.deletePosition(pos.id)
  assert.equal(db.getUser(u.id).positionId, null)
  assert.equal(org.listPositions().length, 0)
})

test('openOrg：部门列表合并用户已有部门', (t) => {
  const { db } = tmp(t)
  const org = openOrg(db)
  db.createUser({ username: 'ada', password: 'ada123456', role: 'employee', department: '设计部' })
  org.createDepartment({ name: '电商部' })
  const names = org.listDepartments().map((d) => d.name)
  assert.ok(names.includes('设计部'))
  assert.ok(names.includes('电商部'))
  org.renameDepartment('电商部', '零售部')
  assert.ok(org.listDepartments().some((d) => d.name === '零售部'))
})

test('Ledger：岗位 token 额度按总量卡，金额额度仍按上游', (t) => {
  const { db } = tmp(t)
  const org = openOrg(db)
  const pos = org.createPosition({ name: '文案', quotaKind: 'tokens', weeklyQuotaTokens: 100 })
  const u = db.createUser({ username: 'copy', password: 'copy123456', role: 'employee', positionId: pos.id })
  const ledger = new Ledger(db, { quota: { weeklyCny: 200, anchor: '2026-01-05T00:00:00+08:00' } })
  assert.equal(ledger.resolveQuota(u).kind, 'tokens')
  assert.equal(ledger.exceeded(u, 'deepseek'), false)
  ledger.record({ userId: u.id, provider: 'deepseek', promptTokens: 60, completionTokens: 50, costCny: 0.01 })
  assert.equal(ledger.exceeded(u, 'deepseek'), true)
  const view = ledger.quotaView(u, [{ id: 'deepseek', label: 'DeepSeek' }])
  assert.equal(view[0].kind, 'tokens')
  assert.equal(view[0].usedTokens, 110)
  assert.equal(view[0].limitTokens, 100)
})

test('groupSkillFiles：按技能目录收拢', () => {
  const g = groupSkillFiles([
    { path: '_shared/skills/brief/SKILL.md', size: 10 },
    { path: '_shared/skills/brief/scripts/a.mjs', size: 20 },
    { path: '_shared/skills/other/SKILL.md', size: 5 },
  ])
  assert.equal(g.length, 2)
  assert.equal(g.find((x) => x.name === 'brief').files.length, 2)
})
