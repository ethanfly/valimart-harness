import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Db } from '../src/db.js'
import { Drive } from '../src/drive.js'
import { Knowledge } from '../src/knowledge.js'
import { openOrg } from '../src/org.js'
import { exportBundle, importBundle, BUNDLE_KIND } from '../src/bundle.js'

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-bundle-'))
  const db = new Db(dir)
  t.after(() => {
    try {
      db.persist.close()
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const drive = new Drive(db.driveRoot)
  drive.ensureLayout({ seedSamples: false })
  const knowledge = new Knowledge({ drive, tasks: { visibleTo: () => [] }, db })
  const org = openOrg(db)
  const admin = db.createUser({ username: 'boss', password: 'boss123456', role: 'admin', department: '管理层' })
  return { dir, db, drive, knowledge, org, admin }
}

test('export/import：岗位部门人员 + 知识技能', (t) => {
  const a = setup(t)
  a.org.createPosition({ name: '设计师', quotaKind: 'cny', weeklyQuotaCny: 30 })
  a.org.createDepartment({ name: '设计部' })
  a.db.createUser({ username: 'ada', password: 'ada123456', role: 'employee', department: '设计部' })
  a.drive.write('_shared/handbook/手册.md', '# 手册\n')
  a.drive.write('_shared/skills/brief/SKILL.md', '# skill\n')
  a.drive.write('_shared/_memory/02-methods/方法.md', '# 方法\n')
  const bundle = exportBundle({
    db: a.db,
    drive: a.drive,
    knowledge: a.knowledge,
    org: a.org,
    user: a.admin,
    tools: [['company_knowledge', '检索']],
  })
  assert.equal(bundle.kind, BUNDLE_KIND)
  assert.ok(bundle.personnel.some((u) => u.username === 'ada' && !('passwordHash' in u)))
  assert.ok(bundle.positions.some((p) => p.name === '设计师'))
  assert.ok(bundle.knowledge.some((f) => f.path.endsWith('手册.md')))
  assert.ok(bundle.skills.some((f) => f.path.includes('brief')))

  const b = setup(t)
  const r = importBundle({ db: b.db, drive: b.drive, org: b.org, user: b.admin, bundle })
  assert.equal(r.created.positions, 1)
  assert.ok(b.org.listDepartments().some((d) => d.name === '设计部'))
  assert.equal(r.skipped.personnel, 1, 'ada 没有密码，新库跳过新建')
  assert.ok(fs.existsSync(path.join(b.db.driveRoot, '_shared', 'handbook', '手册.md')))
  assert.ok(fs.existsSync(path.join(b.db.driveRoot, '_shared', 'skills', 'brief', 'SKILL.md')))

  const withPw = { ...bundle, personnel: bundle.personnel.map((u) => (u.username === 'ada' ? { ...u, password: 'ada123456' } : u)) }
  const c = setup(t)
  const r2 = importBundle({ db: c.db, drive: c.drive, org: c.org, user: c.admin, bundle: withPw, kinds: ['personnel'] })
  assert.equal(r2.created.personnel, 1)
  assert.ok(c.db.getUserByName('ada'))
})

test('import：拒绝跳出共享区的路径', (t) => {
  const a = setup(t)
  assert.throws(
    () =>
      importBundle({
        db: a.db,
        drive: a.drive,
        org: a.org,
        user: a.admin,
        bundle: { kind: BUNDLE_KIND, version: 1, knowledge: [{ path: '_office/boss/secret.md', content: 'x' }] },
      }),
    /共享区/,
  )
})
