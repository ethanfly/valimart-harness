/**
 * 客户端版本：构建时打 installerVersion；本机 payload 读出来给 UI 展示。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeBuildId, makeInstallerVersion } from '../lib/payload.mjs'
import { clientPublicInfo, readLocalBuildId, readLocalPayload } from '../lib/client-update.mjs'
import { clientVersionDetail, clientVersionLabel, kernelVersionLabel } from '../../plugins/desk-ui/src/client/version.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('makeInstallerVersion：营销版本 + 构建时间戳，每次构建都变', () => {
  const v = makeInstallerVersion({ version: '0.1.0', now: new Date('2026-09-07T06:52:00Z') })
  assert.equal(v, '0.1.0-20260907.0652')
  const later = makeInstallerVersion({ version: '0.1.0', now: new Date('2026-09-07T07:01:00Z') })
  assert.equal(later, '0.1.0-20260907.0701')
  assert.notEqual(v, later)
})

test('makeBuildId 仍带内核与摘要，时间戳与 installerVersion 对齐', () => {
  const now = new Date('2026-09-07T06:52:00Z')
  const id = makeBuildId({ version: '0.1.0', kernelVersion: '0.1.2-rc.1', digest: 'abcd1234ffff', now })
  assert.equal(id, '0.1.0+0.1.2-rc.1.20260907-0652.abcd1234')
  assert.ok(id.includes('20260907-0652'))
})

test('readLocalPayload / clientPublicInfo：有 payload 读构建信息，没有则 dev', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-ver-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  assert.equal(readLocalPayload(dir), null)
  assert.deepEqual(clientPublicInfo(dir), { version: '0.1.0', buildId: 'dev', builtAt: null, kernelVersion: null, installerVersion: null })
  fs.writeFileSync(
    path.join(dir, 'payload.json'),
    JSON.stringify({
      buildId: '0.1.0+0.1.2-rc.1.20260907-0652.abcd1234',
      version: '0.1.0',
      installerVersion: '0.1.0-20260907.0652',
      builtAt: '2026-09-07T06:52:00.000Z',
      kernel: { version: '0.1.2-rc.1' },
    }),
  )
  const p = readLocalPayload(dir)
  assert.equal(p.buildId, '0.1.0+0.1.2-rc.1.20260907-0652.abcd1234')
  assert.equal(p.installerVersion, '0.1.0-20260907.0652')
  assert.equal(p.kernelVersion, '0.1.2-rc.1')
  assert.equal(readLocalBuildId(dir), p.buildId)
  assert.deepEqual(clientPublicInfo(dir), p)
})

test('clientVersionLabel：优先 installerVersion，悬停用完整 buildId', () => {
  assert.equal(clientVersionLabel(null), 'dev')
  assert.equal(clientVersionLabel({ version: '0.1.0' }), '0.1.0')
  assert.equal(clientVersionLabel({ installerVersion: '0.1.0-20260907.0652', version: '0.1.0' }), '0.1.0-20260907.0652')
  assert.equal(clientVersionDetail({ buildId: '0.1.0+k.20260907-0652.abcd1234', installerVersion: '0.1.0-20260907.0652' }), '0.1.0+k.20260907-0652.abcd1234')
})

test('构建脚本写入 installerVersion，安装包文件名跟它走', () => {
  const payload = fs.readFileSync(path.join(repo, 'scripts', 'build-payload.mjs'), 'utf8')
  const installer = fs.readFileSync(path.join(repo, 'scripts', 'build-client-installer.mjs'), 'utf8')
  assert.match(payload, /installerVersion = makeInstallerVersion/)
  assert.match(payload, /installerVersion,/)
  assert.match(installer, /installerVersion/)
  assert.match(installer, /extraMetadata\.version/)
  assert.match(installer, /VMBUILD/)
})

test('desk-host /state 带上 client 与实际内核版本；设置 / 登录 / 侧栏展示两个版本', () => {
  const host = fs.readFileSync(path.join(repo, 'plugins/desk-host/lib/index.js'), 'utf8')
  const settings = fs.readFileSync(path.join(repo, 'plugins/desk-ui/src/client/settings.jsx'), 'utf8')
  const login = fs.readFileSync(path.join(repo, 'plugins/desk-ui/src/client/login.jsx'), 'utf8')
  const sidebar = fs.readFileSync(path.join(repo, 'plugins/desk-ui/src/client/sidebar.jsx'), 'utf8')
  const version = fs.readFileSync(path.join(repo, 'plugins/desk-ui/src/client/version.js'), 'utf8')
  assert.match(host, /clientPublicInfo/)
  assert.match(host, /client:/)
  assert.match(host, /kernel:\s*\{\s*version:\s*readLocalKernelVersion\(\)\s*\}/)
  assert.match(settings, /客户端版本/)
  assert.match(settings, /内核/)
  assert.match(login, /clientVersionLabel/)
  assert.match(sidebar, /clientVersionLabel/)
  for (const f of [settings, login, sidebar]) assert.match(f, /kernelVersionLabel/)
  assert.match(version, /export function kernelVersionLabel/)
})

test('kernelVersionLabel：/state 的运行内核优先，退回 payload 构建内核，再退回 dev', () => {
  assert.equal(kernelVersionLabel(null), 'dev')
  assert.equal(kernelVersionLabel({ client: { kernelVersion: '0.1.2-rc.1' } }), '0.1.2-rc.1')
  assert.equal(kernelVersionLabel({ kernel: { version: '0.1.3-alpha.2' }, client: { kernelVersion: '0.1.2-rc.1' } }), '0.1.3-alpha.2')
})
