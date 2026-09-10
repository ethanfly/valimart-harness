import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { prepareWindowsNativeDependencies, prepareSessionLockDependency, flockFlagsToOperation, SESSION_LOCK_MARK } from '../lib/kernel-native.mjs'
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

test('会话锁 v2：v1 → koffi 兜底、幂等、语法可加载', (t) => {
  const f = fixture(t)
  // 手工造 v1 状态（真实内核前缀就是这一步的产物）
  fs.writeFileSync(
    f.file,
    'import { createRequire as companyCreateRequire } from "node:module";\n' +
      '// company-session-posix-flock-v1: Windows uses the upstream koffi semaphore.\n' +
      'const flock = process.platform === "win32" ? undefined : companyCreateRequire(import.meta.url)("fs-ext").flock;\n',
  )
  const v1 = fs.readFileSync(f.file, 'utf8')
  assert.ok(v1.includes('company-session-posix-flock-v1'))
  assert.equal(prepareSessionLockDependency({ kernelRoot: f.kernelRoot }), true)
  const v2 = fs.readFileSync(f.file, 'utf8')
  assert.ok(v2.includes(SESSION_LOCK_MARK))
  assert.ok(v2.includes('companyPosixFlock'))
  assert.ok(v2.includes('koffi.load'))
  assert.ok(!v2.includes('company-session-posix-flock-v1'))
  // createRequire 只声明一次
  assert.equal(v2.split('import { createRequire as companyCreateRequire } from "node:module";').length, 2)
  // 幂等
  assert.equal(prepareSessionLockDependency({ kernelRoot: f.kernelRoot }), false)
  assert.equal(fs.readFileSync(f.file, 'utf8'), v2)
  // 语法
  const check = spawnSync(process.execPath, ['--check', f.file], { encoding: 'utf8', windowsHide: true })
  assert.equal(check.status, 0, check.stderr)
})

test('会话锁 v2：上游 import 直接升级；锚点变了就停手', (t) => {
  const f = fixture(t)
  fs.writeFileSync(f.file, 'import { flock } from "fs-ext";\nif (process.platform === "win32") { await acquireLockHandleWin32(path); }\n')
  assert.equal(prepareSessionLockDependency({ kernelRoot: f.kernelRoot }), true)
  const out = fs.readFileSync(f.file, 'utf8')
  assert.ok(out.includes('import { createRequire as companyCreateRequire } from "node:module";'))
  assert.ok(out.includes(SESSION_LOCK_MARK))
  assert.ok(!out.includes('import { flock } from "fs-ext";'))

  const g = fixture(t)
  fs.writeFileSync(g.file, 'import { flock } from "fs-ext";\n') // 没有 Windows 锚点
  assert.throws(() => prepareSessionLockDependency({ kernelRoot: g.kernelRoot }), /windows-session-lock-anchor/)
  const h = fixture(t)
  fs.writeFileSync(h.file, 'export const nothing = 1;\n')
  assert.throws(() => prepareSessionLockDependency({ kernelRoot: h.kernelRoot }), /session-lock-anchor/)

  const addon = fixture(t)
  fs.writeFileSync(
    addon.file,
    'import { tryLockExclusive } from "@deepseek-ai/node-addon-system/flock";\nif (process.platform === "win32") { await acquireLockHandleWin32(path); }\n',
  )
  const before = fs.readFileSync(addon.file, 'utf8')
  assert.equal(prepareSessionLockDependency({ kernelRoot: addon.kernelRoot }), false)
  assert.equal(fs.readFileSync(addon.file, 'utf8'), before)
})

test('flock 标志串：exnb → LOCK_EX|LOCK_NB', () => {
  assert.equal(flockFlagsToOperation('exnb'), 6)
  assert.equal(flockFlagsToOperation('ex'), 2)
  assert.equal(flockFlagsToOperation('shnb'), 5)
  assert.equal(flockFlagsToOperation('un'), 8)
})

test('会话锁 v2：koffi 兜底真的调 flock(2)，竞争返回 EAGAIN', async (t) => {
  const f = fixture(t)
  // 假的 koffi：记录调用，可控返回值与 errno
  const koffiDir = path.join(f.kernelRoot, 'node_modules', 'koffi')
  fs.mkdirSync(koffiDir, { recursive: true })
  fs.writeFileSync(path.join(koffiDir, 'package.json'), JSON.stringify({ name: 'koffi', version: '3.2.1', main: 'index.js' }))
  fs.writeFileSync(
    path.join(koffiDir, 'index.js'),
    `const state = { result: 0, errno: 0, calls: [] };
module.exports = {
  load: (p) => { state.calls.push(['load', p]); return { func: (def) => { state.calls.push(['func', def]); return (fd, op) => { state.calls.push(['flock', fd, op]); return state.result; }; } }; },
  errno: () => state.errno,
  __state: state,
};
`,
  )
  prepareSessionLockDependency({ kernelRoot: f.kernelRoot })
  fs.appendFileSync(f.file, '\nexport { flock };\n')
  const koffi = (await import(pathToFileURL(path.join(koffiDir, 'index.js')).href)).default
  const before = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  try {
    const mod = await import(`${pathToFileURL(f.file).href}?t=${Date.now()}`)
    assert.equal(typeof mod.flock, 'function')
    assert.equal(koffi.__state.calls[0][0], 'load')
    // 成功：LOCK_EX|LOCK_NB = 6
    await new Promise((resolve, reject) => mod.flock(7, 'exnb', (err) => (err ? reject(err) : resolve())))
    assert.deepEqual(koffi.__state.calls.at(-1), ['flock', 7, 6])
    // 竞争：flock 返回 -1、errno=35（macOS EAGAIN）→ error.code 必须是 EAGAIN
    koffi.__state.result = -1
    koffi.__state.errno = 35
    const err = await new Promise((resolve) => mod.flock(7, 'exnb', resolve))
    assert.equal(err.code, 'EAGAIN')
    assert.equal(err.errno, 35)
    // 内核里 0.1.3 的 fs-ext 只传 "exnb"，不会用阻塞模式
    assert.equal(flockFlagsToOperation('exnb') & 4, 4)
  } finally {
    Object.defineProperty(process, 'platform', before)
  }
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
