import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  parseReleaseTag, newerThan, filterDiscoverable, hashFile,
  pendingPaths, readPending, writePending, clearPending,
} from '../lib/kernel-update.mjs'
import { packPatchedPrefix } from '../lib/kernel-prepare.mjs'
import { ALL_MARKS, KernelPatchError } from '../kernel/patches.mjs'
import { locateKernel } from '../kernel/locate.mjs'
import { applyPendingKernel, findTar } from '../lib/bootstrap.mjs'

function writeBareKernel(prefix, version) {
  const root = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  fs.writeFileSync(path.join(root, 'lib', 'bin.js'), '')
}

/** 与 bootstrap.test pinSkillsRoot 假内核相同：每个补丁文件只写 mark，yml 放 v2 骨架。 */
function writeMarkedKernel(prefix, version) {
  writeBareKernel(prefix, version)
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

test('applyPendingKernel：ALL_MARKS 假内核 → applied，locateKernel 为 9.0.0', (t) => {
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
