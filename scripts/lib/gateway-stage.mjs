/**
 * 网关安装包暂存：把开发 config.json 收成生产模板，并断言不把开发 data/ 打进去。
 */
import fs from 'node:fs'
import path from 'node:path'
import { toProductionConfig } from '../../server/src/config.js'

/** 拷 server/src（含子目录，如 oauth-providers）。 */
export function copyServerSrc(repoRoot, stageServerDir) {
  const src = path.join(repoRoot, 'server', 'src')
  const dst = path.join(stageServerDir, 'src')
  fs.cpSync(src, dst, { recursive: true })
}

export function writeStagedGatewayConfig(repoRoot, stageServerDir) {
  const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'server', 'config.json'), 'utf8'))
  const prod = toProductionConfig(raw)
  fs.mkdirSync(stageServerDir, { recursive: true })
  fs.writeFileSync(path.join(stageServerDir, 'config.json'), JSON.stringify(prod, null, 2) + '\n')
  return prod
}

export const GATEWAY_KERNEL_FILES = ['patches.mjs', 'locate.mjs', 'pin.json']
export const GATEWAY_LIB_FILES = ['kernel-update.mjs', 'kernel-prepare.mjs', 'payload.mjs', 'npm-cli.mjs', 'find-tar.mjs', 'lan-protocol.mjs', 'client-update.mjs', 'model-input.mjs']
export const GATEWAY_BRAND_FILES = ['valimart-mark.png', 'valimart-wordmark.png']

/** 拷网关业务文件（不含 Windows node.exe / WinSW，也不含 Linux runtime）。 */
export function stageGatewayApp(repoRoot, stage, { version, die = (m) => { throw new Error(m) } } = {}) {
  const ver = version ?? JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version
  fs.mkdirSync(path.join(stage, 'server'), { recursive: true })
  copyServerSrc(repoRoot, path.join(stage, 'server'))
  writeStagedGatewayConfig(repoRoot, path.join(stage, 'server'))
  const skillSrc = path.join(repoRoot, 'server', 'skills')
  if (fs.existsSync(skillSrc)) fs.cpSync(skillSrc, path.join(stage, 'server', 'skills'), { recursive: true })
  fs.writeFileSync(path.join(stage, 'server', 'package.json'), `${JSON.stringify({ name: 'the-diva-gateway', version: ver, private: true, type: 'module' }, null, 2)}\n`)
  const brandSrc = path.join(repoRoot, 'plugins', 'desk-ui', 'src', 'client', 'assets')
  const brandDst = path.join(stage, 'plugins', 'desk-ui', 'src', 'client', 'assets')
  fs.mkdirSync(brandDst, { recursive: true })
  for (const f of GATEWAY_BRAND_FILES) {
    const src = path.join(brandSrc, f)
    if (!fs.existsSync(src)) die(`缺少品牌图 ${src}`)
    fs.copyFileSync(src, path.join(brandDst, f))
  }
  fs.mkdirSync(path.join(stage, 'scripts', 'kernel'), { recursive: true })
  fs.mkdirSync(path.join(stage, 'scripts', 'lib'), { recursive: true })
  for (const f of GATEWAY_KERNEL_FILES) fs.copyFileSync(path.join(repoRoot, 'scripts', 'kernel', f), path.join(stage, 'scripts', 'kernel', f))
  for (const f of GATEWAY_LIB_FILES) fs.copyFileSync(path.join(repoRoot, 'scripts', 'lib', f), path.join(stage, 'scripts', 'lib', f))
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'backup-gateway.mjs'), path.join(stage, 'scripts', 'backup-gateway.mjs'))
  return { version: ver }
}

export function assertGatewayStageClean(stageDir, { die = (m) => { throw new Error(m) } } = {}) {
  const dataDir = path.join(stageDir, 'server', 'data')
  if (fs.existsSync(dataDir)) die(`暂存里不能带开发 data 目录：${dataDir}`)
  const local = path.join(stageDir, 'server', 'config.local.json')
  if (fs.existsSync(local)) die(`暂存里不能带 config.local.json（安装时由 init.mjs 生成）：${local}`)
  const cfgFile = path.join(stageDir, 'server', 'config.json')
  if (!fs.existsSync(cfgFile)) die(`暂存缺少 ${cfgFile}`)
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  if (cfg.seedAdmin !== false) die('生产 config.json 必须 seedAdmin: false')
  if (!Array.isArray(cfg.seedUsers) || cfg.seedUsers.length !== 0) die('生产 config.json 必须 seedUsers: []')
  if (cfg.seedDriveSamples !== false) die('生产 config.json 必须 seedDriveSamples: false')
  if (cfg.upstreams?.mock) die('生产 config.json 不能带 mock 上游')
  if (cfg.packaged !== true) die('生产 config.json 必须 packaged: true')
  return cfg
}
