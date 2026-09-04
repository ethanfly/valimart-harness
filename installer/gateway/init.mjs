/**
 * 网关安装脚本 —— NSIS 安装 / 升级时用随包 node.exe 调用，幂等：
 *   node init.mjs <INSTDIR>
 *   1) 建 %ProgramData%\THE DIVA Gateway\{data,logs}
 *   2) <INSTDIR>\server\config.local.json 不存在才写：host 0.0.0.0 / port 8790 / publicUrl http://<主机名>:8790 / dataDir
 *      （server/src/config.js 只认 server/ 目录下的 config.local.json）
 *   3) 渲染 <INSTDIR>\service\TheDivaGateway.xml（每次重写，路径以 INSTDIR 为准）
 * 测试用环境变量：DIVA_PROGRAMDATA 覆盖 ProgramData，DIVA_COMPUTERNAME 覆盖主机名。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PRODUCT_DIR = 'THE DIVA Gateway'
export const DEFAULT_PORT = 8790

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function init(instDir, { programData = process.env.DIVA_PROGRAMDATA || process.env.ProgramData || 'C:\\ProgramData', computerName = process.env.DIVA_COMPUTERNAME || process.env.COMPUTERNAME || os.hostname() } = {}) {
  const dataRoot = path.join(programData, PRODUCT_DIR)
  const dataDir = path.join(dataRoot, 'data')
  const logDir = path.join(dataRoot, 'logs')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(logDir, { recursive: true })

  const configFile = path.join(instDir, 'server', 'config.local.json')
  let wroteConfig = false
  if (!fs.existsSync(configFile)) {
    const cfg = { host: '0.0.0.0', port: DEFAULT_PORT, publicUrl: `http://${computerName.toLowerCase()}:${DEFAULT_PORT}`, dataDir }
    fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + '\n')
    wroteConfig = true
  }
  let port = DEFAULT_PORT
  let publicUrl = `http://${computerName.toLowerCase()}:${DEFAULT_PORT}`
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    port = Number(cfg.port ?? DEFAULT_PORT)
    publicUrl = cfg.publicUrl ?? `http://${computerName.toLowerCase()}:${port}`
  } catch (err) {
    throw new Error(`无法解析 ${configFile}: ${err.message}`)
  }

  const vars = { INSTDIR: instDir, DATA_DIR: dataDir, LOG_DIR: logDir }
  const tpl = fs.readFileSync(path.join(instDir, 'service', 'TheDivaGateway.xml.tpl'), 'utf8')
  const xml = tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`模板里有未知占位符 {{${k}}}`)
    return xmlEscape(vars[k])
  })
  fs.writeFileSync(path.join(instDir, 'service', 'TheDivaGateway.xml'), xml)
  return { dataDir, logDir, configFile, wroteConfig, port, publicUrl }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const instDir = process.argv[2]
  if (!instDir) {
    console.error('用法：node init.mjs <INSTDIR>')
    process.exit(64)
  }
  try {
    const r = init(path.resolve(instDir))
    console.log(`[init] 数据目录 ${r.dataDir}`)
    console.log(`[init] 配置 ${r.configFile}${r.wroteConfig ? '（新建）' : '（保留现有）'}`)
    console.log(`[init] 端口 ${r.port}  管理页 ${r.publicUrl}/admin`)
  } catch (err) {
    console.error(`[init] ${err.message}`)
    process.exit(1)
  }
}
