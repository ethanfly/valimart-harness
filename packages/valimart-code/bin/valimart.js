#!/usr/bin/env node
/**
 * npm 全局安装的入口。真正的程序在可选依赖 valimart-code-<平台> 里
 * （bin/valimart 包装 + valimart-host）。这里只按当前平台转过去。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

export const PLATFORM_PACKAGES = {
  'linux-x64': 'valimart-code-linux-x64',
  'darwin-arm64': 'valimart-code-darwin-arm64',
  'win32-x64': 'valimart-code-windows-x64',
}

const key = `${process.platform}-${process.arch}`
const name = PLATFORM_PACKAGES[key]
if (!name) {
  console.error(`valimart code 没有 ${process.platform}/${process.arch} 的安装包。支持 linux-x64、darwin-arm64、windows-x64。`)
  process.exit(1)
}

let pkgJson
try {
  pkgJson = require.resolve(`${name}/package.json`)
} catch {
  console.error(`没有装上 ${name}。请重新执行 npm install -g valimart-code，不要加 --omit=optional。`)
  process.exit(1)
}

const bin = path.join(path.dirname(pkgJson), 'bin', process.platform === 'win32' ? 'valimart.cmd' : 'valimart')
const child = spawn(bin, process.argv.slice(2), {
  stdio: 'inherit',
  windowsHide: true,
  // Windows 上 .cmd 必须经 shell 才能启动。
  shell: process.platform === 'win32',
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
