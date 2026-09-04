import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseReleaseTag, newerThan, filterDiscoverable, hashFile,
  pendingPaths, readPending, writePending, clearPending,
} from '../lib/kernel-update.mjs'

test('parseReleaseTag：只认 dsh-v 前缀', () => {
  assert.deepEqual(parseReleaseTag('dsh-v0.1.2-rc.1'), { version: '0.1.2-rc.1' })
  assert.deepEqual(parseReleaseTag('dsh-v0.1.1-rc.2'), { version: '0.1.1-rc.2' })
  assert.equal(parseReleaseTag('v0.1.2-rc.1'), null)
  assert.equal(parseReleaseTag('dsh-0.1.2'), null)
})

test('newerThan：核心版本与预发布', () => {
  assert.equal(newerThan('0.1.2-rc.1', '0.1.1-rc.2'), true)
  assert.equal(newerThan('0.1.2', '0.1.2-rc.1'), true)
  assert.equal(newerThan('0.1.2-rc.1', '0.1.2-alpha.5'), true)
  assert.equal(newerThan('0.1.1-rc.2', '0.1.2-rc.1'), false)
  assert.equal(newerThan('0.1.1-rc.2', '0.1.1-rc.2'), false)
})

test('filterDiscoverable：丢掉 draft / 旧版 / 坏 tag', () => {
  const rel = [
    { tag_name: 'dsh-v0.1.2-rc.1', draft: false, prerelease: true, name: 'v0.1.2-rc.1' },
    { tag_name: 'dsh-v0.1.1-rc.2', draft: false, prerelease: true, name: 'v0.1.1-rc.2' },
    { tag_name: 'dsh-v0.1.3', draft: true, prerelease: false, name: 'draft' },
    { tag_name: 'other-v1', draft: false, name: 'nope' },
  ]
  const out = filterDiscoverable(rel, '0.1.1-rc.2')
  assert.deepEqual(out.map((x) => x.version), ['0.1.2-rc.1'])
  assert.equal(filterDiscoverable(rel, null).length, 2) // 0.1.2-rc.1 + 0.1.1-rc.2
})

test('pending：读写、hash、清理', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-kup-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'a.bin')
  fs.writeFileSync(file, 'hello')
  const sha = hashFile(file)
  assert.equal(sha, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  assert.equal(readPending(dir), null)
  writePending(dir, { version: '0.1.2-rc.1', sha256: sha })
  const p = readPending(dir)
  assert.equal(p.version, '0.1.2-rc.1')
  assert.equal(p.sha256, sha)
  assert.ok(p.downloadedAt)
  assert.equal(pendingPaths(dir).json, path.join(dir, 'pending.json'))
  clearPending(dir)
  assert.equal(readPending(dir), null)
  assert.equal(fs.existsSync(dir), false)
})
