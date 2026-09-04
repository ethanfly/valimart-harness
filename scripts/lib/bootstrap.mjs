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
import { PIN, locateKernel, stampPath } from '../kernel/locate.mjs'
import { ALL_MARKS, KernelPatchError, applyKernelPatches, missingPatches } from '../kernel/patches.mjs'

export const here = path.dirname(fileURLToPath(import.meta.url))
/** 仓库根（开发模式）或 payload 根（安装版）：本文件永远在 <root>/scripts/lib/ 下。 */
export const repoRoot = path.resolve(here, '..', '..')

const noop = () => {}

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
  try {
    const st = fs.lstatSync(linkPath)
    if (st.isSymbolicLink()) {
      if (path.resolve(fs.readlinkSync(linkPath)) === path.resolve(target)) return 'kept'
      fs.unlinkSync(linkPath)
    } else if (st.isDirectory()) {
      fs.rmSync(linkPath, { recursive: true, force: true })
    } else fs.unlinkSync(linkPath)
  } catch {
    /* 不存在 */
  }
  fs.symlinkSync(target, linkPath, 'junction')
  return 'linked'
}

/** Windows 10 1803+ 自带 bsdtar；找不到就抛错。 */
export function findTar() {
  if (process.platform === 'win32') {
    const sys = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    if (fs.existsSync(sys)) return sys
  }
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['tar'], { stdio: 'pipe', encoding: 'utf8' })
  if (r.status === 0 && r.stdout.trim()) return r.stdout.split(/\r?\n/)[0].trim()
  throw new Error('找不到 tar.exe（需要 Windows 10 1803 及以上，或自行安装 bsdtar）')
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

/** profile 缺文件、缺插件链接、或补丁内容与仓库不一致 → 需要重装。 */
export function profileNeedsSetup({ profileDir, patchFile }) {
  const profilePatch = path.join(profileDir, 'cordis.patch.yml')
  return (
    !fs.existsSync(profilePatch) ||
    !fs.existsSync(path.join(profileDir, 'node_modules', '@company-desk', 'desk-ui')) ||
    fs.readFileSync(profilePatch, 'utf8') !== fs.readFileSync(patchFile, 'utf8')
  )
}

/**
 * 安装 / 刷新一个 dsh profile：
 *   <dshHome>/profiles/<profileName>/{package.json, pnpm-workspace.yaml, cordis.patch.yml, node_modules/@company-desk/*}
 * 并让 <root>/node_modules/@deepseek-ai 指向 dsh 的扁平回退目录（插件靠它解析 dsh 内置包）。
 * selfHeal=true 时先跑一次 `dsh --dump-default-config` 让 dsh 创建回退目录（需要真内核）。
 */
export function ensureProfile({ profileName, dshHome, root, pluginsDir, patchFile, kernel, nodeExe = process.execPath, selfHeal = true, log = noop }) {
  const profileDir = path.join(dshHome, 'profiles', profileName)
  fs.mkdirSync(profileDir, { recursive: true })
  const manifest = {
    name: `dsh-profile-${profileName}`,
    private: true,
    description: 'THE DIVA · 企业交付工作台（company-desk）',
    dependencies: {
      '@company-desk/desk-host': `file:${path.join(pluginsDir, 'desk-host').replace(/\\/g, '/')}`,
      '@company-desk/desk-ui': `file:${path.join(pluginsDir, 'desk-ui').replace(/\\/g, '/')}`,
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  fs.writeFileSync(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  fs.copyFileSync(patchFile, path.join(profileDir, 'cordis.patch.yml'))
  log(`profile: ${profileDir}`)
  for (const name of ['desk-host', 'desk-ui']) {
    const r = linkJunction(path.join(profileDir, 'node_modules', '@company-desk', name), path.join(pluginsDir, name))
    log(`@company-desk/${name} ${r}`)
  }

  const flatDir = path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
  if (selfHeal) {
    try {
      execFileSync(nodeExe, [kernel.bin, '--profile', profileName, '--dump-default-config'], { stdio: 'ignore', env: { ...process.env, DSH_HOME: dshHome } })
    } catch (err) {
      log(`dsh 自检未通过（继续）：${err.message}`)
    }
  }
  if (!fs.existsSync(flatDir)) throw new Error(`缺少 dsh 扁平回退目录 ${flatDir}，请先成功启动一次 dsh。`)
  const r = linkJunction(path.join(root, 'node_modules', '@deepseek-ai'), flatDir)
  log(`node_modules/@deepseek-ai → ${flatDir} (${r})`)
  fs.mkdirSync(path.join(dshHome, 'desk'), { recursive: true })
  return { profileDir, flatDir }
}

// ---------- 开发模式 ----------

/** 开发模式内核：缺了就跑 install-kernel.mjs（要网络）；verify=true 时即使装好了也跑一遍（幂等校验 + 补缺的补丁）。 */
export function ensureKernelDev({ prefix, dshHome, verify = false, log = noop }) {
  let kernel = locateKernel(prefix)
  if (!kernel || verify) {
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
    counters = applyKernelPatches({ kernelRoot: kernel.root, skillsDir, log: noop })
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
 * 安装版首次启动 / 升级后的准备：
 *   1) appDir/state.json 的 buildId ≠ payload.json 的（或内核不在）→ 删 appDir 重建：tar 解 kernel.tar 到 appDir/kernel，复制 plugins/profile/scripts；
 *   2) 技能根同步到 <dshHome>/desk/drive/_shared/skills；
 *   3) profile desk-app（插件链接到 appDir/plugins，appDir/node_modules/@deepseek-ai → dsh 回退目录）。
 * 只做准备，不长驻；内核由调用方（Electron 主进程）用 nodeExe 启动。log 收到的是 { step, status, detail } 对象。
 */
export function preparePackaged({ payloadDir, appDir, dshHome, log = noop }) {
  const payload = JSON.parse(fs.readFileSync(path.join(payloadDir, 'payload.json'), 'utf8'))
  const kernelPrefix = path.join(appDir, 'kernel')
  const stateFile = path.join(appDir, 'state.json')
  let state = null
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {
    /* 首次 */
  }
  const fresh = !state || state.buildId !== payload.buildId || !locateKernel(kernelPrefix)
  if (fresh) {
    const why = !state ? '首次启动，解压内核（约半分钟）' : state.buildId !== payload.buildId ? `版本更新（${state.buildId} → ${payload.buildId}），重新解压内核` : '内核目录不完整，重新解压内核'
    log({ step: 'extract', status: 'start', detail: why })
    fs.rmSync(appDir, { recursive: true, force: true })
    fs.mkdirSync(kernelPrefix, { recursive: true })
    const r = spawnSync(findTar(), ['-xf', path.join(payloadDir, 'kernel.tar'), '-C', kernelPrefix], { stdio: 'pipe', encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) {
      fs.rmSync(appDir, { recursive: true, force: true })
      throw new Error(`解压内核失败（${r.status ?? r.signal ?? r.error?.message}）：${(r.stderr || '').trim()}`)
    }
    for (const d of ['plugins', 'profile', 'scripts']) fs.cpSync(path.join(payloadDir, d), path.join(appDir, d), { recursive: true })
    fs.writeFileSync(stateFile, JSON.stringify({ buildId: payload.buildId, extractedAt: new Date().toISOString() }, null, 2) + '\n')
    log({ step: 'extract', status: 'ok', detail: `内核 ${payload.kernel.version}` })
  } else log({ step: 'extract', status: 'skip', detail: `内核已就位（${payload.buildId}）` })

  const kernel = locateKernel(kernelPrefix)
  if (!kernel) throw new Error(`解压后找不到内核：${kernelPrefix}`)
  pinSkillsRoot({ kernelPrefix, kernel, skillsDir: path.join(dshHome, 'desk', 'drive', '_shared', 'skills'), log })

  const profileName = 'desk-app'
  const profileDir = path.join(dshHome, 'profiles', profileName)
  const patchFile = path.join(appDir, 'profile', 'cordis.patch.yml')
  if (fresh || profileNeedsSetup({ profileDir, patchFile }) || !fs.existsSync(path.join(appDir, 'node_modules', '@deepseek-ai'))) {
    log({ step: 'profile', status: 'start', detail: '安装工作台配置（desk-app）' })
    ensureProfile({ profileName, dshHome, root: appDir, pluginsDir: path.join(appDir, 'plugins'), patchFile, kernel, log: (m) => log({ step: 'profile', status: 'info', detail: m }) })
    log({ step: 'profile', status: 'ok' })
  } else log({ step: 'profile', status: 'skip' })

  return { kernelBin: kernel.bin, kernelRoot: kernel.root, kernelVersion: kernel.version, profileName, appDir, buildId: payload.buildId, nodeExe: process.execPath }
}

// ---------- CLI ----------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
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
