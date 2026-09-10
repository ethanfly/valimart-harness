/**
 * 会话写锁的跨平台原生依赖处理。
 *
 * 上游 dsh 0.1.3 的 POSIX 会话锁用 `fs-ext`（NAN 原生模块，装的时候要 node-gyp 现场编译），
 * Windows 走 koffi 命名信号量。
 *   - v1（company-session-posix-flock-v1）：只让 POSIX 加载 fs-ext，Windows 不编译它。
 *   - v2（company-session-lock-v2）：POSIX 优先用编译好的 fs-ext，**没有就用 koffi 直接绑 flock(2)**。
 *     必须这么做：macOS 客户端是在 Windows 构建机上打的包，编不出 darwin 的 fs_ext.node；
 *     而 fs-ext 用 NAN（ABI 绑定），也找不到能用的预编译产物。koffi 是 NAPI，我们本来就随包带了 darwin-x64。
 *
 * 语义与上游保持一致：非阻塞 `flock(fd, LOCK_EX|LOCK_NB)`，竞争时回调的 error.code 必须是
 * EAGAIN / EWOULDBLOCK（上游据此抛 SessionAlreadyOwnedError），释放靠关闭 fd（flock 随 fd 释放）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { KernelPatchError } from '../kernel/patches.mjs'

/** v1 标记：只让 POSIX 加载 fs-ext（Windows 跳过编译）。 */
export const WINDOWS_FLOCK_MARK = 'company-session-posix-flock-v1'
/** v2 标记：POSIX 在 fs-ext 缺失时用 koffi 绑 flock(2)。 */
export const SESSION_LOCK_MARK = 'company-session-lock-v2'

const V1_LINE = 'const flock = process.platform === "win32" ? undefined : companyCreateRequire(import.meta.url)("fs-ext").flock;'
const UPSTREAM_IMPORT = 'import { flock } from "fs-ext";'
const REQUIRE_IMPORT = 'import { createRequire as companyCreateRequire } from "node:module";'
/** 上游 Windows 信号量锁的锚点：文件被改过就停下来，别盲改。 */
const WINDOWS_ANCHORS = ['if (process.platform === "win32") {', 'await acquireLockHandleWin32(path)']

/** 注入到内核里的自足实现（不引用仓库任何东西）。 */
const FLOCK_IMPL = [
  `// ${SESSION_LOCK_MARK}: Windows keeps the upstream koffi semaphore; POSIX prefers the compiled`,
  '// fs-ext addon and falls back to a koffi flock(2) binding when it is missing — a macOS client',
  '// packaged on a Windows build machine cannot compile fs-ext, and fs-ext is NAN/ABI-bound.',
  'function companyPosixFlock() {',
  '  if (process.platform === "win32") return undefined;',
  '  const require_ = companyCreateRequire(import.meta.url);',
  '  try {',
  '    const native = require_("fs-ext").flock;',
  '    if (typeof native === "function") return native;',
  '  } catch {',
  '    /* fs-ext 没编译出来：走 koffi 兜底 */',
  '  }',
  '  const koffi = require_("koffi");',
  '  const candidates = process.platform === "darwin"',
  '    ? [null, "/usr/lib/libSystem.B.dylib"]',
  '    : [null, "libc.so.6", "libc.so"];',
  '  let lib;',
  '  let lastError;',
  '  for (const candidate of candidates) {',
  '    try {',
  '      lib = koffi.load(candidate);',
  '      break;',
  '    } catch (error) {',
  '      lastError = error;',
  '    }',
  '  }',
  '  if (!lib) throw lastError ?? new Error("companyPosixFlock: cannot load libc for flock");',
  '  const nativeFlock = lib.func("int flock(int fd, int operation)");',
  '  const LOCK_SH = 1;',
  '  const LOCK_EX = 2;',
  '  const LOCK_NB = 4;',
  '  const LOCK_UN = 8;',
  '  return function flock(fd, flags, callback) {',
  '    const text = String(flags);',
  '    let operation = 0;',
  '    if (text.includes("sh")) operation |= LOCK_SH;',
  '    if (text.includes("ex")) operation |= LOCK_EX;',
  '    if (text.includes("nb")) operation |= LOCK_NB;',
  '    if (text.includes("un")) operation |= LOCK_UN;',
  '    try {',
  '      if (nativeFlock(fd, operation) === 0) return void callback(null);',
  '      const errno = koffi.errno();',
  '      const error = new Error("flock(" + fd + ", " + text + ") failed: errno " + errno);',
  '      error.errno = errno;',
  '      error.code = errno === 11 || errno === 35 ? "EAGAIN" : "ERRNO_" + errno;',
  '      return void callback(error);',
  '    } catch (error) {',
  '      return void callback(error);',
  '    }',
  '  };',
  '}',
  'const flock = companyPosixFlock();',
].join('\n')

export const sessionLockFile = (kernelRoot) => path.join(kernelRoot, 'node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'index.js')

/** fs-ext 的 flock 标志串（上游只传 "exnb"；这里按 fs-ext 的约定解析，保持等价）。 */
export function flockFlagsToOperation(flags) {
  const text = String(flags)
  let operation = 0
  if (text.includes('sh')) operation |= 1
  if (text.includes('ex')) operation |= 2
  if (text.includes('nb')) operation |= 4
  if (text.includes('un')) operation |= 8
  return operation
}

/**
 * 把会话锁的原生实现升级到 v2（幂等）。任何平台都能调用：
 * Windows 装内核时用（顺手把 v1 升上来），打 mac 包时也用（源前缀可能还是 v1）。
 * @returns {boolean} 是否改动了文件
 */
export function prepareSessionLockDependency({ kernelRoot, log = () => {} }) {
  const file = sessionLockFile(kernelRoot)
  if (!fs.existsSync(file)) return false
  const source = fs.readFileSync(file, 'utf8')
  if (source.includes(SESSION_LOCK_MARK)) return false

  let next
  if (source.includes(V1_LINE)) {
    // v1 → v2：companyCreateRequire 已经在文件里了；顺手删掉 v1 的说明行（兼容 CRLF）
    next = source.replace(V1_LINE, () => FLOCK_IMPL)
    next = next.split(/\r?\n/).filter((line) => !line.includes(WINDOWS_FLOCK_MARK)).join('\n')
  } else if (source.includes(UPSTREAM_IMPORT)) {
    for (const anchor of WINDOWS_ANCHORS) {
      if (!source.includes(anchor)) throw new KernelPatchError('windows-session-lock-anchor', file)
    }
    next = source.replace(UPSTREAM_IMPORT, () => `${REQUIRE_IMPORT}\n${FLOCK_IMPL}`)
  } else {
    throw new KernelPatchError('session-lock-anchor', file)
  }
  fs.writeFileSync(file, next)
  log(`会话锁补丁 → ${SESSION_LOCK_MARK}（POSIX 缺 fs-ext 时用 koffi flock）`)
  return true
}

/** Windows 安装内核用：v2 补丁 + 不让 npm 编译没用到的 fs-ext。 */
export function prepareWindowsNativeDependencies({ kernelRoot, platform = process.platform, log = () => {} }) {
  if (platform !== 'win32') return false
  const nativePackage = path.join(kernelRoot, 'node_modules', 'fs-ext', 'package.json')
  if (!fs.existsSync(nativePackage)) return false // 0.1.2 尚未引入 fs-ext。
  const pkg = JSON.parse(fs.readFileSync(nativePackage, 'utf8'))
  if (pkg.name !== 'fs-ext' || pkg.version !== '2.1.1') {
    throw new KernelPatchError('native-dependency-version', `fs-ext@${pkg.version} 尚未验证 Windows 安装兼容性`)
  }
  prepareSessionLockDependency({ kernelRoot, log })
  // 仅在 Windows 暂存包中停用这个未使用模块的编译；其余依赖仍通过 npm rebuild 安装。
  // gypfile:false 防止 npm 根据 binding.gyp 自动补出 node-gyp rebuild。
  if (pkg.scripts) delete pkg.scripts.install
  pkg.gypfile = false
  fs.writeFileSync(nativePackage, JSON.stringify(pkg, null, 2) + '\n')
  log('Windows 会话锁保留 koffi；跳过未使用的 fs-ext 编译与加载')
  return true
}
