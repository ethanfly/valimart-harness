import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  parseReleaseTag, newerThan, filterDiscoverable, hashFile,
  pendingPaths, readPending, writePending, clearPending,
  annotateDiscoverWithNpm, fetchNpmVersions, resolveNpmRegistry,
} from '../lib/kernel-update.mjs'
import { fetchKernelUpdate } from '../../plugins/desk-host/lib/kernel-update.js'
import { packPatchedPrefix, formatNpmInstallError, prepareKernelTarball, removeUnpinnedProfilePlugins, kernelGlobalInstallArgs } from '../lib/kernel-prepare.mjs'
import { ALL_MARKS, KernelPatchError } from '../kernel/patches.mjs'
import { locateKernel, PIN, stampPath } from '../kernel/locate.mjs'
import { applyPendingKernel, findTar, preparePackaged } from '../lib/bootstrap.mjs'

test('kernel install args pin prerelease drift with --before', () => {
  const args = kernelGlobalInstallArgs({
    prefix: 'D:\\a\\kernel',
    spec: '@deepseek-ai/dsh@0.1.5-rc.2',
    windows: true,
    installBefore: '2026-09-22T05:00:00.000Z',
  })
  assert.equal(args.at(-2), '--before')
  assert.equal(args.at(-1), '2026-09-22T05:00:00.000Z')
  assert.ok(args.includes('--ignore-scripts'))
  assert.equal(kernelGlobalInstallArgs({ prefix: 'p', spec: 'a@1' }).includes('--before'), false)
})

function writeBareKernel(prefix, version) {
  const root = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  fs.writeFileSync(path.join(root, 'lib', 'bin.js'), '')
}

/** 与 bootstrap.test pinSkillsRoot 假内核相同：每个补丁文件只写 mark，yml 放 v2 骨架。 */
function writeMarkedKernel(prefix, version) {
  writeBareKernel(prefix, version)
  for (const { name } of PIN.profilePlugins ?? []) {
    const plugin = path.join(prefix, 'node_modules', name)
    fs.mkdirSync(path.join(plugin, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name }))
    fs.writeFileSync(path.join(plugin, 'lib', 'index.js'), '')
    fs.writeFileSync(path.join(plugin, 'cordis.patch.yml'), '')
  }
  const kernelRoot = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
  const buildSkills = 'C:/Users/builder/.dsh/desk/drive/_shared/skills'
  const preset = (withSkills) =>
    [
      ...(withSkills
        ? [
            '- id: skill-filesystem',
            "  name: '@deepseek-ai/dsh-skill-filesystem'",
            '  config:',
            '    includeDefaultRoots: false',
            '    watch: false',
            `    bundledSkillDir: '${buildSkills}'   # company-desk skills root`,
            '    customSkillDirs:',
            `      - '${buildSkills}'   # company-desk skills root`,
            '# --- company-preset-skills-v1 ---',
            '# --- company-preset-skills-v2 ---',
          ]
        : []),
      '- id: tool-web',
      "  name: '@deepseek-ai/dsh-tool-web'",
      '  config:',
      '    fetch: true',
      '    searchTimeoutMs: 60000',
      '    fetchTimeoutMs: 90000',
      '# --- company-preset-web-fetch-v2 ---',
      '# --- company-preset-instr-root-v1 ---',
      '',
    ].join('\n')
  for (const { file, marks } of ALL_MARKS) {
    const f = path.join(kernelRoot, file)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    if (file.endsWith('.yml')) fs.writeFileSync(f, preset(file.includes('standard')))
    else fs.appendFileSync(f, `// ${marks[0]}\n`)
  }
}

function packPrefixTar(prefix, tarPath) {
  const r = spawnSync(findTar(), ['-cf', tarPath, '-C', prefix, '.'], { encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, r.stderr || r.error?.message || 'tar')
}

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

test('formatNpmInstallError：带退出码和 stderr，不说检查网络', () => {
  const msg = formatNpmInstallError({
    status: 1,
    stdout: 'npm notice',
    stderr: 'npm ERR! 404 Not Found - GET https://registry.npmmirror.com/@deepseek-ai/dsh/0.1.3-alpha.1',
  })
  assert.match(msg, /退出码 1/)
  assert.match(msg, /404 Not Found/)
  assert.match(msg, /0\.1\.3-alpha\.1/)
  assert.equal(msg.includes('检查网络'), false)
})

test('formatNpmInstallError：只留输出尾部约 800 字', () => {
  const stderr = 'HEAD' + 'e'.repeat(900) + 'TAIL-404-not-found'
  const msg = formatNpmInstallError({ status: 1, stdout: '', stderr })
  assert.match(msg, /退出码 1/)
  assert.match(msg, /TAIL-404-not-found/)
  assert.equal(msg.includes('HEAD'), false)
  assert.ok(msg.length < 950)
})

test('annotateDiscoverWithNpm：按 npm versions 标记 onNpm', () => {
  const discover = [
    { tag: 'dsh-v0.1.3-alpha.1', version: '0.1.3-alpha.1', name: 'a', prerelease: true },
    { tag: 'dsh-v0.1.2-rc.1', version: '0.1.2-rc.1', name: 'b', prerelease: true },
  ]
  const out = annotateDiscoverWithNpm(discover, ['0.1.2-rc.1', '0.1.2-alpha.5'])
  assert.equal(out[0].onNpm, false)
  assert.equal(out[0].tag, 'dsh-v0.1.3-alpha.1')
  assert.equal(out[1].onNpm, true)
})

test('annotateDiscoverWithNpm：查询失败标 unknown，不谎称已核对', () => {
  const discover = [{ tag: 'dsh-v0.1.2-rc.1', version: '0.1.2-rc.1', name: 'b', prerelease: true }]
  const out = annotateDiscoverWithNpm(discover, null, { queryFailed: true })
  assert.equal(out[0].onNpm, null)
})

test('fetchNpmVersions：注入 fetch，读 packument versions', async () => {
  const calls = []
  const versions = await fetchNpmVersions({
    registry: 'https://registry.npmmirror.com',
    fetchImpl: async (url) => {
      calls.push(url)
      return { ok: true, json: async () => ({ versions: { '0.1.2-rc.1': {}, '0.1.2-alpha.5': {} } }) }
    },
  })
  assert.deepEqual(versions, ['0.1.2-rc.1', '0.1.2-alpha.5'])
  assert.equal(calls.length, 1)
  assert.match(calls[0], /@deepseek-ai%2Fdsh/)
  assert.match(calls[0], /^https:\/\/registry\.npmmirror\.com\//)
})

test('resolveNpmRegistry：调用方优先于环境变量，缺省 npmmirror', () => {
  const prev = process.env.npm_config_registry
  try {
    delete process.env.npm_config_registry
    assert.equal(resolveNpmRegistry(), 'https://registry.npmmirror.com')
    assert.equal(resolveNpmRegistry('https://registry.npmjs.org/'), 'https://registry.npmjs.org')
    process.env.npm_config_registry = 'https://example.com/npm/'
    assert.equal(resolveNpmRegistry(), 'https://example.com/npm')
    assert.equal(resolveNpmRegistry('https://custom.example/'), 'https://custom.example')
  } finally {
    if (prev === undefined) delete process.env.npm_config_registry
    else process.env.npm_config_registry = prev
  }
})

test('prepareKernelTarball：版本不在 npm 时提前失败，不调 installer', () => {
  let installed = false
  assert.throws(
    () =>
      prepareKernelTarball({
        version: '0.1.3-alpha.1',
        prefix: path.join(os.tmpdir(), 'diva-no-npm-prefix'),
        outDir: path.join(os.tmpdir(), 'diva-no-npm-out'),
        skillsDir: path.join(os.tmpdir(), 'diva-no-npm-skills'),
        installer: () => {
          installed = true
        },
        npmVersions: ['0.1.2-rc.1'],
      }),
    (err) =>
      err.code === 'not_on_npm' &&
      /GitHub 有 tag/.test(err.message) &&
      err.message.includes('@deepseek-ai/dsh@0.1.3-alpha.1'),
  )
  assert.equal(installed, false)
})

test('prepareKernelTarball：未提供 npmVersions 时不拦截', () => {
  let installed = false
  assert.throws(
    () =>
      prepareKernelTarball({
        version: '9.0.0',
        prefix: 'x',
        outDir: 'y',
        skillsDir: 'z',
        installer: () => {
          installed = true
          throw new Error('stop-before-pack')
        },
      }),
    (err) => err.message === 'stop-before-pack',
  )
  assert.equal(installed, true)
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

test('packPatchedPrefix：假 prefix 缺补丁文件 → KernelPatchError，不写 outDir/<ver>', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-kprep-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const prefix = path.join(dir, 'prefix')
  const outDir = path.join(dir, 'out')
  const skillsDir = path.join(dir, 'skills')
  const root = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.0.0' }))
  fs.writeFileSync(path.join(root, 'lib', 'bin.js'), '')
  assert.throws(
    () => packPatchedPrefix({ prefix, version: '9.0.0', outDir, skillsDir, log: () => {} }),
    (err) => err instanceof KernelPatchError && err.code === 'target-missing',
  )
  assert.equal(fs.existsSync(path.join(outDir, '9.0.0')), false)
})

test('update.mjs：无子命令退出 64', () => {
  const cli = fileURLToPath(new URL('../kernel/update.mjs', import.meta.url))
  const r = spawnSync(process.execPath, [cli], { encoding: 'utf8' })
  assert.equal(r.status, 64)
})

test('applyPendingKernel：hash 不对 → 不切换，清理 pending', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-apk-hash-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const targetPrefix = path.join(dir, 'kernel')
  const pendingDir = path.join(dir, 'kernel-next')
  const skillsDir = path.join(dir, 'skills')
  writeBareKernel(targetPrefix, '1.0.0')
  const src = path.join(dir, 'src')
  writeBareKernel(src, '9.0.0')
  const tarPath = path.join(dir, 'k.tar')
  packPrefixTar(src, tarPath)
  fs.mkdirSync(pendingDir, { recursive: true })
  fs.copyFileSync(tarPath, pendingPaths(pendingDir).tar)
  writePending(pendingDir, { version: '9.0.0', sha256: '0'.repeat(64) })
  const r = applyPendingKernel({ pendingDir, targetPrefix, skillsDir, log: () => {} })
  assert.equal(r.applied, false)
  assert.equal(r.detail, 'hash-mismatch')
  assert.equal(locateKernel(targetPrefix).version, '1.0.0')
  assert.equal(readPending(pendingDir), null)
})

test('applyPendingKernel：缺补丁 → 不切换，保留旧 prefix', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-apk-patch-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const targetPrefix = path.join(dir, 'kernel')
  const pendingDir = path.join(dir, 'kernel-next')
  const skillsDir = path.join(dir, 'skills')
  writeBareKernel(targetPrefix, '1.0.0')
  const src = path.join(dir, 'src')
  writeBareKernel(src, '9.0.0')
  const tarPath = path.join(dir, 'k.tar')
  packPrefixTar(src, tarPath)
  fs.mkdirSync(pendingDir, { recursive: true })
  fs.copyFileSync(tarPath, pendingPaths(pendingDir).tar)
  writePending(pendingDir, { version: '9.0.0', sha256: hashFile(tarPath) })
  const r = applyPendingKernel({ pendingDir, targetPrefix, skillsDir, log: () => {} })
  assert.equal(r.applied, false)
  assert.equal(locateKernel(targetPrefix).version, '1.0.0')
  assert.equal(fs.existsSync(path.join(targetPrefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')), true)
  assert.equal(readPending(pendingDir), null)
  assert.equal(fs.existsSync(targetPrefix + '-staging'), false)
})

test('applyPendingKernel：ALL_MARKS 和必需插件齐全 → applied，locateKernel 为 9.0.0', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-apk-ok-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const targetPrefix = path.join(dir, 'kernel')
  const pendingDir = path.join(dir, 'kernel-next')
  const skillsDir = path.join(dir, 'skills')
  writeBareKernel(targetPrefix, '1.0.0')
  const src = path.join(dir, 'src')
  writeMarkedKernel(src, '9.0.0')
  const tarPath = path.join(dir, 'k.tar')
  packPrefixTar(src, tarPath)
  fs.mkdirSync(pendingDir, { recursive: true })
  fs.copyFileSync(tarPath, pendingPaths(pendingDir).tar)
  writePending(pendingDir, { version: '9.0.0', sha256: hashFile(tarPath) })
  const r = applyPendingKernel({ pendingDir, targetPrefix, skillsDir, log: () => {} })
  assert.equal(r.applied, true)
  assert.equal(r.version, '9.0.0')
  assert.equal(r.detail, 'ok')
  assert.equal(locateKernel(targetPrefix).version, '9.0.0')
  assert.equal(readPending(pendingDir), null)
})

test('preparePackaged：fresh 解压后 pending 覆盖 bundled，locateKernel 为 pending 版本', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-apk-fresh-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const payloadDir = path.join(dir, 'payload')
  const appDir = path.join(dir, 'app')
  const dshHome = path.join(dir, 'dsh')
  const bundled = path.join(dir, 'bundled')
  writeMarkedKernel(bundled, '1.0.0')
  fs.mkdirSync(payloadDir, { recursive: true })
  packPrefixTar(bundled, path.join(payloadDir, 'kernel.tar'))
  fs.writeFileSync(path.join(payloadDir, 'payload.json'), JSON.stringify({ buildId: 'test-build', kernel: { version: '1.0.0' } }))
  for (const d of ['plugins/desk-host', 'plugins/desk-ui', 'plugins/desk-image', 'profile', 'scripts']) fs.mkdirSync(path.join(payloadDir, d), { recursive: true })
  fs.writeFileSync(path.join(payloadDir, 'profile', 'cordis.patch.yml'), "gatewayUrl: 'http://x:1'\n")
  const src = path.join(dir, 'pending-src')
  writeMarkedKernel(src, '9.0.0')
  const pendingDir = path.join(appDir, 'kernel-next')
  fs.mkdirSync(pendingDir, { recursive: true })
  packPrefixTar(src, pendingPaths(pendingDir).tar)
  writePending(pendingDir, { version: '9.0.0', sha256: hashFile(pendingPaths(pendingDir).tar) })
  fs.mkdirSync(path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai'), { recursive: true })
  const res = preparePackaged({ payloadDir, appDir, dshHome, log: () => {} })
  assert.equal(locateKernel(path.join(appDir, 'kernel')).version, '9.0.0')
  assert.equal(res.kernelVersion, '9.0.0')
  assert.equal(readPending(pendingDir), null)
  assert.ok(fs.existsSync(path.join(appDir, 'plugins', 'desk-ui')))
  assert.equal(JSON.parse(fs.readFileSync(path.join(appDir, 'state.json'), 'utf8')).buildId, 'test-build')
})

test('更新包有全部补丁但遗漏面板插件：拒绝打包和切换，旧内核仍可用', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-kernel-bundles-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const targetPrefix = path.join(dir, 'kernel')
  const src = path.join(dir, 'src')
  const pendingDir = path.join(dir, 'kernel-next')
  const skillsDir = path.join(dir, 'skills')
  writeMarkedKernel(targetPrefix, '1.0.0')
  writeMarkedKernel(src, '9.0.0')
  const required = PIN.profilePlugins[0].name
  const requiredRe = new RegExp('缺少必需插件.*' + required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  fs.rmSync(path.join(src, 'node_modules', required), { recursive: true })
  assert.throws(() => packPatchedPrefix({ prefix: src, version: '9.0.0', outDir: path.join(dir, 'out'), skillsDir }), requiredRe)
  fs.mkdirSync(pendingDir)
  packPrefixTar(src, pendingPaths(pendingDir).tar)
  writePending(pendingDir, { version: '9.0.0', sha256: hashFile(pendingPaths(pendingDir).tar) })
  const result = applyPendingKernel({ pendingDir, targetPrefix, skillsDir })
  assert.equal(result.applied, false)
  assert.match(result.detail, requiredRe)
  assert.equal(locateKernel(targetPrefix).version, '1.0.0')
  assert.ok(fs.existsSync(path.join(targetPrefix, 'node_modules', required, 'lib', 'index.js')))
  assert.equal(readPending(pendingDir), null)
})

test('removeUnpinnedProfilePlugins：卸掉 stamp 里已不在 pin 的插件', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-unpin-plugin-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  writeBareKernel(dir, '9.0.0')
  const leftover = path.join(dir, 'node_modules', 'dsh-better-sidebar')
  fs.mkdirSync(path.join(leftover, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(leftover, 'package.json'), '{"name":"dsh-better-sidebar"}\n')
  const keptName = PIN.profilePlugins[0].name
  const kept = path.join(dir, 'node_modules', keptName)
  fs.mkdirSync(path.join(kept, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(kept, 'package.json'), JSON.stringify({ name: keptName }) + '\n')
  fs.writeFileSync(stampPath(dir), JSON.stringify({
    profilePlugins: ['dsh-better-sidebar@0.18.0', `${keptName}@9.9.9`],
  }) + '\n')
  const removed = removeUnpinnedProfilePlugins({ prefix: dir, log: () => {} })
  assert.deepEqual(removed, ['dsh-better-sidebar'])
  assert.equal(fs.existsSync(leftover), false)
  assert.ok(fs.existsSync(path.join(kept, 'package.json')))
})

function shaOf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function mockGateway({ current, tarball, failCurrent, failTarball }) {
  const calls = []
  return {
    calls,
    async get(p, o) {
      calls.push({ fn: 'get', p, o })
      if (p === '/api/kernel/current') {
        if (failCurrent) throw failCurrent
        return current
      }
      throw new Error(`unexpected get ${p}`)
    },
    async request(method, p, o) {
      calls.push({ fn: 'request', method, p, o })
      if (p === '/api/kernel/tarball') {
        if (failTarball) throw failTarball
        return tarball
      }
      throw new Error(`unexpected request ${p}`)
    },
  }
}

function hostTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-host-kup-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('fetchKernelUpdate：bundled → skip，不拉 tarball', async (t) => {
  const pendingDir = hostTmp(t)
  const gw = mockGateway({ current: { bundled: true, version: '0.1.1', sha256: null, tarball: false } })
  const r = await fetchKernelUpdate({ gateway: gw, pendingDir, localVersion: '0.1.0', log: () => {} })
  assert.equal(r.action, 'skip')
  assert.equal(gw.calls.some((c) => c.p === '/api/kernel/tarball'), false)
})

test('fetchKernelUpdate：version 等于本地 → skip', async (t) => {
  const pendingDir = hostTmp(t)
  const gw = mockGateway({ current: { bundled: false, version: '1.2.3', sha256: 'ab'.repeat(32), tarball: true } })
  const r = await fetchKernelUpdate({ gateway: gw, pendingDir, localVersion: '1.2.3', log: () => {} })
  assert.equal(r.action, 'skip')
  assert.equal(gw.calls.some((c) => c.p === '/api/kernel/tarball'), false)
})

test('fetchKernelUpdate：无 sha256 → skip', async (t) => {
  const pendingDir = hostTmp(t)
  const gw = mockGateway({ current: { bundled: false, version: '9.0.0', sha256: null, tarball: true } })
  const r = await fetchKernelUpdate({ gateway: gw, pendingDir, localVersion: '1.0.0', log: () => {} })
  assert.equal(r.action, 'skip')
  assert.equal(gw.calls.some((c) => c.p === '/api/kernel/tarball'), false)
})

test('fetchKernelUpdate：已有 pending 且 tar 就位、sha 相同 → skip', async (t) => {
  const pendingDir = hostTmp(t)
  const sha = 'cd'.repeat(32)
  writePending(pendingDir, { version: '9.0.0', sha256: sha })
  // 生产里 pending 与 tar 是一起落盘的：tar 在才算“已下载就绪”，才允许短路 skip
  fs.writeFileSync(pendingPaths(pendingDir).tar, 'already-downloaded-kernel.tar')
  const gw = mockGateway({ current: { bundled: false, version: '9.0.0', sha256: sha, tarball: true } })
  const r = await fetchKernelUpdate({ gateway: gw, pendingDir, localVersion: '1.0.0', log: () => {} })
  assert.equal(r.action, 'skip')
  assert.equal(gw.calls.some((c) => c.p === '/api/kernel/tarball'), false)
  assert.equal(readPending(pendingDir).sha256, sha)
})

test('fetchKernelUpdate：pending 记录在但 tar 丢失 → 清记录重新下载（不再假 skip）', async (t) => {
  const pendingDir = hostTmp(t)
  const sha = 'cd'.repeat(32)
  writePending(pendingDir, { version: '9.0.0', sha256: sha })
  const gw = mockGateway({ current: { bundled: false, version: '9.0.0', sha256: sha, tarball: true } })
  const r = await fetchKernelUpdate({ gateway: gw, pendingDir, localVersion: '1.0.0', log: () => {} })
  // 它真的尝试重新下载了（不再短路成 already-pending）；mock tar 与 sha 不符 → 清 pending 报错
  assert.equal(gw.calls.some((c) => c.p === '/api/kernel/tarball'), true)
  assert.equal(readPending(pendingDir), null)
  assert.notEqual(r.action, 'skip')
})

test('fetchKernelUpdate：pending sha 与 current 不符且本地已是 current → cleared', async (t) => {
  const pendingDir = hostTmp(t)
  writePending(pendingDir, { version: '9.0.0', sha256: 'aa'.repeat(32) })
  const gw = mockGateway({ current: { bundled: false, version: '1.0.0', sha256: 'bb'.repeat(32), tarball: true } })
  const r = await fetchKernelUpdate({ gateway: gw, pendingDir, localVersion: '1.0.0', log: () => {} })
  assert.equal(r.action, 'cleared')
  assert.equal(readPending(pendingDir), null)
  assert.equal(fs.existsSync(pendingDir), false)
  assert.equal(gw.calls.some((c) => c.p === '/api/kernel/tarball'), false)
})

test('fetchKernelUpdate：下载成功 → .partial 改名、writePending，timeout 10 分钟', async (t) => {
  const pendingDir = hostTmp(t)
  const tarball = Buffer.from('FAKE-KERNEL-TAR')
  const sha = shaOf(tarball)
  const gw = mockGateway({
    current: { bundled: false, version: '9.0.0', sha256: sha, tarball: true },
    tarball,
  })
  const r = await fetchKernelUpdate({ gateway: gw, pendingDir, localVersion: '1.0.0', log: () => {} })
  assert.equal(r.action, 'downloaded')
  const tarCall = gw.calls.find((c) => c.p === '/api/kernel/tarball')
  assert.ok(tarCall)
  assert.equal(tarCall.o?.timeoutMs, 600_000)
  assert.equal(fs.existsSync(pendingPaths(pendingDir).partial), false)
  assert.equal(fs.readFileSync(pendingPaths(pendingDir).tar).equals(tarball), true)
  const p = readPending(pendingDir)
  assert.equal(p.version, '9.0.0')
  assert.equal(p.sha256, sha)
})

test('fetchKernelUpdate：pending 过期后改拉新 tar', async (t) => {
  const pendingDir = hostTmp(t)
  writePending(pendingDir, { version: '8.0.0', sha256: '11'.repeat(32) })
  fs.writeFileSync(pendingPaths(pendingDir).tar, 'OLD')
  const tarball = Buffer.from('NEW-KERNEL-TAR')
  const sha = shaOf(tarball)
  const gw = mockGateway({
    current: { bundled: false, version: '9.0.0', sha256: sha, tarball: true },
    tarball,
  })
  const r = await fetchKernelUpdate({ gateway: gw, pendingDir, localVersion: '1.0.0', log: () => {} })
  assert.equal(r.action, 'downloaded')
  assert.equal(readPending(pendingDir).version, '9.0.0')
  assert.equal(fs.readFileSync(pendingPaths(pendingDir).tar, 'utf8'), 'NEW-KERNEL-TAR')
})

test('fetchKernelUpdate：tarball hash 不对 → clearPending，action error', async (t) => {
  const pendingDir = hostTmp(t)
  const logs = []
  const gw = mockGateway({
    current: { bundled: false, version: '9.0.0', sha256: '00'.repeat(32), tarball: true },
    tarball: Buffer.from('WRONG-BYTES'),
  })
  const r = await fetchKernelUpdate({ gateway: gw, pendingDir, localVersion: '1.0.0', log: (m) => logs.push(m) })
  assert.equal(r.action, 'error')
  assert.equal(readPending(pendingDir), null)
  assert.equal(fs.existsSync(pendingDir), false)
  assert.ok(logs.length)
})

test('fetchKernelUpdate：网关失败 → error，不抛', async (t) => {
  const pendingDir = hostTmp(t)
  const gw = mockGateway({ failCurrent: new Error('unreachable') })
  const r = await fetchKernelUpdate({ gateway: gw, pendingDir, localVersion: '1.0.0', log: () => {} })
  assert.equal(r.action, 'error')
  assert.match(r.detail, /unreachable/)
})
