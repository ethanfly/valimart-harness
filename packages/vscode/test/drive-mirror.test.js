import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { DriveMirror } from '../src/lib/drive-mirror.js'
import { assertInside, isCompanyDriveRel, zoneRoot } from '../src/lib/drive-paths.js'
import { resolveWorkOrDrive } from '../src/lib/workspace-fs.js'

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

test('drive-paths zoneRoot and isCompanyDriveRel', () => {
  assert.equal(zoneRoot('personal', 'emp-a'), '_office/emp-a/_memory')
  assert.equal(zoneRoot('handbook', 'x'), '_shared/handbook')
  assert.ok(isCompanyDriveRel('_shared/_memory/02-methods/a.md'))
  assert.ok(isCompanyDriveRel('_shared'))
  assert.ok(isCompanyDriveRel('projects/inbox/tk-1/_task-card.md'))
  assert.equal(isCompanyDriveRel('src/index.js'), false)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-dp-'))
  assert.throws(() => assertInside(root, '../outside.txt'))
  fs.rmSync(root, { recursive: true, force: true })
})

test('resolveWorkOrDrive reads drive paths and blocks writing shared', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ws-'))
  const drive = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-dr-'))
  fs.mkdirSync(path.join(drive, '_shared', 'handbook'), { recursive: true })
  fs.writeFileSync(path.join(drive, '_shared', 'handbook', 'a.md'), 'hi')
  fs.mkdirSync(path.join(drive, '_office', 'emp-a', '_memory'), { recursive: true })
  const abs = resolveWorkOrDrive(ws, '_shared/handbook/a.md', { driveRoot: drive, username: 'emp-a' })
  assert.equal(fs.readFileSync(abs, 'utf8'), 'hi')
  assert.throws(
    () => resolveWorkOrDrive(ws, '_shared/handbook/a.md', { driveRoot: drive, username: 'emp-a', write: true }),
    /company_memory_write/,
  )
  const personal = resolveWorkOrDrive(ws, '_office/emp-a/_memory/x.md', { driveRoot: drive, username: 'emp-a', write: true })
  assert.ok(personal.includes('_office'))
  fs.rmSync(ws, { recursive: true, force: true })
  fs.rmSync(drive, { recursive: true, force: true })
})

test('DriveMirror pull + personal push + tomb + task card', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-mir-'))
  const remote = new Map()
  const body = Buffer.from('# handbook\n')
  remote.set('_shared/handbook/guide.md', { buf: body, sha256: sha(body) })
  const gw = {
    async get(apiPath) {
      if (apiPath === '/api/drive/snapshot') {
        return {
          files: [...remote.entries()].map(([p, v]) => ({ path: p, sha256: v.sha256, size: v.buf.length })),
          memoryLayers: [{ dir: '02-methods' }, { dir: '05-logs' }],
        }
      }
      const q = new URLSearchParams(apiPath.split('?')[1] ?? '')
      const p = q.get('path')
      if (!remote.has(p)) throw new Error('missing ' + p)
      return remote.get(p).buf
    },
    async put(apiPath, buf) {
      const q = new URLSearchParams(apiPath.split('?')[1] ?? '')
      const p = q.get('path')
      remote.set(p, { buf, sha256: sha(buf) })
      return { file: { path: p, size: buf.length } }
    },
  }
  const state = { data: { user: { username: 'emp-a' } }, save() {} }
  const logs = []
  const mirror = new DriveMirror({ root, gateway: gw, state, log: (m) => logs.push(m) })
  const pulled = await mirror.sync()
  assert.equal(pulled.downloaded, 1)
  assert.ok(fs.existsSync(path.join(root, '_shared', 'handbook', 'guide.md')))
  assert.ok(fs.existsSync(path.join(root, 'README.md')))
  assert.ok(fs.existsSync(path.join(root, '_office', 'emp-a', '_memory', '02-methods')))

  const localNew = path.join(root, '_office', 'emp-a', '_memory', '02-methods', 'note.md')
  fs.writeFileSync(localNew, 'local-only')
  const pushed = await mirror.sync()
  assert.equal(pushed.pushed, 1)
  assert.ok(remote.has('_office/emp-a/_memory/02-methods/note.md'))

  mirror.writeTaskCard({
    id: 'tk-test',
    title: '卡',
    status: 'draft',
    statusLabel: '进行中',
    content: 'c',
    submission: '',
    deliverables: [],
    sessions: [],
    log: [],
    createdAt: '2026-01-01',
  })
  assert.ok(fs.existsSync(path.join(root, 'projects', 'inbox', 'tk-test', '_task-card.md')))
  fs.rmSync(root, { recursive: true, force: true })
})
