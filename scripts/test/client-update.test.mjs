/**
 * 客户端整包更新：buildId 比较、pending、从网关拉 Setup.exe。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertSafeBuildId,
  readLocalBuildId,
  clientPendingPaths,
  readClientPending,
  writeClientPending,
  clearClientPending,
  shouldFetchClientUpdate,
  shouldApplyClientUpdate,
  applyPendingClientUpdate,
  silentInstallArgs,
} from '../lib/client-update.mjs'
import { openClientCatalog } from '../../server/src/client-catalog.js'
import { hashFile } from '../lib/kernel-update.mjs'
import { fetchClientUpdate } from '../../plugins/desk-host/lib/client-update.js'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-client-upd-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function shaOf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function mockGateway({ current, exe, failCurrent } = {}) {
  const calls = []
  return {
    calls,
    async get(p) {
      calls.push({ m: 'GET', p })
      if (failCurrent) throw failCurrent
      if (p === '/api/client/current') return current
      throw new Error('unexpected GET ' + p)
    },
    async request(m, p, o) {
      calls.push({ m, p, o })
      if (p === '/api/client/download') return exe ?? Buffer.from('SETUP')
      throw new Error('unexpected ' + m + ' ' + p)
    },
  }
}

test('assertSafeBuildId：拒绝路径穿越', () => {
  assert.equal(assertSafeBuildId('0.1.0+0.1.2-rc.1.20260907-0511.ae8ba495'), '0.1.0+0.1.2-rc.1.20260907-0511.ae8ba495')
  assert.throws(() => assertSafeBuildId('../x'), /非法/)
  assert.throws(() => assertSafeBuildId('a/b'), /非法/)
  assert.throws(() => assertSafeBuildId('current.json'), /非法/)
})

test('readLocalBuildId：读 payload.json', (t) => {
  const dir = tmp(t)
  fs.writeFileSync(path.join(dir, 'payload.json'), JSON.stringify({ buildId: 'bid-1', version: '0.1.0' }))
  assert.equal(readLocalBuildId(dir), 'bid-1')
  assert.equal(readLocalBuildId(path.join(dir, 'missing')), null)
})

test('shouldFetchClientUpdate：无发布 / 同 buildId / 已 pending 不拉', () => {
  assert.deepEqual(shouldFetchClientUpdate({ available: false }, 'old', null), { fetch: false, reason: 'unavailable' })
  assert.deepEqual(
    shouldFetchClientUpdate({ available: true, buildId: 'a', sha256: '11'.repeat(32) }, 'a', null),
    { fetch: false, reason: 'same-build' },
  )
  assert.deepEqual(
    shouldFetchClientUpdate(
      { available: true, buildId: 'b', sha256: '22'.repeat(32) },
      'a',
      { buildId: 'b', sha256: '22'.repeat(32) },
    ),
    { fetch: false, reason: 'already-pending' },
  )
  assert.equal(shouldFetchClientUpdate({ available: true, buildId: 'b', sha256: '22'.repeat(32) }, 'a', null).fetch, true)
})

test('shouldApplyClientUpdate：仅安装版且 hash 对才应用；开发版不装', () => {
  const pending = { buildId: 'new', sha256: 'aa'.repeat(32) }
  assert.equal(shouldApplyClientUpdate(pending, { packaged: false, exeExists: true, sha: pending.sha256 }).apply, false)
  assert.equal(shouldApplyClientUpdate(pending, { packaged: true, exeExists: false, sha: pending.sha256 }).apply, false)
  assert.equal(shouldApplyClientUpdate(pending, { packaged: true, exeExists: true, sha: 'bb'.repeat(32) }).apply, false)
  assert.equal(shouldApplyClientUpdate(pending, { packaged: true, exeExists: true, sha: pending.sha256, localBuildId: 'new' }).apply, false)
  const ok = shouldApplyClientUpdate(pending, { packaged: true, exeExists: true, sha: pending.sha256, localBuildId: 'old' })
  assert.equal(ok.apply, true)
  assert.deepEqual(ok.args, silentInstallArgs())
  assert.deepEqual(silentInstallArgs(), ['/S'])
})

test('openClientCatalog：入库、发布、回滚、员工视图', (t) => {
  const dataDir = tmp(t)
  const cat = openClientCatalog(dataDir)
  assert.equal(cat.employeeView().available, false)

  const exe = path.join(dataDir, 'setup.exe')
  fs.writeFileSync(exe, 'FAKE-SETUP')
  const sha = hashFile(exe)
  const man = cat.saveArtifact({
    buildId: '0.1.0+aaa',
    exePath: exe,
    manifest: { version: '0.1.0', filename: 'valimart-harness-Setup-0.1.0.exe' },
  })
  assert.equal(man.sha256, sha)
  assert.equal(cat.listStored().length, 1)

  const pub = cat.publish('0.1.0+aaa')
  assert.equal(pub.buildId, '0.1.0+aaa')
  assert.equal(pub.previous, null)
  const ev = cat.employeeView()
  assert.equal(ev.available, true)
  assert.equal(ev.buildId, '0.1.0+aaa')
  assert.equal(ev.sha256, sha)
  assert.ok(cat.downloadPath())

  const exe2 = path.join(dataDir, 'setup2.exe')
  fs.writeFileSync(exe2, 'NEWER')
  cat.saveArtifact({ buildId: '0.1.0+bbb', exePath: exe2, manifest: { version: '0.1.0', filename: 'valimart-harness-Setup-0.1.0.exe' } })
  cat.publish('0.1.0+bbb')
  assert.equal(cat.employeeView().buildId, '0.1.0+bbb')
  const rb = cat.rollback()
  assert.equal(rb.buildId, '0.1.0+aaa')
})

test('openClientCatalog：sha 不符拒绝入库', (t) => {
  const dataDir = tmp(t)
  const cat = openClientCatalog(dataDir)
  const exe = path.join(dataDir, 'setup.exe')
  fs.writeFileSync(exe, 'X')
  assert.throws(
    () => cat.saveArtifact({ buildId: 'bid', exePath: exe, manifest: { sha256: '00'.repeat(32), version: '0.1.0' } }),
    /sha256/,
  )
})

test('fetchClientUpdate：无发布 / 同 buildId 不拉', async (t) => {
  const pendingDir = tmp(t)
  const gw = mockGateway({ current: { available: false } })
  const r = await fetchClientUpdate({ gateway: gw, pendingDir, localBuildId: 'old', log: () => {} })
  assert.equal(r.action, 'skip')
  assert.equal(gw.calls.some((c) => c.p === '/api/client/download'), false)

  const gw2 = mockGateway({ current: { available: true, buildId: 'same', sha256: '11'.repeat(32) } })
  const r2 = await fetchClientUpdate({ gateway: gw2, pendingDir, localBuildId: 'same', log: () => {} })
  assert.equal(r2.action, 'skip')
})

test('fetchClientUpdate：下载成功并写 pending', async (t) => {
  const pendingDir = tmp(t)
  const exe = Buffer.from('FAKE-CLIENT-SETUP')
  const sha = shaOf(exe)
  const gw = mockGateway({
    current: { available: true, buildId: '0.1.0+new', version: '0.1.0', sha256: sha, filename: 'valimart-harness-Setup-0.1.0.exe' },
    exe,
  })
  const r = await fetchClientUpdate({ gateway: gw, pendingDir, localBuildId: '0.1.0+old', log: () => {} })
  assert.equal(r.action, 'downloaded')
  const dl = gw.calls.find((c) => c.p === '/api/client/download')
  assert.ok(dl)
  assert.equal(dl.o?.timeoutMs, 600_000)
  assert.equal(fs.readFileSync(clientPendingPaths(pendingDir).exe).equals(exe), true)
  const p = readClientPending(pendingDir)
  assert.equal(p.buildId, '0.1.0+new')
  assert.equal(p.sha256, sha)
})

test('fetchClientUpdate：hash 不对则清 pending', async (t) => {
  const pendingDir = tmp(t)
  const gw = mockGateway({
    current: { available: true, buildId: 'x', sha256: '00'.repeat(32) },
    exe: Buffer.from('WRONG'),
  })
  const r = await fetchClientUpdate({ gateway: gw, pendingDir, localBuildId: 'old', log: () => {} })
  assert.equal(r.action, 'error')
  assert.equal(readClientPending(pendingDir), null)
})

test('pending 读写', (t) => {
  const dir = tmp(t)
  assert.equal(readClientPending(dir), null)
  writeClientPending(dir, { buildId: 'a', sha256: 'bb'.repeat(32) })
  assert.equal(readClientPending(dir).buildId, 'a')
  clearClientPending(dir)
  assert.equal(readClientPending(dir), null)
})

test('applyPendingClientUpdate：安装版 hash 对则 spawn /S', (t) => {
  const dir = tmp(t)
  const payloadDir = tmp(t)
  const exe = clientPendingPaths(dir).exe
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(exe, 'FAKE-SETUP-APPLY')
  const sha = hashFile(exe)
  writeClientPending(dir, { buildId: '0.1.0+new', sha256: sha })
  fs.writeFileSync(path.join(payloadDir, 'payload.json'), JSON.stringify({ buildId: '0.1.0+old' }))
  const spawned = []
  const r = applyPendingClientUpdate({
    pendingDir: dir,
    payloadDir,
    packaged: true,
    hashFile,
    spawn: (file, args, opts) => {
      spawned.push({ file, args, opts })
      return { unref() {} }
    },
  })
  assert.equal(r.applied, true)
  assert.equal(r.buildId, '0.1.0+new')
  assert.deepEqual(r.args, ['/S'])
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].file, exe)
  assert.deepEqual(spawned[0].args, ['/S'])
  assert.equal(spawned[0].opts.detached, true)
})

test('applyPendingClientUpdate：已是当前版或 hash 不对则清 pending 且不装', (t) => {
  const dir = tmp(t)
  const payloadDir = tmp(t)
  const exe = clientPendingPaths(dir).exe
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(exe, 'FAKE-SETUP-SKIP')
  const sha = hashFile(exe)
  writeClientPending(dir, { buildId: 'same', sha256: sha })
  fs.writeFileSync(path.join(payloadDir, 'payload.json'), JSON.stringify({ buildId: 'same' }))
  const spawned = []
  const same = applyPendingClientUpdate({
    pendingDir: dir,
    payloadDir,
    packaged: true,
    hashFile,
    spawn: (...a) => {
      spawned.push(a)
    },
  })
  assert.equal(same.applied, false)
  assert.equal(same.reason, 'already-current')
  assert.equal(spawned.length, 0)
  assert.equal(readClientPending(dir), null)

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(exe, 'FAKE-SETUP-SKIP')
  writeClientPending(dir, { buildId: 'other', sha256: '00'.repeat(32) })
  fs.writeFileSync(path.join(payloadDir, 'payload.json'), JSON.stringify({ buildId: 'old' }))
  const bad = applyPendingClientUpdate({
    pendingDir: dir,
    payloadDir,
    packaged: true,
    hashFile,
    spawn: (...a) => {
      spawned.push(a)
    },
  })
  assert.equal(bad.applied, false)
  assert.equal(bad.reason, 'hash-mismatch')
  assert.equal(spawned.length, 0)
  assert.equal(readClientPending(dir), null)

  writeClientPending(dir, { buildId: 'x', sha256: sha })
  fs.writeFileSync(exe, 'FAKE-SETUP-SKIP')
  const dev = applyPendingClientUpdate({
    pendingDir: dir,
    payloadDir,
    packaged: false,
    hashFile,
    spawn: (...a) => {
      spawned.push(a)
    },
  })
  assert.equal(dev.applied, false)
  assert.equal(dev.reason, 'dev')
  assert.equal(spawned.length, 0)
})

test('发布 CLI 与 npm script 指向网关 /api/admin/client/publish', () => {
  const src = fs.readFileSync(path.join(repo, 'scripts', 'client', 'publish.mjs'), 'utf8')
  assert.match(src, /\/api\/admin\/client\/publish/)
  assert.match(src, /x-client-build-id/)
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['client:publish'], 'node scripts/client/publish.mjs')
})
