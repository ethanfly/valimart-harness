#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [command] = process.argv.slice(2)

if (command === '--marketplace-path') {
  console.log(packageRoot)
  process.exit(0)
}

if (command === 'install') {
  const result = spawnSync('codex', ['plugin', 'marketplace', 'add', packageRoot], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
  const installed = spawnSync('codex', ['plugin', 'add', 'valimart-desk@valimart-harness-codex'], { stdio: 'inherit' })
  process.exit(installed.status ?? 1)
}

if (command === '--help' || command === 'help' || command === undefined) {
  console.log([
    '用法：',
    '  codex-valimart-desk install        注册本地 marketplace 并安装 Codex 插件',
    '  codex-valimart-desk login [URL] [账号]',
    '  codex-valimart-desk status | sync | discover | task [ID]',
    '  codex-valimart-desk --marketplace-path',
  ].join('\n'))
  process.exit(command === undefined ? 2 : 0)
}

const cli = path.join(packageRoot, 'scripts/cli.mjs')
if (!fs.existsSync(cli)) {
  console.error(`安装包损坏：找不到 ${cli}`)
  process.exit(1)
}
const result = spawnSync(process.execPath, [cli, command, ...process.argv.slice(3)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
