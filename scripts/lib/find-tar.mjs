/**
 * Windows 10 1803+ 自带 bsdtar；找不到就抛错。
 * 从 bootstrap 抽出，供网关 prepare / 打包脚本引用，避免加载整份启动编排。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export function findTar() {
  if (process.platform === 'win32') {
    const sys = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    if (fs.existsSync(sys)) return sys
  }
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['tar'], { stdio: 'pipe', encoding: 'utf8' })
  if (r.status === 0 && r.stdout.trim()) return r.stdout.split(/\r?\n/)[0].trim()
  throw new Error('找不到 tar.exe（需要 Windows 10 1803 及以上，或自行安装 bsdtar）')
}
