/**
 * THE DIVA 启动编排库 —— launch.mjs / setup-profile.mjs（开发）与 desktop/main.js（安装版）共用。
 *
 * 开发模式：内核在 --prefix（默认 ~/.company-desk/kernel），缺了跑 install-kernel.mjs；profile 名 desk；插件链接到仓库 plugins/。
 * 安装版（--packaged，见 preparePackaged）：内核从 payload/kernel.tar 解到 ~/.company-desk/app/kernel；profile 名 desk-app；永不联网。
 *
 * 作为 CLI（安装版的 Electron 主进程用随包 node.exe 调用）：
 *   node scripts/lib/bootstrap.mjs --packaged --payload <dir> [--app-dir <dir>] [--dsh-home <dir>]
 * （默认 --app-dir ~/.company-desk/app，--dsh-home $DSH_HOME 或 ~/.dsh）
 * stdout 每行一个 JSON：{ step, status, detail }，最后一行 { step: "ready", status: "ok", kernelBin, profileName, nodeExe, ... }；
 * 出错时最后一行 { step: "error", status: "fail", detail }，退出码 1；用法错误退出码 64。
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PIN, locateKernel, stampPath, missingProfilePlugins } from '../kernel/locate.mjs'
import { ALL_MARKS, KernelPatchError, applyKernelPatches, missingPatches } from '../kernel/patches.mjs'
import { findTar } from './find-tar.mjs'
import { pendingPaths, readPending, clearPending, hashFile, defaultPendingDir } from './kernel-update.mjs'

export { findTar }

export const here = path.dirname(fileURLToPath(import.meta.url))
/** 仓库根（开发模式）或 payload 根（安装版）：本文件永远在 <root>/scripts/lib/ 下。 */
export const repoRoot = path.resolve(here, '..', '..')

const noop = () => {}
const COMPANY_PLUGINS = ['desk-host', 'desk-ui', 'desk-image']

// ---------- 通用 ----------

/** 首选端口空闲就用它，否则顺延 tries 个，再不行拿一个随机空闲端口。 */
export async function findFreePort(preferred = 3470, tries = 10) {
  const probe = (port) =>
    new Promise((resolve) => {
      const srv = net.createServer()
      srv.unref()
      srv.once('error', () => resolve(false))
      srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => srv.close(() => resolve(true)))
    })
  for (let p = preferred; p < preferred + tries; p++) if (await probe(p)) return p
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen({ port: 0, host: '127.0.0.1' }, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** 轮询到 HTTP 可达（任何 < 500 的状态都算），超时抛错。 */
export async function waitHttp(url, { timeoutMs = 30000, label = url, intervalMs = 300 } = {}) {
  const started = Date.now()
  for (;;) {
    try {
      const r = await fetch(url)
      if (r.ok || r.status < 500) return true
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`${label} ${timeoutMs / 1000}s 内没有就绪`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** 从 profile/cordis.patch.yml 里读 desk-host 的 gatewayUrl。 */
export function readGatewayUrl(patchFile, fallback = 'http://127.0.0.1:8790') {
  const m = /gatewayUrl:\s*'([^']+)'/.exec(fs.readFileSync(patchFile, 'utf8'))
  return (m?.[1] ?? fallback).replace(/\/+$/, '')
}

/** Windows 上用 junction（不需要开发者模式）；已指向同一目标则保留。 */
export function linkJunction(linkPath, target) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  let existed = false
  try {
    const st = fs.lstatSync(linkPath)
    existed = true
    if (st.isSymbolicLink()) {
      if (path.resolve(fs.readlinkSync(linkPath)) === path.resolve(target)) return 'kept'
      fs.unlinkSync(linkPath)
    } else if (st.isDirectory()) {
      fs.rmSync(linkPath, { recursive: true, force: true })
    } else fs.unlinkSync(linkPath)
  } catch (err) {
    // 链接本来就不存在是常态；存在却删不掉（EBUSY/EPERM/只读）要明说，别让下面 symlinkSync 报个难懂的 EEXIST
    if (existed || err.code !== 'ENOENT') {
      throw new Error(`无法替换 ${linkPath} → ${target}（${err.code || err.message}）`)
    }
  }
  fs.symlinkSync(target, linkPath, 'junction')
  return 'linked'
}

export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else child.kill('SIGTERM')
  } catch {
    /* 已退出 */
  }
}

// ---------- profile ----------

function companyPluginsPresent(pluginsDir) {
  if (!pluginsDir) return COMPANY_PLUGINS
  return COMPANY_PLUGINS.filter((name) => fs.existsSync(path.join(pluginsDir, name)))
}

/** profile 缺文件、缺插件链接、或补丁内容与仓库不一致 → 需要重装。 */
export function profileNeedsSetup({ profileDir, patchFile, kernel, pluginsDir }) {
  const profilePatch = path.join(profileDir, 'cordis.patch.yml')
  if (kernel) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
      const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...profilePluginBundles(kernel)]
      if (JSON.stringify(manifest.dsh?.profile?.bundles) !== JSON.stringify(bundles)) return true
      const modules = path.resolve(profileDir, '..', 'node_modules')
      for (const name of bundles) {
        if (!fs.existsSync(path.join(modules, name, 'package.json'))) return true
      }
    } catch { return true }
  }
  const company = companyPluginsPresent(pluginsDir)
  return (
    !fs.existsSync(profilePatch) ||
    company.some((name) => !fs.existsSync(path.join(profileDir, 'node_modules', '@company-desk', name))) ||
    fs.readFileSync(profilePatch, 'utf8') !== fs.readFileSync(patchFile, 'utf8')
  )
}

/**
 * 同事机第一次装没有官方 dsh，`~/.dsh/profiles/node_modules/@deepseek-ai` 不存在。
 * 0.1.2 的 `--dump-default-config` 也不会创建它（heal 只在真正 boot 时跑）。
 * 从内核前缀里的 `@deepseek-ai` 包物化：每个子包一条 junction，外加 `dsh` → kernel.root。
 */
export function ensureFlatFallback({ kernel, dshHome, log = noop }) {
  const flatDir = path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
  const populated = () => {
    try {
      return fs.existsSync(flatDir) && fs.readdirSync(flatDir).length > 0
    } catch {
      return false
    }
  }
  const kernelRoot = kernel?.root
  const nested = kernelRoot ? path.join(kernelRoot, 'node_modules', '@deepseek-ai') : ''
  if (kernelRoot && fs.existsSync(nested)) {
    fs.mkdirSync(flatDir, { recursive: true })
    for (const name of fs.readdirSync(nested)) {
      linkJunction(path.join(flatDir, name), path.join(nested, name))
    }
    linkJunction(path.join(flatDir, 'dsh'), kernelRoot)
    log(`物化扁平回退目录 → ${flatDir}`)
    return flatDir
  }
  if (populated() || fs.existsSync(flatDir)) return flatDir
  throw new Error(`缺少 dsh 扁平回退目录 ${flatDir}，且内核没有 node_modules/@deepseek-ai 可物化。`)
}

/**
 * 安装 / 刷新一个 dsh profile：
 *   <dshHome>/profiles/<profileName>/{package.json, pnpm-workspace.yaml, cordis.patch.yml, node_modules/@company-desk/*}
 * 并让 <root>/node_modules/@deepseek-ai 指向 dsh 的扁平回退目录（插件靠它解析 dsh 内置包）。
 * 扁平回退目录优先从内核物化；selfHeal=true 时再跑一次 `dsh --dump-default-config`（0.1.2 起不会创建该目录）。
 */
/**
 * pin.json 里声明、且已装进内核前缀 node_modules 的第三方插件 → profile bundle 名。
 * 插件随 kernel.tar 离线分发（见 installProfilePlugins），员工机器不需要 npm/pnpm。
 * @param kernel - locateKernel 的结果（用 root 定位内核前缀的 node_modules）
 * @returns {string[]} 可直接放进 dsh.profile.bundles 的包名
 */
export function profilePluginBundles(kernel, plugins = PIN.profilePlugins ?? []) {
  if (!kernel?.root || !plugins.length) return []
  const modules = path.resolve(kernel.root, '..', '..')
  return plugins
    .filter((plugin) => fs.existsSync(path.join(modules, plugin.name, 'package.json')))
    .map((plugin) => plugin.name)
}

/**
 * 把内核前缀里的第三方插件链接到 <dshHome>/profiles/node_modules（与 @deepseek-ai 同一层）。
 * DSH 的 bundle patch 能从安装锚点解析，但运行时 import() 只沿 profile 目录向上找，
 * 插件必须出现在这个共享闭包目录里才能在员工机器上加载。
 */
function unlinkUnpinnedProfilePlugins({ dshHome, plugins = PIN.profilePlugins ?? [], log = noop }) {
  const targetModules = path.join(dshHome, 'profiles', 'node_modules')
  if (!fs.existsSync(targetModules)) return []
  const keep = new Set(plugins.map((p) => p.name))
  const removed = []
  for (const name of ['dsh-better-sidebar']) {
    if (keep.has(name)) continue
    const target = path.join(targetModules, name)
    if (!fs.existsSync(target)) continue
    fs.rmSync(target, { recursive: true, force: true })
    log(`卸掉 profile 插件链接 ${name}`)
    removed.push(name)
  }
  return removed
}

export function linkProfilePlugins({ kernel, dshHome, plugins = PIN.profilePlugins ?? [], log = noop }) {
  unlinkUnpinnedProfilePlugins({ dshHome, plugins, log })
  if (!kernel?.root || !plugins.length) return []
  const sourceModules = path.resolve(kernel.root, '..', '..')
  const targetModules = path.join(dshHome, 'profiles', 'node_modules')
  const linked = []
  for (const plugin of plugins) {
    const source = path.join(sourceModules, plugin.name)
    if (!fs.existsSync(path.join(source, 'package.json'))) continue
    const target = path.join(targetModules, plugin.name)
    const r = linkJunction(target, source)
    log(`profile 插件 ${plugin.name} ${r}`)
    linked.push(plugin.name)
  }
  return linked
}

/**
 * 把内核自带的 @deepseek-ai/* peer 从 <prefix>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/
 * 链接到 <prefix>/node_modules/@deepseek-ai/。第三方插件装在内核前缀顶层，Node 从插件真实路径
 * 往上只走到 <prefix>/node_modules/@deepseek-ai，不进去 dsh 的嵌套 node_modules，所以要先补这层。
 */
export function linkKernelPeers({ kernel, log = noop }) {
  const kernelRoot = kernel?.root
  if (!kernelRoot) return []
  const scope = path.dirname(kernelRoot)
  const nested = path.join(kernelRoot, 'node_modules', '@deepseek-ai')
  if (!fs.existsSync(nested)) return []
  const linked = []
  for (const name of fs.readdirSync(nested)) {
    const target = path.join(scope, name)
    if (fs.existsSync(target)) continue
    linkJunction(target, path.join(nested, name))
    linked.push(name)
  }
  if (linked.length) log(`内核 peer 链接 ${linked.length} 个 → ${scope}`)
  return linked
}

export function ensureProfile({ profileName, dshHome, root, pluginsDir, patchFile, kernel, nodeExe = process.execPath, selfHeal = true, log = noop }) {
  const profileDir = path.join(dshHome, 'profiles', profileName)
  fs.mkdirSync(profileDir, { recursive: true })
  const manifest = {
    name: `dsh-profile-${profileName}`,
    private: true,
    description: 'valimart harness · 企业交付工作台（company-desk）',
    dependencies: {
      '@company-desk/desk-host': `file:${path.join(pluginsDir, 'desk-host').replace(/\\/g, '/')}`,
      '@company-desk/desk-ui': `file:${path.join(pluginsDir, 'desk-ui').replace(/\\/g, '/')}`,
      '@company-desk/desk-image': `file:${path.join(pluginsDir, 'desk-image').replace(/\\/g, '/')}`,
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...profilePluginBundles(kernel)] } },
  }
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  fs.writeFileSync(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  fs.copyFileSync(patchFile, path.join(profileDir, 'cordis.patch.yml'))
  log(`profile: ${profileDir}`)
  for (const name of COMPANY_PLUGINS) {
    const src = path.join(pluginsDir, name)
    if (!fs.existsSync(src)) {
      log(`@company-desk/${name} skipped`)
      continue
    }
    const r = linkJunction(path.join(profileDir, 'node_modules', '@company-desk', name), src)
    log(`@company-desk/${name} ${r}`)
  }

  const flatDir = ensureFlatFallback({ kernel, dshHome, log })
  linkKernelPeers({ kernel, log })
  linkProfilePlugins({ kernel, dshHome, log })
  if (selfHeal && kernel?.bin && fs.existsSync(kernel.bin)) {
    try {
      execFileSync(nodeExe, [kernel.bin, '--profile', profileName, '--dump-default-config'], { stdio: 'ignore', env: { ...process.env, DSH_HOME: dshHome } })
    } catch (err) {
      log(`dsh 自检未通过（继续）：${err.message}`)
    }
  }
  const r = linkJunction(path.join(root, 'node_modules', '@deepseek-ai'), flatDir)
  log(`node_modules/@deepseek-ai → ${flatDir} (${r})`)
  linkZodForPlugins({ kernel, dshHome, root, log })
  fs.mkdirSync(path.join(dshHome, 'desk'), { recursive: true })
  return { profileDir, flatDir }
}

/**
 * Mixed desk-host 从真实插件路径 import 'zod'，Node 沿
 * <appDir>/plugins/desk-host → <appDir>/node_modules/zod 解析。
 * 全新 DSH_HOME 不会在 profiles/node_modules 下 hoist zod；它在
 * <kernel.root>/node_modules/zod（dsh bundle 嵌套）。只查 profiles 会静默跳过，
 * 安装版首次启动直接炸。
 */
export function locateZod({ kernel, dshHome, root } = {}) {
  const candidates = [
    dshHome && path.join(dshHome, 'profiles', 'node_modules', 'zod'),
    kernel?.root && path.join(kernel.root, 'node_modules', 'zod'),
    kernel?.root && path.join(path.dirname(kernel.root), 'zod'),
    root && path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'zod'),
  ].filter(Boolean)
  return candidates.find((p) => fs.existsSync(path.join(p, 'package.json'))) || null
}

export function linkZodForPlugins({ kernel, dshHome, root, log = noop }) {
  const src = locateZod({ kernel, dshHome, root })
  const mixedPresent = Boolean(root && fs.existsSync(path.join(root, 'plugins', 'desk-host', 'lib', 'mixed', 'contracts.js')))
  if (!src) {
    if (mixedPresent && kernel?.root) {
      throw new Error(`缺少 zod：Mixed desk-host 需要内核 hoisted zod（已查 kernel.root/node_modules/zod 与 profiles/node_modules/zod）`)
    }
    return 'skipped'
  }
  const rz = linkJunction(path.join(root, 'node_modules', 'zod'), src)
  log(`node_modules/zod → ${src} (${rz})`)
  if (dshHome) {
    const profileZod = path.join(dshHome, 'profiles', 'node_modules', 'zod')
    if (path.resolve(src) !== path.resolve(profileZod)) {
      const rp = linkJunction(profileZod, src)
      log(`profiles/node_modules/zod → ${src} (${rp})`)
    }
  }
  return rz
}

// ---------- 开发模式 ----------

/**
 * Windows 构建机打的 kernel.tar 里每个文件都是 0644（NTFS 没有 unix 权限位），
 * 但 macOS/Linux 上 node-pty 的 `prebuilds/<plat>-<arch>/spawn-helper` 和 ripgrep 的 `bin/rg`
 * 是要被直接 exec 的——少了 +x，终端和文件搜索会直接报 EACCES。
 * 解压后按路径把该有 +x 的补回来；幂等，Windows 上是 no-op。
 * @returns {number} 补了多少个
 */
/** 内核里需要可执行位的文件（相对内核前缀）：ripgrep 的 bin/rg、node-pty 的 spawn-helper、脚本。 */
export function shouldExecKernelFile(rel) {
  return /(^|\/)(bin|\.bin)\/[^/]+$/.test(rel) || /(^|\/)spawn-helper$/.test(rel) || /\.(sh|command)$/.test(rel)
}

export function chmodKernelExecutables(kernelPrefix, log = noop) {
  if (process.platform === 'win32') return 0
  const shouldExec = shouldExecKernelFile
  let fixed = 0
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      const rel = path.relative(kernelPrefix, p).replace(/\\/g, '/')
      if (!shouldExec(rel)) continue
      try {
        if ((fs.statSync(p).mode & 0o111) === 0o111) continue
        fs.chmodSync(p, 0o755)
        fixed++
      } catch {
        /* 只读挂载 / 权限不足：交给上层报错，别在这里中断启动 */
      }
    }
  }
  if (fs.existsSync(kernelPrefix)) walk(kernelPrefix)
  if (fixed) log(`补可执行位 ${fixed} 个（spawn-helper / bin/rg 等）`)
  return fixed
}

/**
 * 下次启动切换：校验 kernel-next 的 tar sha256 与补丁后再原子替换 targetPrefix。
 * 失败清 pending、删 staging，保留旧内核。
 */
export function applyPendingKernel({ pendingDir, targetPrefix, skillsDir, log = noop }) {
  const pending = readPending(pendingDir)
  const paths = pendingPaths(pendingDir)
  if (!pending) return { applied: false, detail: 'no-pending' }
  if (!fs.existsSync(paths.tar)) {
    // pending 记录在但 tar 丢了（清理/杀软/中断残留）：清记录，别让“已下载”假象卡死升级
    clearPending(pendingDir)
    log('kernel-next 记录在但 tar 缺失，已清除记录（等待重新下载）')
    return { applied: false, detail: 'pending-tar-missing' }
  }
  if (hashFile(paths.tar) !== pending.sha256) {
    clearPending(pendingDir)
    log('内核更新未生效，校验失败，仍用旧内核')
    return { applied: false, detail: 'hash-mismatch' }
  }
  const staging = targetPrefix + '-staging'
  const prev = targetPrefix + '-prev'
  let movedOld = false
  let activated = false
  try {
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(staging, { recursive: true })
    const r = spawnSync(findTar(), ['-xf', paths.tar, '-C', staging], { encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) throw new Error(r.stderr || r.error?.message || 'tar')
    chmodKernelExecutables(staging, log)
    const kernel = locateKernel(staging)
    if (!kernel?.bin || !fs.existsSync(kernel.bin)) throw new Error('no-bin')
    pinSkillsRoot({ kernelPrefix: staging, kernel, skillsDir, log })
    if (missingPatches(kernel.root).length) throw new Error('patches')
    if (kernel.version !== pending.version) throw new Error('version-mismatch')
    const missing = missingProfilePlugins(kernel)
    if (missing.length) throw new Error(`更新包缺少必需插件：${missing.join(', ')}`)
    fs.rmSync(prev, { recursive: true, force: true })
    if (fs.existsSync(targetPrefix)) {
      fs.renameSync(targetPrefix, prev)
      movedOld = true
    }
    fs.renameSync(staging, targetPrefix)
    activated = true
    clearPending(pendingDir)
    log(`内核已更新到 ${pending.version}`)
    return { applied: true, version: pending.version, detail: 'ok' }
  } catch (err) {
    if (movedOld && !activated) fs.renameSync(prev, targetPrefix)
    fs.rmSync(staging, { recursive: true, force: true })
    clearPending(pendingDir)
    const old = locateKernel(targetPrefix)
    log(`内核更新未生效，仍用 ${old?.version ?? '旧版本'}：${err.message}`)
    return { applied: false, detail: String(err.message) }
  }
}

/** 开发模式内核：缺了就跑 install-kernel.mjs（要网络）；verify=true 时即使装好了也跑一遍（幂等校验 + 补缺的补丁）。 */
export function ensureKernelDev({ prefix, dshHome, verify = false, log = noop }) {
  applyPendingKernel({ pendingDir: defaultPendingDir(), targetPrefix: prefix, skillsDir: path.join(dshHome, 'desk', 'drive', '_shared', 'skills'), log })
  let kernel = locateKernel(prefix)
  if (!kernel || verify || missingPatches(kernel.root).length > 0) {
    if (!kernel) log(`${prefix} 里还没有 dsh 内核，先安装（需要网络）…`)
    const r = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'install-kernel.mjs'), '--prefix', prefix, '--dsh-home', dshHome], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error('内核安装 / 校验失败')
    kernel = locateKernel(prefix)
    if (!kernel) throw new Error(`内核安装后仍找不到：${prefix}`)
  }
  return kernel
}

function newestMtime(dir) {
  let t = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    t = Math.max(t, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs)
  }
  return t
}

/** 开发模式：desk-ui 源码比 bundle 新就重新打包。 */
export function ensureBundle({ log = noop } = {}) {
  const bundle = path.join(repoRoot, 'plugins', 'desk-ui', 'lib', 'client.js')
  const srcDir = path.join(repoRoot, 'plugins', 'desk-ui', 'src')
  if (!fs.existsSync(bundle) || fs.statSync(bundle).mtimeMs < newestMtime(srcDir)) {
    log('构建客户端 bundle …')
    const r = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-client.mjs')], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error('build-client 失败')
  }
  return bundle
}

// ---------- 起客户端 ----------

export function spawnClient({ nodeExe = process.execPath, kernelBin, profileName, port, dshHome, cwd = process.cwd(), env = process.env, stdio = 'inherit' }) {
  return spawn(nodeExe, [kernelBin, '--profile', profileName, '--no-open', '--port', String(port)], { cwd, stdio, env: { ...env, DSH_HOME: dshHome }, windowsHide: true })
}

// ---------- 安装版 ----------

/**
 * 让内核预设里的技能根指向当前用户的公司盘镜像。戳记一致且补丁齐 → 不动；否则跑一遍 applyKernelPatches
 * （16 处 mark 都在时只会同步技能根路径）并重写戳记。返回是否改动。
 * kernel.tar 里带的是构建机的绝对路径（戳记 + 预设），missingPatches 只看 mark 看不出路径不对，所以必须比戳记。
 */
export function pinSkillsRoot({ kernelPrefix, kernel, skillsDir, log = noop }) {
  const stamp = stampPath(kernelPrefix)
  let current = null
  try {
    current = JSON.parse(fs.readFileSync(stamp, 'utf8'))
  } catch {
    /* 无戳记 */
  }
  if (current && current.skillsDir === skillsDir && missingPatches(kernel.root).length === 0) {
    log({ step: 'kernel', status: 'skip', detail: `技能根已是 ${skillsDir}` })
    return false
  }
  log({ step: 'kernel', status: 'start', detail: `同步技能根 → ${skillsDir}` })
  let counters
  try {
    counters = applyKernelPatches({ kernelRoot: kernel.root, skillsDir, log: noop, expectVersion: kernel.version === PIN.version ? PIN.version : undefined })
  } catch (err) {
    if (err instanceof KernelPatchError) throw new Error(`PATCH_FAIL ${err.code}: ${err.detail}`)
    throw err
  }
  const left = missingPatches(kernel.root)
  if (left.length) throw new Error(`打完补丁仍缺：${left.join(', ')}`)
  fs.writeFileSync(
    stamp,
    JSON.stringify({ package: PIN.package, version: kernel.version, kernelRoot: kernel.root, skillsDir, patchedAt: new Date().toISOString(), marks: ALL_MARKS.map((m) => m.marks[0]) }, null, 2) + '\n',
  )
  log({ step: 'kernel', status: 'ok', detail: `新打 ${counters.applied} 处，已有 ${counters.skipped} 处` })
  return true
}

/**
 * preparePackaged 在 appDir 里创建的全部条目：kernel（tar）、plugins/profile/scripts（复制自 payload）、
 * node_modules（ensureProfile 放的 @deepseek-ai junction）、state.json。重新解压时只删这些，不删整个 appDir ——
 * --app-dir 被误配到有用目录（如 ~/.company-desk 而不是 ~/.company-desk/app）时，开发内核、日志等不受影响。
 * kernel-next 故意不在此列：升级解压 bundled 后仍保留 pending，下一步 apply 才能覆盖 bundled。
 */
const APP_DIR_ENTRIES = ['kernel', 'plugins', 'profile', 'scripts', 'node_modules', 'state.json']

/**
 * appDir 必须是专用目录：里面有 package.json 或 .git 就是项目 / 仓库目录（典型误用：在仓库根 `--app-dir .`），
 * clearAppDir 会删掉它的 node_modules / scripts，ensureProfile 会替换 node_modules/@deepseek-ai —— 一律拒绝。
 */
export function assertSafeAppDir(appDir) {
  for (const marker of ['package.json', '.git']) {
    if (fs.existsSync(path.join(appDir, marker))) {
      throw new Error(`--app-dir ${appDir} 里有 ${marker}，看起来是项目目录而不是专用的应用目录，拒绝在这里解压 / 清理（默认 ~/.company-desk/app）`)
    }
  }
}

/** 清掉 appDir 里本模块创建的条目。junction 只删链接不碰目标；Windows 上刚解压的树偶发 EBUSY/EPERM，带重试。 */
function clearAppDir(appDir) {
  assertSafeAppDir(appDir)
  for (const name of APP_DIR_ENTRIES) fs.rmSync(path.join(appDir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}

/**
 * 要不要（重新）解压内核：没有 state.json → 首次；buildId 与 payload 不同 → 版本更新；
 * 内核 package.json 或 bin 不在（上次解压中断 / 被误删；locateKernel 只看 package.json）→ 目录不完整。
 * 返回 { fresh, reason }，reason 直接作 extract 事件的 detail。
 */
export function needsExtract({ stateFile, kernelPrefix, buildId }) {
  let state = null
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {
    /* 首次 */
  }
  if (!state) return { fresh: true, reason: '首次启动，解压内核（约半分钟）' }
  if (state.buildId !== buildId) return { fresh: true, reason: `版本更新（${state.buildId} → ${buildId}），重新解压内核` }
  const kernel = locateKernel(kernelPrefix)
  if (!kernel || !fs.existsSync(kernel.bin)) return { fresh: true, reason: '内核目录不完整，重新解压内核' }
  const missing = missingProfilePlugins(kernel)
  if (missing.length) return { fresh: true, reason: `内核缺少必需插件（${missing.join(', ')}），恢复随包内核` }
  return { fresh: false, reason: `内核已就位（${buildId}）` }
}

/**
 * 安装版首次启动 / 升级后的准备：
 *   1) assertSafeAppDir：项目目录直接抛错，apply / 解压之前什么都不动；
 *   2) needsExtract 说要解压（首次 / buildId 变了 / 内核目录不完整）→ 清掉 appDir 里本模块创建的条目（APP_DIR_ENTRIES）重建：
 *      tar 解 kernel.tar 到 appDir/kernel，复制 plugins/profile/scripts，写 state.json（不碰 kernel-next）；
 *   3) applyPendingKernel：pending 覆盖刚解出的 bundled，下次启动 pending 优先；
 *   4) 技能根同步到 <dshHome>/desk/drive/_shared/skills；
 *   5) profile desk-app（插件链接到 appDir/plugins，appDir/node_modules/@deepseek-ai → dsh 回退目录）。
 * 只做准备，不长驻；内核由调用方（Electron 主进程）用 nodeExe 启动。log 收到的是 { step, status, detail } 对象。
 */
export function preparePackaged({ payloadDir, appDir, dshHome, log = noop }) {
  assertSafeAppDir(appDir)
  const payload = JSON.parse(fs.readFileSync(path.join(payloadDir, 'payload.json'), 'utf8'))
  const kernelPrefix = path.join(appDir, 'kernel')
  const stateFile = path.join(appDir, 'state.json')
  const skillsDir = path.join(dshHome, 'desk', 'drive', '_shared', 'skills')
  const { fresh, reason } = needsExtract({ stateFile, kernelPrefix, buildId: payload.buildId })
  if (fresh) {
    log({ step: 'extract', status: 'start', detail: reason })
    clearAppDir(appDir)
    fs.mkdirSync(kernelPrefix, { recursive: true })
    const r = spawnSync(findTar(), ['-xf', path.join(payloadDir, 'kernel.tar'), '-C', kernelPrefix], { stdio: 'pipe', encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) {
      clearAppDir(appDir)
      throw new Error(`解压内核失败（${r.status ?? r.signal ?? r.error?.message}）：${(r.stderr || '').trim()}`)
    }
    chmodKernelExecutables(kernelPrefix, log)
    for (const d of ['plugins', 'profile', 'scripts']) fs.cpSync(path.join(payloadDir, d), path.join(appDir, d), { recursive: true })
    fs.writeFileSync(stateFile, JSON.stringify({ buildId: payload.buildId, extractedAt: new Date().toISOString() }, null, 2) + '\n')
    log({ step: 'extract', status: 'ok', detail: `内核 ${payload.kernel.version}` })
  } else log({ step: 'extract', status: 'skip', detail: reason })

  const update = applyPendingKernel({ pendingDir: path.join(appDir, 'kernel-next'), targetPrefix: kernelPrefix, skillsDir, log })

  const kernel = locateKernel(kernelPrefix)
  if (!kernel) throw new Error(`解压后找不到内核：${kernelPrefix}`)
  const missing = missingProfilePlugins(kernel)
  if (missing.length) throw new Error(`内核缺少必需插件：${missing.join(', ')}`)
  pinSkillsRoot({ kernelPrefix, kernel, skillsDir, log })

  const profileName = 'desk-app'
  const profileDir = path.join(dshHome, 'profiles', profileName)
  const patchFile = path.join(appDir, 'profile', 'cordis.patch.yml')
  if (fresh || update.applied || profileNeedsSetup({ profileDir, patchFile, kernel, pluginsDir: path.join(appDir, 'plugins') }) || !fs.existsSync(path.join(appDir, 'node_modules', '@deepseek-ai')) || !fs.existsSync(path.join(appDir, 'node_modules', 'zod', 'package.json'))) {
    log({ step: 'profile', status: 'start', detail: '安装工作台配置（desk-app）' })
    ensureProfile({ profileName, dshHome, root: appDir, pluginsDir: path.join(appDir, 'plugins'), patchFile, kernel, log: (m) => log({ step: 'profile', status: 'info', detail: m }) })
    log({ step: 'profile', status: 'ok' })
  } else log({ step: 'profile', status: 'skip' })

  return { kernelBin: kernel.bin, kernelRoot: kernel.root, kernelVersion: kernel.version, profileName, appDir, buildId: payload.buildId, nodeExe: process.execPath }
}

// ---------- CLI ----------

/**
 * 只有作为入口脚本运行才进 CLI（被 import 无副作用）。两边都取 realpath 再比：经 junction / 符号链接启动时
 * ESM 加载器会把 import.meta.url 解析成真实路径而 argv[1] 还是链接路径，直接比会静默不进 CLI。realpath 取不到就退回直接比。
 */
function isMainModule() {
  if (!process.argv[1]) return false
  const entry = path.resolve(process.argv[1])
  const self = fileURLToPath(import.meta.url)
  try {
    return fs.realpathSync.native(entry) === fs.realpathSync.native(self)
  } catch {
    return entry === self
  }
}

if (isMainModule()) {
  const args = process.argv.slice(2)
  const argOf = (k, dflt) => {
    const i = args.indexOf(k)
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt
  }
  const emit = (o) => process.stdout.write(JSON.stringify(typeof o === 'string' ? { step: 'log', status: 'info', detail: o } : o) + '\n')
  if (!args.includes('--packaged') || !argOf('--payload')) {
    console.error('用法：node bootstrap.mjs --packaged --payload <dir> [--app-dir <dir>] [--dsh-home <dir>]')
    process.exit(64)
  }
  try {
    const result = preparePackaged({
      payloadDir: path.resolve(argOf('--payload')),
      appDir: path.resolve(argOf('--app-dir', path.join(os.homedir(), '.company-desk', 'app'))),
      dshHome: path.resolve(argOf('--dsh-home', process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))),
      log: emit,
    })
    emit({ step: 'ready', status: 'ok', ...result })
  } catch (err) {
    emit({ step: 'error', status: 'fail', detail: err.message })
    process.exit(1)
  }
}
