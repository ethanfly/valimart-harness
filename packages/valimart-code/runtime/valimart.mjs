#!/usr/bin/env node
/**
 * 打包后的 valimart 命令（package.json 的 bin）。本文件在包内 valimart/ 目录，Qwen Code 的 cli-entry.js 在上一级。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../lib/launcher.mjs'

const runtimeDir = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(runtimeDir, '..', 'package.json'), 'utf8'))

await main(process.argv.slice(2), {
  qwenEntry: path.join(runtimeDir, '..', 'cli-entry.js'),
  runtimeDir,
  version: pkg.version,
  qwenVersion: pkg.valimart?.qwenCode ?? '?',
})
