/**
 * Linux 网关安装：由 install.sh 用随包 runtime/bin/node 调用，幂等。
 *   node init-linux.mjs <INSTDIR> [--state DIR] [--logs DIR] [--user NAME]
 * 测试用：DIVA_STATE / DIVA_LOGS / DIVA_COMPUTERNAME / DIVA_GATEWAY_USER
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_PORT = 8790
export const DEFAULT_USER = 'thediva-gateway'
export const DEFAULT_STATE = '/var/lib/valimart-harness-gateway'
export const DEFAULT_LOGS = '/var/log/valimart-harness-gateway'

function argOf(argv, key, dflt) {
  const i = argv.indexOf(key)
  return i >= 0 && argv[i + 1] && !String(argv[i + 1]).startsWith('-') ? argv[i + 1] : dflt
}

export function initLinux(
  instDir,
  {
    stateRoot = process.env.DIVA_STATE || DEFAULT_STATE,
    logRoot = process.env.DIVA_LOGS || DEFAULT_LOGS,
    computerName = process.env.DIVA_COMPUTERNAME || os.hostname(),
    userName = process.env.DIVA_GATEWAY_USER || DEFAULT_USER,
  } = {},
) {
  const toPosix = (p) => path.resolve(p).replaceAll('\\', '/')
  const dataDir = path.join(stateRoot, 'data')
  const logDir = path.resolve(logRoot)
  const root = path.resolve(instDir)
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(logDir, { recursive: true })

  const configFile = path.join(instDir, 'server', 'config.local.json')
  let wroteConfig = false
  if (!fs.existsSync(configFile)) {
    const cfg = {
      host: '0.0.0.0',
      port: DEFAULT_PORT,
      publicUrl: `http://${computerName.toLowerCase()}:${DEFAULT_PORT}`,
      dataDir,
      seedAdmin: false,
      seedUsers: [],
      seedDriveSamples: false,
      packaged: true,
    }
    fs.writeFileSync(configFile, `${JSON.stringify(cfg, null, 2)}\n`)
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

  const vars = {
    INSTDIR: toPosix(root),
    DATA_DIR: toPosix(dataDir),
    LOG_DIR: toPosix(logDir),
    USER: userName,
    NODE: `${toPosix(root)}/runtime/bin/node`,
    INDEX: `${toPosix(root)}/server/src/index.js`,
  }
  const tpl = fs.readFileSync(path.join(instDir, 'service', 'TheDivaGateway.service.tpl'), 'utf8')
  const unit = tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`模板里有未知占位符 {{${k}}}`)
    return vars[k]
  })
  if (unit.includes('{{')) throw new Error('systemd 单元仍有未替换占位符')
  fs.writeFileSync(path.join(instDir, 'service', 'TheDivaGateway.service'), unit.replaceAll('\r\n', '\n'))
  return { dataDir, logDir, configFile, wroteConfig, port, publicUrl, userName, unitFile: path.join(instDir, 'service', 'TheDivaGateway.service') }
}

function isMainModule() {
  if (!process.argv[1]) return false
  const entry = path.resolve(process.argv[1])
  const self = fileURLToPath(import.meta.url)
  try {
    return fs.realpathSync.native(entry) === fs.realpathSync.native(self)
  } catch {
    return entry === self
  }
}

if (isMainModule()) {
  const instDir = process.argv[2]
  if (!instDir || instDir.startsWith('-')) {
    console.error('用法：node init-linux.mjs <INSTDIR> [--state DIR] [--logs DIR] [--user NAME]')
    process.exit(64)
  }
  const argv = process.argv.slice(2)
  try {
    const r = initLinux(path.resolve(instDir), {
      stateRoot: argOf(argv, '--state', process.env.DIVA_STATE || DEFAULT_STATE),
      logRoot: argOf(argv, '--logs', process.env.DIVA_LOGS || DEFAULT_LOGS),
      userName: argOf(argv, '--user', process.env.DIVA_GATEWAY_USER || DEFAULT_USER),
    })
    console.log(`[init] 数据目录 ${r.dataDir}`)
    console.log(`[init] 配置 ${r.configFile}${r.wroteConfig ? '（新建）' : '（保留现有）'}`)
    console.log(`[init] 端口 ${r.port}  管理页 ${r.publicUrl}/admin`)
    console.log(`[init] systemd ${r.unitFile}`)
  } catch (err) {
    console.error(`[init] ${err.message}`)
    process.exit(1)
  }
}
