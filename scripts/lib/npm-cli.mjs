/**
 * 定位与当前 node 配套的 npm（不走「随便哪个 PATH npm」优先）。
 * 安装版网关把构建机的 node_modules/npm 放在 runtime/node.exe 旁，这里就能找到。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/** npm 的依赖安装脚本仍通过 PATH 执行 node；服务进程可能只有捆绑 runtime。 */
export function npmEnvironment({ env = process.env, execPath = process.execPath, platform = process.platform } = {}) {
  const result = { ...env }
  const windows = platform === 'win32'
  const paths = windows ? path.win32 : path.posix
  // Windows 环境变量名不区分大小写，不能同时传 Path 和 PATH 给子进程。
  const keys = Object.keys(result).filter((key) => windows ? key.toLowerCase() === 'path' : key === 'PATH').sort()
  const key = keys[0] ?? 'PATH'
  const inherited = result[key]
  for (const name of keys) delete result[name]
  result[key] = paths.dirname(execPath) + (inherited ? paths.delimiter + inherited : '')
  return result
}

export function npmInvocation() {
  // 优先用与当前 node 同一套的 npm-cli.js（不走 shell，Windows 下也稳）；找不到再退回 PATH 上的 npm
  const nodeDir = path.dirname(process.execPath)
  const cli = process.platform === 'win32' ? path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js') : path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (fs.existsSync(cli)) return { cmd: process.execPath, pre: [cli], shell: false }
  return process.platform === 'win32' ? { cmd: 'npm.cmd', pre: [], shell: true } : { cmd: 'npm', pre: [], shell: false }
}

/** 捆绑 npm-cli 或 PATH 上能找到 npm 才算有。 */
export function hasNpm() {
  const inv = npmInvocation()
  if (inv.pre.length) return true
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [inv.cmd], { encoding: 'utf8', windowsHide: true })
  return r.status === 0 && !!String(r.stdout ?? '').trim()
}
