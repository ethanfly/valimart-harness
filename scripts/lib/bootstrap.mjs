/**
 * THE DIVA 启动编排库 —— launch.mjs / setup-profile.mjs（开发）与 desktop/main.js（安装版）共用。
 *
 * 开发模式：内核在 --prefix（默认 ~/.company-desk/kernel），缺了跑 install-kernel.mjs；profile 名 desk；插件链接到仓库 plugins/。
 * 安装版（--packaged，见 preparePackaged）：内核从 payload/kernel.tar 解到 ~/.company-desk/app/kernel；profile 名 desk-app；永不联网。
 *
 * 作为 CLI（安装版的 Electron 主进程用随包 node.exe 调用）：
 *   node scripts/lib/bootstrap.mjs --packaged --payload <dir> --app-dir <dir> [--dsh-home <dir>]
 * stdout 每行一个 JSON：{ step, status, detail }，最后一行 { step: "ready", kernelBin, profileName, ... }。
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
