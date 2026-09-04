import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { backupGateway, snapshotDataDir, stampName } from '../backup-gateway.mjs'

test('stampName 形状', () => {
  assert.match(stampName(new Date('2026-09-04T11:22:33')), /^gateway-20260904-/)
})

test('snapshot：sqlite serialize + drive + 遗留 json', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-bak-src-'))
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-bak-dst-'))
  try {
    const db = new DatabaseSync(path.join(data, 'gateway.sqlite'))
    db.exec('CREATE TABLE kv (name TEXT PRIMARY KEY, json TEXT); INSERT INTO kv VALUES (\'users.json\', \'{"items":[]}\')')
    db.close()
    fs.mkdirSync(path.join(data, 'drive', '_shared', 'skills'), { recursive: true })
    fs.writeFileSync(path.join(data, 'drive', '_shared', 'skills', 'a.md'), '# x\n')
    fs.writeFileSync(path.join(data, 'channels.json'), '{"items":{}}')
    const snap = snapshotDataDir(data, path.join(dest, 'snap'))
    assert.ok(snap.sqlite)
    assert.equal(snap.drive, true)
    assert.ok(snap.extras.includes('channels.json'))
    const copy = new DatabaseSync(snap.sqlite, { readOnly: true })
    assert.equal(copy.prepare('SELECT json FROM kv WHERE name = ?').get('users.json').json, '{"items":[]}')
    copy.close()
    assert.ok(fs.existsSync(path.join(dest, 'snap', 'drive', '_shared', 'skills', 'a.md')))
  } finally {
    fs.rmSync(data, { recursive: true, force: true })
    fs.rmSync(dest, { recursive: true, force: true })
  }
})

test('backupGateway 打出 zip', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-bak-src-'))
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-bak-out-'))
  try {
    fs.writeFileSync(path.join(data, 'settings.json'), '{"company":{}}')
    const zip = path.join(outDir, 'one.zip')
    const r = backupGateway({ dataDir: data, out: zip })
    assert.equal(r.artifact, zip)
    assert.ok(fs.existsSync(zip))
    assert.ok(fs.statSync(zip).size > 20)
  } finally {
    fs.rmSync(data, { recursive: true, force: true })
    fs.rmSync(outDir, { recursive: true, force: true })
  }
})
