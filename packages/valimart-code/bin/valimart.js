#!/usr/bin/env node
/**
 * npm 全局安装的入口。Linux / macOS 的程序在可选依赖 valimart-code-<平台> 里，直接转过去。
 * Windows 的平台包只是占位，第一次运行时从 GitHub Release 下载同版本 zip（见 windows-runtime.mjs）。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultCacheRoot, ensureWindowsRuntime } from './windows-runtime.mjs'

const require = createRequire(import.meta.url)

export const PLATFORM_PACKAGES = {
  'linux-x64': 'valimart-code-linux-x64',
  'darwin-arm64': 'valimart-code-darwin-arm64',
  'win32-x64': 'valimart-code-windows-x64',
}

function packageDir(name) {
  try {
    return path.dirname(require.resolve(`${name}/package.json`))
  } catch {
    console.error(`没有装上 ${name}。请重新执行 npm install -g valimart-code，不要加 --omit=optional。`)
    process.exit(1)
  }
}

function run(bin, args) {
  const child = spawn(bin, args, {
    stdio: 'inherit',
    windowsHide: true,
    // Windows 上 .cmd 必须经 shell 才能启动。
    shell: process.platform === 'win32',
  })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 1)
  })
}

async function main() {
  const key = `${process.platform}-${process.arch}`
  const name = PLATFORM_PACKAGES[key]
  if (!name) {
    console.error(`valimart code 没有 ${process.platform}/${process.arch} 的安装包。支持 linux-x64、darwin-arm64、windows-x64。`)
    process.exit(1)
  }
  const dir = packageDir(name)

  if (process.platform === 'win32') {
    const { version } = require(path.join(dir, 'package.json'))
    const bin = await ensureWindowsRuntime({
      version,
      stubDir: dir,
      cacheRoot: defaultCacheRoot(),
      log: (m) => console.error(m),
    }).catch((err) => {
      console.error(err.message)
      process.exit(1)
    })
    run(bin, process.argv.slice(2))
    return
  }

  run(path.join(dir, 'bin', 'valimart'), process.argv.slice(2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
