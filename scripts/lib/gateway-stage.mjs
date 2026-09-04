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
