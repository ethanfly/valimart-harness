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
  extractClientMetaFromInstaller,
  resolvePublishedBuildId,
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

test('本机修复版比网关旧发布新：不下载、不安装，并清除已下载的降级包', async (t) => {
  const old = '0.1.0+0.1.2-rc.1.20260908-1012.7d44f77f'
  const current = '0.1.0+0.1.2-rc.1.20260908-1038.a8a198b1'
  const remote = { available: true, buildId: old, sha256: 'aa'.repeat(32), filename: 'valimart-harness-Setup-0.1.0-20260908.1012.exe' }
  assert.deepEqual(shouldFetchClientUpdate(remote, current, remote), { fetch: false, reason: 'older-build' })
  assert.deepEqual(shouldApplyClientUpdate(remote, { packaged: true, exeExists: true, localBuildId: current }), { apply: false, reason: 'older-build' })
  assert.equal(shouldFetchClientUpdate({ ...remote, buildId: current }, old).fetch, true)
  // Filename fallback handles catalog entries whose buildId was entered manually.
  assert.equal(shouldFetchClientUpdate({ ...remote, buildId: 'legacy' }, 'local', null, { installerVersion: '0.1.0-20260908.1038' }).reason, 'older-build')
  const dir = tmp(t)
  const pendingDir = path.join(dir, 'pending')
  writeClientPending(pendingDir, remote)
  fs.writeFileSync(clientPendingPaths(pendingDir).exe, 'old-installer')
  const gateway = mockGateway({ current: remote })
  assert.equal((await fetchClientUpdate({ gateway, pendingDir, localBuildId: current })).detail, 'older-build')
  assert.equal(readClientPending(pendingDir), null)
  assert.equal(gateway.calls.length, 1)
  writeClientPending(pendingDir, remote)
  fs.writeFileSync(clientPendingPaths(pendingDir).exe, 'old-installer')
  const payloadDir = path.join(dir, 'payload')
  fs.mkdirSync(payloadDir)
  fs.writeFileSync(path.join(payloadDir, 'payload.json'), JSON.stringify({ buildId: current }))
  const applied = applyPendingClientUpdate({ pendingDir, payloadDir, packaged: true, hashFile: () => remote.sha256, spawn: () => assert.fail('must not launch older installer') })
  assert.equal(applied.reason, 'older-build')
  assert.equal(readClientPending(pendingDir), null)
})

test('shouldFetchClientUpdate：发布填错 buildId 但安装包文件名已是本机版本则不拉', () => {
  const current = {
    available: true,
    buildId: '0.1.1',
    sha256: '22'.repeat(32),
    filename: 'valimart-harness-Setup-0.1.0-20260907.0658.exe',
  }
  assert.deepEqual(
    shouldFetchClientUpdate(current, '0.1.0+0.1.2-rc.1.20260907-0658.8d73e2ac', null, {
      installerVersion: '0.1.0-20260907.0658',
    }),
    { fetch: false, reason: 'same-build' },
  )
  assert.equal(
    shouldFetchClientUpdate(
      { ...current, filename: 'valimart-harness-Setup-0.1.0-20260908.1200.exe' },
      'old',
      null,
      { installerVersion: '0.1.0-20260907.0658' },
    ).fetch,
    true,
  )
})

test('shouldApplyClientUpdate：pending 文件名已含本机 installerVersion 则不再静默安装', () => {
  const pending = {
    buildId: '0.1.1',
    sha256: 'aa'.repeat(32),
    filename: 'valimart-harness-Setup-0.1.0-20260907.0658.exe',
  }
  const skip = shouldApplyClientUpdate(pending, {
    packaged: true,
    exeExists: true,
    sha: pending.sha256,
    localBuildId: '0.1.0+real',
    localInstallerVersion: '0.1.0-20260907.0658',
  })
  assert.equal(skip.apply, false)
  assert.equal(skip.reason, 'already-current')
})

test('extractClientMetaFromInstaller：从安装包明文读 VMBUILD / installerVersion', () => {
  const id = '0.1.0+0.1.2-rc.1.20260907-0658.8d73e2ac'
  const utf16 = Buffer.from(`Valimart VMBUILD ${id} ProductVersion 0.1.0-20260907.0658`, 'utf16le')
  assert.deepEqual(extractClientMetaFromInstaller(utf16), { buildId: id, installerVersion: '0.1.0-20260907.0658' })
  const latin = Buffer.from(`padding VMBUILD ${id} more`)
  assert.equal(extractClientMetaFromInstaller(latin).buildId, id)
  assert.equal(extractClientMetaFromInstaller(Buffer.from('MZ hello world')), null)
})

test('resolvePublishedBuildId：安装包内的 buildId 优先于手填', () => {
  assert.equal(
    resolvePublishedBuildId({ headerBuildId: '0.1.1', extracted: { buildId: '0.1.0+real' } }),
    '0.1.0+real',
  )
  assert.equal(
    resolvePublishedBuildId({ headerBuildId: '0.1.1', extracted: { installerVersion: '0.1.0-20260907.0658' } }),
    '0.1.1',
  )
  assert.equal(
    resolvePublishedBuildId({ headerBuildId: '', extracted: { installerVersion: '0.1.0-20260907.0658' } }),
    '0.1.0-20260907.0658',
  )
  assert.equal(resolvePublishedBuildId({}), '')
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
  assert.deepEqual(silentInstallArgs(), ['/S', '--updated'])
})

test('静默更新拉起刚写入 $INSTDIR 的 exe，不打开可能被沙箱 /D= 改掉的快捷方式', () => {
  const nsh = fs.readFileSync(path.join(repo, 'desktop/build/installer.nsh'), 'utf8')
  const launch = nsh.split(/\r?\n/).find((line) => line.includes('ExecShellAsUser'))
  assert.ok(launch, 'customInstall 必须调用 ExecShellAsUser')
  assert.match(launch, /\$appExe/)
  assert.doesNotMatch(launch, /\$launchLink/)
  const verify = fs.readFileSync(path.join(repo, 'scripts/verify-installer-nsis.mjs'), 'utf8')
  assert.match(verify, /restoreOfficialShortcuts/)
  assert.match(verify, /--no-desktop-shortcut/)
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

test('openClientCatalog：删除历史包；删当前则回退上一版或清空', (t) => {
  const dataDir = tmp(t)
  const cat = openClientCatalog(dataDir)
  const exeA = path.join(dataDir, 'a.exe')
  const exeB = path.join(dataDir, 'b.exe')
  const exeC = path.join(dataDir, 'c.exe')
  fs.writeFileSync(exeA, 'A')
  fs.writeFileSync(exeB, 'B')
  fs.writeFileSync(exeC, 'C')
  cat.saveArtifact({ buildId: '0.1.0+aaa', exePath: exeA, manifest: { version: '0.1.0', filename: 'Setup-A.exe' } })
  cat.saveArtifact({ buildId: '0.1.0+bbb', exePath: exeB, manifest: { version: '0.1.0', filename: 'Setup-B.exe' } })
  cat.saveArtifact({ buildId: '0.1.0+ccc', exePath: exeC, manifest: { version: '0.1.0', filename: 'Setup-C.exe' } })
  cat.publish('0.1.0+aaa')
  cat.publish('0.1.0+bbb')

  const gone = cat.remove('0.1.0+ccc')
  assert.equal(gone.removed, '0.1.0+ccc')
  assert.equal(gone.current.buildId, '0.1.0+bbb')
  assert.deepEqual(gone.stored.map((v) => v.buildId).sort(), ['0.1.0+aaa', '0.1.0+bbb'])
  assert.equal(cat.employeeView().buildId, '0.1.0+bbb')

  const prev = cat.remove('0.1.0+aaa')
  assert.equal(prev.current.previous, null)
  assert.equal(prev.current.buildId, '0.1.0+bbb')
  assert.deepEqual(prev.stored.map((v) => v.buildId), ['0.1.0+bbb'])

  const cur = cat.remove('0.1.0+bbb')
  assert.equal(cur.current, null)
  assert.equal(cur.stored.length, 0)
  assert.equal(cat.employeeView().available, false)
  assert.equal(cat.downloadPath(), null)

  cat.saveArtifact({ buildId: '0.1.0+aaa', exePath: exeA, manifest: { version: '0.1.0', filename: 'Setup-A.exe' } })
  cat.saveArtifact({ buildId: '0.1.0+bbb', exePath: exeB, manifest: { version: '0.1.0', filename: 'Setup-B.exe' } })
  cat.publish('0.1.0+aaa')
  cat.publish('0.1.0+bbb')
  const fallback = cat.remove('0.1.0+bbb')
  assert.equal(fallback.current.buildId, '0.1.0+aaa')
  assert.equal(fallback.current.previous, null)
  assert.equal(cat.employeeView().available, true)

  assert.throws(() => cat.remove('0.1.0+missing'), /尚未入库/)
  assert.throws(() => cat.remove('../x'), /非法/)
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

test('applyPendingClientUpdate：安装版 hash 对则静默安装，并要求安装结束后重新打开', (t) => {
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
  assert.deepEqual(r.args, ['/S', '--updated'])
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].file, exe)
  assert.deepEqual(spawned[0].args, ['/S', '--updated'])
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

test('applyPendingClientUpdate：catalog buildId 填错但安装包就是当前版则清 pending 且不装', (t) => {
  const dir = tmp(t)
  const payloadDir = tmp(t)
  const exe = clientPendingPaths(dir).exe
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(exe, 'FAKE-SETUP-LOOP')
  const sha = hashFile(exe)
  writeClientPending(dir, {
    buildId: '0.1.1',
    sha256: sha,
    filename: 'valimart-harness-Setup-0.1.0-20260907.0658.exe',
  })
  fs.writeFileSync(
    path.join(payloadDir, 'payload.json'),
    JSON.stringify({
      buildId: '0.1.0+0.1.2-rc.1.20260907-0658.8d73e2ac',
      installerVersion: '0.1.0-20260907.0658',
    }),
  )
  const spawned = []
  const r = applyPendingClientUpdate({
    pendingDir: dir,
    payloadDir,
    packaged: true,
    hashFile,
    spawn: (...a) => {
      spawned.push(a)
    },
  })
  assert.equal(r.applied, false)
  assert.equal(r.reason, 'already-current')
  assert.equal(spawned.length, 0)
  assert.equal(readClientPending(dir), null)
})

test('fetchClientUpdate：同 installerVersion 不拉且清掉错 pending', async (t) => {
  const pendingDir = tmp(t)
  const payloadDir = tmp(t)
  fs.writeFileSync(
    path.join(payloadDir, 'payload.json'),
    JSON.stringify({
      buildId: '0.1.0+0.1.2-rc.1.20260907-0658.8d73e2ac',
      installerVersion: '0.1.0-20260907.0658',
    }),
  )
  fs.mkdirSync(pendingDir, { recursive: true })
  fs.writeFileSync(clientPendingPaths(pendingDir).exe, 'PENDING-SAME-INSTALLER')
  writeClientPending(pendingDir, {
    buildId: '0.1.1',
    sha256: '33'.repeat(32),
    filename: 'valimart-harness-Setup-0.1.0-20260907.0658.exe',
  })
  const gw = mockGateway({
    current: {
      available: true,
      buildId: '0.1.1',
      sha256: '33'.repeat(32),
      filename: 'valimart-harness-Setup-0.1.0-20260907.0658.exe',
    },
  })
  const r = await fetchClientUpdate({
    gateway: gw,
    pendingDir,
    localBuildId: '0.1.0+0.1.2-rc.1.20260907-0658.8d73e2ac',
    localInstallerVersion: '0.1.0-20260907.0658',
    payloadDir,
    log: () => {},
  })
  assert.equal(r.action, 'skip')
  assert.equal(r.detail, 'same-build')
  assert.equal(gw.calls.some((c) => c.p === '/api/client/download'), false)
  assert.equal(readClientPending(pendingDir), null)
})

test('发布 CLI 与 npm script 指向网关 /api/admin/client/publish', () => {
  const src = fs.readFileSync(path.join(repo, 'scripts', 'client', 'publish.mjs'), 'utf8')
  assert.match(src, /\/api\/admin\/client\/publish/)
  assert.match(src, /x-client-build-id/)
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['client:publish'], 'node scripts/client/publish.mjs')
})
