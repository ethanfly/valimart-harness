/** Windows 会话锁使用 koffi；0.1.3 的 POSIX fs-ext 不应在 Windows 编译或加载。 */
import fs from 'node:fs'
import path from 'node:path'
import { KernelPatchError, applyEdit } from '../kernel/patches.mjs'

export const WINDOWS_FLOCK_MARK = 'company-session-posix-flock-v1'

export function prepareWindowsNativeDependencies({ kernelRoot, platform = process.platform, log = () => {} }) {
  if (platform !== 'win32') return false
  const nativePackage = path.join(kernelRoot, 'node_modules', 'fs-ext', 'package.json')
  if (!fs.existsSync(nativePackage)) return false // 0.1.2 尚未引入 fs-ext。
  const pkg = JSON.parse(fs.readFileSync(nativePackage, 'utf8'))
  if (pkg.name !== 'fs-ext' || pkg.version !== '2.1.1') {
    throw new KernelPatchError('native-dependency-version', `fs-ext@${pkg.version} 尚未验证 Windows 安装兼容性`)
  }
  const file = path.join(kernelRoot, 'node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'index.js')
  let source = fs.readFileSync(file, 'utf8')
  if (!source.includes(WINDOWS_FLOCK_MARK)) {
    // 保留上游 Windows 信号量锁；只让 POSIX 加载 flock，绝不以空实现替代锁。
    if (!source.includes('if (process.platform === "win32") {') || !source.includes('await acquireLockHandleWin32(path)')) {
      throw new KernelPatchError('windows-session-lock-anchor', file)
    }
    source = applyEdit(source, {
      name: 'posix-only-fs-ext',
      from: 'import { flock } from "fs-ext";',
      to: 'import { createRequire as companyCreateRequire } from "node:module";\n' +
        `// ${WINDOWS_FLOCK_MARK}: Windows uses the upstream koffi semaphore.\n` +
        'const flock = process.platform === "win32" ? undefined : companyCreateRequire(import.meta.url)("fs-ext").flock;',
    }, file)
    fs.writeFileSync(file, source)
  }
  // 仅在 Windows 暂存包中停用这个未使用模块的编译；其余依赖仍通过 npm rebuild 安装。
  // gypfile:false 防止 npm 根据 binding.gyp 自动补出 node-gyp rebuild。
  if (pkg.scripts) delete pkg.scripts.install
  pkg.gypfile = false
  fs.writeFileSync(nativePackage, JSON.stringify(pkg, null, 2) + '\n')
  log('Windows 会话锁保留 koffi；跳过未使用的 fs-ext 编译与加载')
  return true
}
