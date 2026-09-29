/**
 * 读取本机当前运行的内核版本（仅用于界面展示）。
 * 内核不再自动更新：客户端随包内置内核，升级走整包替换。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function resolveAppDir() {
  return process.env.DESK_APP_DIR ?? path.join(os.homedir(), '.company-desk', 'app')
}

/** 优先读当前 dsh 启动入口所属包，避免开发版显示安装版的内核版本。 */
export function readLocalKernelVersion(appDir = resolveAppDir(), { entryFile = process.argv[1] } = {}) {
  if (entryFile) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.resolve(path.dirname(entryFile), '..', 'package.json'), 'utf8'))
      if (manifest.name === '@deepseek-ai/dsh' && manifest.version) return manifest.version
    } catch {
      /* 非 dsh 入口（测试、管理脚本）仍按安装目录查找。 */
    }
  }
  const pkgs = [
    path.join(appDir, 'kernel', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    path.join(appDir, 'kernel', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    path.join(os.homedir(), '.company-desk', 'kernel', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    path.join(os.homedir(), '.company-desk', 'kernel', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ]
  for (const pkg of pkgs) {
    try {
      const v = JSON.parse(fs.readFileSync(pkg, 'utf8')).version
      if (v) return v
    } catch {
      /* 下一候选 */
    }
  }
  return null
}
