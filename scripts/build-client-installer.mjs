/**
 * 用根 package.json 的版本号跑 desktop/ 里的 electron-builder（NSIS，按用户安装）。
 *   node scripts/build-client-installer.mjs
 * 前提：build/payload/ 已由 build-payload.mjs 生成；desktop/node_modules 已安装（npm --prefix desktop install --allow-scripts=electron）。
 * 镜像：ELECTRON_MIRROR、ELECTRON_BUILDER_BINARIES_MIRROR（见 README）；未设置时默认走 npmmirror（GitHub 直连在国内常失败）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktop = path.join(root, 'desktop')
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const die = (m) => {
  console.error(`[dist:client] ${m}`)
  process.exit(1)
}

if (!fs.existsSync(path.join(root, 'build', 'payload', 'payload.json'))) die('缺 build/payload/，先跑 node scripts/build-payload.mjs')
const cli = path.join(desktop, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
if (!fs.existsSync(cli)) die('缺 desktop/node_modules，先跑 npm --prefix desktop install --allow-scripts=electron')

process.env.ELECTRON_MIRROR ??= 'https://npmmirror.com/mirrors/electron/'
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??= 'https://npmmirror.com/mirrors/electron-builder-binaries/'

console.log(`[dist:client] electron-builder --win nsis  version=${version}`)
const r = spawnSync(process.execPath, [cli, '--win', 'nsis', `--config.extraMetadata.version=${version}`], { cwd: desktop, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } })
if (r.status !== 0) die(`electron-builder 退出码 ${r.status}`)
const outFile = path.join(root, 'dist', `THE-DIVA-Setup-${version}.exe`)
if (!fs.existsSync(outFile)) die(`没找到产物 ${outFile}`)
console.log(`[dist:client] ${outFile} (${(fs.statSync(outFile).size / 1024 / 1024).toFixed(1)} MB)`)
