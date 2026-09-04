/**
 * SQLite 持久化 + JSON 迁移（只用临时目录）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPersistence, migrateJsonIfNeeded, openSqlite, sqlitePath } from '../src/store.js'

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'desk-store-'))
}

test('sqlite：file.update / log.append 往返', () => {
  const dir = tmp()
  const p = createPersistence(dir, { driver: 'sqlite' })
  try {
    p.file('users.json', () => ({ items: [] })).update((d) => {
      d.items.push({ id: 'u1' })
    })
    p.log('usage.jsonl').append({ n: 1 })
    p.log('usage.jsonl').append({ n: 2 })
    assert.deepEqual(p.file('users.json', () => ({ items: [] })).load().items, [{ id: 'u1' }])
    assert.deepEqual(p.log('usage.jsonl').readAll(), [{ n: 1 }, { n: 2 }])
    assert.ok(fs.existsSync(sqlitePath(dir)))
    assert.ok(!fs.existsSync(path.join(dir, 'users.json')))
  } finally {
    p.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sqlite：同 dataDir 复用连接；close 后可删目录', () => {
  const dir = tmp()
  const a = createPersistence(dir)
  const b = createPersistence(dir)
  assert.equal(a, b)
  a.file('settings.json', () => ({ company: {} })).update((d) => {
    d.company.name = 'x'
  })
  a.close()
  fs.rmSync(dir, { recursive: true, force: true })
  assert.ok(!fs.existsSync(dir))
})

test('迁移：空库导入遗留 JSON / JSONL，旧文件不删', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ items: [{ id: 'boss' }] }))
  fs.writeFileSync(path.join(dir, 'channels.json'), JSON.stringify({ items: { grok: { credential: 'secret' } } }))
  fs.writeFileSync(path.join(dir, 'usage.jsonl'), `${JSON.stringify({ cost: 1 })}\n${JSON.stringify({ cost: 2 })}\n`)
  const db = openSqlite(dir)
  const again = migrateJsonIfNeeded(dir, db)
  assert.equal(again.migrated, false)
  db.close()
  const p = createPersistence(dir)
  try {
    assert.equal(p.file('users.json', () => ({ items: [] })).load().items[0].id, 'boss')
    assert.equal(p.file('channels.json', () => ({ items: {} })).load().items.grok.credential, 'secret')
    assert.deepEqual(p.log('usage.jsonl').readAll().map((x) => x.cost), [1, 2])
    assert.ok(fs.existsSync(path.join(dir, 'users.json')))
  } finally {
    p.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('DESK_GATEWAY_STORE=json 仍写文件', () => {
  const dir = tmp()
  const p = createPersistence(dir, { driver: 'json' })
  try {
    p.file('tasks.json', () => ({ items: [] })).update((d) => {
      d.items.push({ id: 't1' })
    })
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8')).items[0].id, 't1')
    assert.ok(!fs.existsSync(sqlitePath(dir)))
  } finally {
    p.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
