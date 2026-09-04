/**
 * 找内核：dsh 内核装在一个独立的 npm 前缀目录里（不是全局 npm，也不是任何正在被别的东西使用的树）。
 *
 * 前缀的选取顺序：
 *   1. --prefix 参数 / DESK_KERNEL_PREFIX（兼容旧的 TDH_PREFIX）
 *   2. ~/.company-desk/kernel（默认）
 *   3. 旧位置 ~/.tdh-coding-prefix 里已经有内核 → 直接复用，不重复下载
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PIN = JSON.parse(fs.readFileSync(new URL('./pin.json', import.meta.url), 'utf8'))

export const DEFAULT_PREFIX = path.join(os.homedir(), '.company-desk', 'kernel')
export const LEGACY_PREFIX = path.join(os.homedir(), '.tdh-coding-prefix')

export const defaultDshHome = () => process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

export function defaultPrefix() {
  const env = process.env.DESK_KERNEL_PREFIX || process.env.TDH_PREFIX
  if (env) return env
  if (locateKernel(DEFAULT_PREFIX)) return DEFAULT_PREFIX
  if (locateKernel(LEGACY_PREFIX)) return LEGACY_PREFIX
  return DEFAULT_PREFIX
}

/** `npm install -g --prefix` 在 Windows 与 macOS/Linux 的目录布局不同。 */
export function kernelRootCandidates(prefix) {
  return [path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh'), path.join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh')]
}

/** 返回 { root, bin, version }；没装返回 null。 */
export function locateKernel(prefix) {
  for (const root of kernelRootCandidates(prefix)) {
    const pkg = path.join(root, 'package.json')
    if (!fs.existsSync(pkg)) continue
    let version = null
    try {
      version = JSON.parse(fs.readFileSync(pkg, 'utf8')).version ?? null
    } catch {
      /* 坏掉的 package.json：当作未知版本 */
    }
    return { root, bin: path.join(root, 'lib', 'bin.js'), version }
  }
  return null
}

/** 安装完成后落在前缀根目录的戳记（版本 + 补丁清单），用来快速判断「已装好」。 */
export const stampPath = (prefix) => path.join(prefix, '.company-desk-kernel.json')

/**
 * 绝不往正在被使用的 npm 树里写：全局 npm 目录、~/.local、以及历史上的手工安装目录。
 * 返回 null 表示可以用，否则返回被拒的原因。
 */
export function refuseLivePrefix(prefix) {
  const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const n = norm(prefix)
  const home = os.homedir()
  const nodeDir = path.dirname(process.execPath)
  const banned = [
    path.join(home, '.local'),
    path.join(home, 'dsh-node-rc8'),
    path.join(home, 'AppData', 'Roaming', 'npm'),
    path.join(home, '.npm-global'),
    // 当前 node 自己的安装树（含全局 node_modules：Windows 在 <node>\node_modules，POSIX 在 <node>/../lib/node_modules）
    path.resolve(nodeDir, '..'),
  ]
  for (const b of banned) {
    const nb = norm(b)
    if (n === nb || n.startsWith(nb + '/')) return `拒绝写入正在使用的 npm 树：${prefix}`
  }
  return null
}
