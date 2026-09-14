/**
 * 把一个（在 Windows 上装的）dsh 内核前缀改造成 darwin-x64 可用的前缀。
 *
 * 内核的 JS 部分与平台无关，但 npm 在 Windows 上只会装 win32-x64 那批 optional 平台包：
 *   @img/sharp-win32-x64、@koromix/koffi-win32-x64、@vscode/ripgrep-win32-x64、
 *   node-addon-require-builtin-win32-x64-msvc（外加 node-pty 自带的 prebuilds）。
 * 所以打 mac 包时要把对应的 darwin-x64 包补进去、把 win32 的删掉；已裁剪源内核的 node-pty
 * 从同版本 npm tarball 恢复缺失的 darwin-x64 prebuilds，只修改 stage，不修改源内核。
 *
 * 这些 darwin 包由 build-mac-client.mjs 用 npm pack 预取到 build/mac-cache/npm/。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { findTar } from './find-tar.mjs'
import { prepareSessionLockDependency } from './kernel-native.mjs'

/** 需要注入的 darwin-x64 平台包；near = 它在 win32 下的对应包（用它定位目标 node_modules）。 */
export const DARWIN_X64_PACKAGES = [
  { dir: '@img/sharp-darwin-x64', tgz: 'img-sharp-darwin-x64-0.35.4.tgz', near: '@img/sharp-win32-x64' },
  { dir: '@img/sharp-libvips-darwin-x64', tgz: 'img-sharp-libvips-darwin-x64-1.3.3.tgz', near: '@img/sharp-win32-x64' },
  { dir: '@koromix/koffi-darwin-x64', tgz: 'koromix-koffi-darwin-x64-3.2.1.tgz', near: '@koromix/koffi-win32-x64' },
  { dir: '@vscode/ripgrep-darwin-x64', tgz: 'vscode-ripgrep-darwin-x64-1.18.0.tgz', near: '@vscode/ripgrep-win32-x64' },
  { dir: 'node-addon-require-builtin-darwin-x64', tgz: 'node-addon-require-builtin-darwin-x64-0.1.5.tgz', near: 'node-addon-require-builtin-win32-x64-msvc' },
]

/** 这些包只有 win32 版本，进 mac 包没意义还占体积。 */
export const WIN32_ONLY_PACKAGES = [
  '@img/sharp-win32-x64',
  '@koromix/koffi-win32-x64',
  '@vscode/ripgrep-win32-x64',
  'node-addon-require-builtin-win32-x64-msvc',
]

const noop = () => {}

/** 递归找出所有名为 relPath 的包目录（relPath 用 / 分隔，如 @img/sharp-win32-x64）。 */
export function findPackageDirs(root, relPath) {
  const target = relPath.split('/')
  const hits = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const p = path.join(dir, e.name)
      if (e.name !== 'node_modules' && target.length === 1 && e.name === target[0] && fs.existsSync(path.join(p, 'package.json'))) {
        hits.push(p)
        continue
      }
      if (target.length > 1 && e.name === target[0]) {
        const leaf = path.join(p, target[1])
        if (fs.existsSync(path.join(leaf, 'package.json'))) hits.push(leaf)
      }
      walk(p)
    }
  }
  walk(root)
  return hits
}

/** 0.1.5 的 POSIX 锁平台包，以入口包定位（不存在 win32 对应包）。 */
export function darwinSystemRequirements(prefix) {
  return findPackageDirs(prefix, '@deepseek-ai/node-addon-system').map((dir) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const name = '@deepseek-ai/node-addon-system-darwin-x64'
    const version = pkg.optionalDependencies?.[name]
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`缺精确 ${name} 版本：${dir}`)
    return { dir, version, name, spec: `${name}@${version}`, tgz: `deepseek-ai-node-addon-system-darwin-x64-${version}.tgz` }
  })
}

export function injectDarwinSystem({ stage, cacheDir, log = noop }) {
  const requirements = darwinSystemRequirements(stage)
  for (const spec of requirements) {
    const archive = path.join(cacheDir, spec.tgz)
    if (!fs.existsSync(archive)) throw new Error(`缺 darwin 会话锁缓存：${spec.tgz}`)
    const dest = path.join(path.dirname(spec.dir), path.basename(spec.name))
    const pkg = extractTgz(archive, dest, log)
    if (pkg.name !== spec.name || pkg.version !== spec.version) throw new Error(`${spec.tgz} 包名或版本不匹配`)
    if (!fs.existsSync(path.join(dest, 'bin', 'system.node'))) throw new Error(`${spec.tgz} 缺 bin/system.node`)
  }
  return requirements.length
}

const PTY_FILES = ['pty.node', 'spawn-helper']
const hasDarwinPty = (dir) => PTY_FILES.every((file) => {
  try { const stat = fs.statSync(path.join(dir, 'prebuilds', 'darwin-x64', file)); return stat.isFile() && stat.size > 0 } catch { return false }
})

/** 从实际安装版本推导缓存名；不把预发布版本升级到 latest，也支持多份不同版本。 */
export function nodePtyDarwinRequirements(prefix) {
  return findPackageDirs(prefix, 'node-pty').filter((dir) => !hasDarwinPty(dir)).map((dir) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    if (pkg.name !== 'node-pty' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
      throw new Error(`node-pty package.json 版本无效：${dir}`)
    }
    return { dir, version: pkg.version, spec: `node-pty@${pkg.version}`, tgz: `node-pty-${pkg.version}.tgz` }
  })
}

/** 仅恢复 stage 缺失的平台目录；保留其 JS、package.json 和本地补丁。 */
export function restoreDarwinNodePty({ stage, cacheDir, log = noop }) {
  const requirements = nodePtyDarwinRequirements(stage)
  for (const { dir, version, tgz } of requirements) {
    const archive = path.join(cacheDir, tgz)
    if (!fs.existsSync(archive)) throw new Error(`缺 node-pty 缓存 ${tgz}（先 npm pack node-pty@${version} 到 ${cacheDir}）`)
    const tmp = fs.mkdtempSync(path.join(path.dirname(stage), '.node-pty-darwin-'))
    try {
      const unpacked = path.join(tmp, 'package')
      const pkg = extractTgz(archive, unpacked, noop)
      if (pkg.name !== 'node-pty' || pkg.version !== version) throw new Error(`${tgz} 版本不匹配：期望 node-pty@${version}，实际 ${pkg.name}@${pkg.version}`)
      if (!hasDarwinPty(unpacked)) throw new Error(`${tgz} 缺完整 darwin-x64 prebuilds（pty.node / spawn-helper）`)
      const dest = path.join(dir, 'prebuilds', 'darwin-x64')
      fs.mkdirSync(dest, { recursive: true })
      for (const file of PTY_FILES) fs.copyFileSync(path.join(unpacked, 'prebuilds', 'darwin-x64', file), path.join(dest, file))
      fs.chmodSync(path.join(dest, 'spawn-helper'), 0o755)
      log(`  恢复 node-pty@${version} darwin-x64 prebuilds → ${dir}`)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
  return requirements.length
}

function extractTgz(tgz, dest, log) {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })
  const r = spawnSync(findTar(), ['-xzf', tgz, '-C', dest, '--strip-components=1'], { stdio: 'pipe', encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`解包 ${path.basename(tgz)} 失败：${(r.stderr || r.error?.message || '').trim()}`)
  const pkgFile = path.join(dest, 'package.json')
  if (!fs.existsSync(pkgFile)) throw new Error(`${path.basename(tgz)} 解出来没有 package.json`)
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  if (pkg.os && !pkg.os.includes('darwin')) throw new Error(`${pkg.name} 的 os 不是 darwin：${pkg.os}`)
  log(`  注入 ${pkg.name}@${pkg.version} → ${path.relative(process.cwd(), dest) || dest}`)
  return pkg
}

/**
 * @param {{ sourcePrefix: string, stage: string, cacheDir: string, log?: Function }} opts
 */
export function prepareDarwinKernelStage({ sourcePrefix, stage, cacheDir, log = noop }) {
  if (!fs.existsSync(path.join(sourcePrefix, 'node_modules'))) throw new Error(`源内核前缀没有 node_modules：${sourcePrefix}`)
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(stage), { recursive: true })
  log(`复制内核前缀 ${sourcePrefix} → ${stage}`)
  fs.cpSync(sourcePrefix, stage, { recursive: true, force: true })

  // 1) 补 darwin-x64 平台包
  for (const spec of DARWIN_X64_PACKAGES) {
    const tgz = path.join(cacheDir, spec.tgz)
    if (!fs.existsSync(tgz)) throw new Error(`缺 darwin 平台包 ${spec.tgz}（先 npm pack 到 ${cacheDir}）`)
    const anchors = findPackageDirs(stage, spec.near)
    if (!anchors.length) throw new Error(`内核里找不到 ${spec.near}，无法定位 ${spec.dir} 该放哪`)
    for (const anchor of anchors) {
      extractTgz(tgz, path.join(path.dirname(anchor), path.basename(spec.dir)), log)
    }
  }

  const systemInjected = injectDarwinSystem({ stage, cacheDir, log })

  // 2) 删 win32-only 平台包
  let removed = 0
  for (const rel of WIN32_ONLY_PACKAGES) {
    for (const dir of findPackageDirs(stage, rel)) {
      fs.rmSync(dir, { recursive: true, force: true })
      removed++
    }
  }
  log(`移除 win32-only 平台包 ${removed} 个`)

  // 3) 裁剪过的 Windows 内核需从同版本缓存补回 darwin prebuilds，然后清理 win32 产物。
  const ptyRestored = restoreDarwinNodePty({ stage, cacheDir, log })
  const ptyDirs = findPackageDirs(stage, 'node-pty')
  let ptyCleaned = 0
  for (const pty of ptyDirs) {
    for (const rel of ['build/Release/conpty', 'third_party/conpty']) {
      const p = path.join(pty, rel)
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true })
        ptyCleaned++
      }
    }
  }
  log(`清理 node-pty win32 产物 ${ptyCleaned} 处`)
  // 4) 会话锁：macOS 上没有编译好的 fs-ext（Windows 构建机编不出来），换成 koffi flock(2) 兜底
  const kernelRoot = path.join(stage, 'node_modules', '@deepseek-ai', 'dsh')
  if (fs.existsSync(kernelRoot)) prepareSessionLockDependency({ kernelRoot, log })
  else throw new Error(`stage 里没有内核：${kernelRoot}`)

  return { stage, injected: DARWIN_X64_PACKAGES.length + systemInjected, removedWin32: removed, ptyCleaned, ptyRestored }
}
