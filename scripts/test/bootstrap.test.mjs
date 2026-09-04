import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { ensureProfile, findFreePort, profileNeedsSetup, readGatewayUrl } from '../lib/bootstrap.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'diva-bootstrap-'))

test('findFreePort：首选端口被占就顺延', async () => {
  const srv = net.createServer()
  await new Promise((r) => srv.listen({ port: 0, host: '127.0.0.1' }, r))
  const busy = srv.address().port
  try {
    const p = await findFreePort(busy, 5)
    assert.notEqual(p, busy)
    assert.ok(p > busy && p < busy + 5, `期望 ${busy + 1}..${busy + 4}，得到 ${p}`)
  } finally {
    srv.close()
  }
})

test('findFreePort：首选端口空闲就用它', async () => {
  const srv = net.createServer()
  await new Promise((r) => srv.listen({ port: 0, host: '127.0.0.1' }, r))
  const free = srv.address().port
  await new Promise((r) => srv.close(r))
  assert.equal(await findFreePort(free, 3), free)
})

test('readGatewayUrl：从 cordis.patch.yml 里读 gatewayUrl 并去尾斜杠', () => {
  const dir = tmp()
  const f = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(f, "- insert:\n    - id: desk-host\n      config:\n        gatewayUrl: 'http://gw.local:8790/'\n")
  assert.equal(readGatewayUrl(f), 'http://gw.local:8790')
  fs.writeFileSync(f, '- id: x\n')
  assert.equal(readGatewayUrl(f, 'http://fallback:1'), 'http://fallback:1')
})

test('profileNeedsSetup：缺文件 / 补丁内容变了都要重装', () => {
  const dir = tmp()
  const patchFile = path.join(dir, 'repo.patch.yml')
  fs.writeFileSync(patchFile, 'a: 1\n')
  const profileDir = path.join(dir, 'profile')
  assert.equal(profileNeedsSetup({ profileDir, patchFile }), true)
  fs.mkdirSync(path.join(profileDir, 'node_modules', '@company-desk', 'desk-ui'), { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), 'a: 1\n')
  assert.equal(profileNeedsSetup({ profileDir, patchFile }), false)
  fs.writeFileSync(patchFile, 'a: 2\n')
  assert.equal(profileNeedsSetup({ profileDir, patchFile }), true)
})

test('ensureProfile：写 manifest、链接插件与 dsh 回退目录（selfHeal=false）', () => {
  const dir = tmp()
  const dshHome = path.join(dir, 'dsh')
  const flat = path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
  fs.mkdirSync(flat, { recursive: true })
  const root = path.join(dir, 'root')
  const pluginsDir = path.join(root, 'plugins')
  for (const p of ['desk-host', 'desk-ui']) fs.mkdirSync(path.join(pluginsDir, p), { recursive: true })
  const patchFile = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(patchFile, "gatewayUrl: 'http://x:1'\n")
  const logs = []
  const { profileDir, flatDir } = ensureProfile({ profileName: 'desk-test', dshHome, root, pluginsDir, patchFile, kernel: { bin: 'unused' }, selfHeal: false, log: (m) => logs.push(m) })
  assert.equal(profileDir, path.join(dshHome, 'profiles', 'desk-test'))
  assert.equal(flatDir, flat)
  const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-profile-desk-test')
  assert.match(manifest.dependencies['@company-desk/desk-host'], /^file:.*plugins\/desk-host$/)
  assert.equal(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), "gatewayUrl: 'http://x:1'\n")
  assert.ok(fs.lstatSync(path.join(profileDir, 'node_modules', '@company-desk', 'desk-ui')).isSymbolicLink())
  assert.ok(fs.lstatSync(path.join(root, 'node_modules', '@deepseek-ai')).isSymbolicLink())
  assert.ok(fs.existsSync(path.join(dshHome, 'desk')))
  // 再跑一次：链接保持
  ensureProfile({ profileName: 'desk-test', dshHome, root, pluginsDir, patchFile, kernel: { bin: 'unused' }, selfHeal: false, log: (m) => logs.push(m) })
  assert.ok(logs.some((l) => /desk-ui kept/.test(l)))
})
