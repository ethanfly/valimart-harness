import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { prepareWindowsNativeDependencies } from '../lib/kernel-native.mjs'
import { npmEnvironment, npmInvocation } from '../lib/npm-cli.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-native-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const kernelRoot = path.join(root, 'node_modules', '@deepseek-ai', 'dsh')
  const native = path.join(kernelRoot, 'node_modules', 'fs-ext')
  const session = path.join(kernelRoot, 'node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl')
  fs.mkdirSync(native, { recursive: true })
  fs.mkdirSync(path.join(session, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(kernelRoot, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.1.3-alpha.2"}')
  fs.writeFileSync(path.join(native, 'package.json'), JSON.stringify({ name: 'fs-ext', version: '2.1.1', main: 'index.cjs', scripts: { install: 'node -e "process.exit(99)"' } }))
  fs.writeFileSync(path.join(native, 'binding.gyp'), '{invalid: "must never compile on Windows"}')
  fs.writeFileSync(path.join(native, 'index.cjs'), 'throw new Error("fs-ext must not load on Windows"); exports.flock = null;')
  fs.writeFileSync(path.join(session, 'package.json'), '{"name":"@deepseek-ai/dsh-session-persistence-jsonl","version":"0.1.3-alpha.2","type":"module"}')
  const file = path.join(session, 'lib', 'index.js')
  fs.writeFileSync(file, 'import { flock } from "fs-ext";\nexport async function lock(path) {\nif (process.platform === "win32") { return await acquireLockHandleWin32(path); }\nreturn flock;\n}\nasync function acquireLockHandleWin32(path) { return "windows-lock:" + path; }\n')
  return { root, kernelRoot, native, file }
}

test('Windows native compatibility：旧内核和 POSIX 不修改安装树', (t) => {
  const f = fixture(t)
  const before = fs.readFileSync(f.file, 'utf8')
  assert.equal(prepareWindowsNativeDependencies({ kernelRoot: f.kernelRoot, platform: 'linux' }), false)
  assert.equal(fs.readFileSync(f.file, 'utf8'), before)
  assert.equal(prepareWindowsNativeDependencies({ kernelRoot: path.join(f.root, 'old'), platform: 'win32' }), false)
})

test('Windows native compatibility：未知版本或锁实现变化时停止，不跳过编译', (t) => {
  const f = fixture(t)
  fs.writeFileSync(f.file, 'import { flock } from "fs-ext";')
  assert.throws(() => prepareWindowsNativeDependencies({ kernelRoot: f.kernelRoot, platform: 'win32' }), /windows-session-lock-anchor/)
  const pkgFile = path.join(f.native, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  assert.ok(pkg.scripts.install)
  pkg.version = '3.0.0'
  fs.writeFileSync(pkgFile, JSON.stringify(pkg))
  assert.throws(() => prepareWindowsNativeDependencies({ kernelRoot: f.kernelRoot, platform: 'win32' }), /native-dependency-version/)
})

test('Windows npm rebuild：fs-ext 不编译/加载，其他依赖安装脚本仍执行，补丁幂等', { skip: process.platform !== 'win32' }, async (t) => {
  const f = fixture(t)
  const npm = npmInvocation()
  const other = path.join(f.kernelRoot, 'node_modules', 'other-native')
  fs.mkdirSync(other)
  fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'other-native', version: '1.0.0', scripts: { install: 'node install.cjs' } }))
  fs.writeFileSync(path.join(other, 'install.cjs'), 'require("node:fs").writeFileSync("installed", "yes")')
  prepareWindowsNativeDependencies({ kernelRoot: f.kernelRoot })
  const once = fs.readFileSync(f.file, 'utf8')
  prepareWindowsNativeDependencies({ kernelRoot: f.kernelRoot })
  assert.equal(fs.readFileSync(f.file, 'utf8'), once)
  const result = spawnSync(npm.cmd, [...npm.pre, 'rebuild', '-g', '--prefix', f.root, '--offline', '--ignore-scripts=false'], {
    env: { ...npmEnvironment(), npm_config_cache: path.join(f.root, 'cache') },
    shell: npm.shell, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  assert.equal(fs.readFileSync(path.join(other, 'installed'), 'utf8'), 'yes')
  const session = await import(pathToFileURL(f.file).href)
  assert.equal(await session.lock('test'), 'windows-lock:test')
})

// 显式指定已准备的真实内核，验证 native 模块和跨进程锁；普通离线测试不下载内核。
test('真实内核：Windows 跨进程锁互斥，释放后可重新获取', { skip: process.platform !== 'win32' || !process.env.DESK_NATIVE_TEST_KERNEL }, async (t) => {
  const kernelRoot = path.resolve(process.env.DESK_NATIVE_TEST_KERNEL)
  const source = path.join(kernelRoot, 'node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'index.js')
  const instrumented = path.join(path.dirname(source), `company-lock-test-${process.pid}.js`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-real-lock-'))
  fs.writeFileSync(instrumented, fs.readFileSync(source, 'utf8') + '\nexport { SessionWriteLease };\n')
  t.after(() => { fs.rmSync(instrumented, { force: true }); fs.rmSync(dir, { recursive: true, force: true }) })
  const url = pathToFileURL(instrumented).href
  const { SessionWriteLease } = await import(url)
  const lease = await SessionWriteLease.acquire(dir, 'test-session')
  try {
    const contender = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { SessionWriteLease } = await import(${JSON.stringify(url)});
      try { const lease = await SessionWriteLease.acquire(${JSON.stringify(dir)}, 'test-session'); await lease.release(); process.exit(10); }
      catch (error) { if (!/already.*owned/i.test(error.message)) throw error; console.log('lock-blocked'); }
    `], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    assert.equal(contender.status, 0, contender.stderr || contender.error?.message)
    assert.match(contender.stdout, /lock-blocked/)
  } finally {
    await lease.release()
  }
  const next = await SessionWriteLease.acquire(dir, 'test-session')
  await next.release()
})
