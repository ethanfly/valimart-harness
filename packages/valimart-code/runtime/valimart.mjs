#!/usr/bin/env node
/**
 * 打包后的 valimart 命令。1.0 起宿主是原生二进制（dist/valimart-code-<版本>-<平台>/valimart），
 * 不再 import 它的 JS 入口：启动器准备好登录态与设置后 spawn 宿主，退出码透传。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { main, locateBinary } from '../lib/launcher.mjs'

const runtimeDir = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(runtimeDir, '..', '..', 'package.json'), 'utf8'))

const argv = process.argv.slice(2)
const exit = await main(argv, {
  runtimeDir,
  version: pkg.version,
  qwenVersion: pkg.valimart?.qwenCode ?? '?',
})
if (exit !== false) process.exit(exit ?? 0)
