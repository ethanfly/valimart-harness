/**
 * 出网关安装包：暂存 build/gateway/ → makensis installer/gateway.nsi → dist/THE-DIVA-Gateway-Setup-<ver>.exe
 *   node scripts/build-gateway-installer.mjs
 * makensis 来源：MAKENSIS 环境变量 → electron-builder 缓存（%LOCALAPPDATA%\electron-builder\Cache\nsis-<ver>\nsis-<ver>-<随机后缀>\Bin\makensis.exe，跑过 dist:client 就有）→ PATH。
 * WinSW 按 installer/pins.json 下载到 build/cache/ 并校验 SHA256（下载不了就把文件手动放到那里）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertGatewayStageClean, stageGatewayApp } from './lib/gateway-stage.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const pins = JSON.parse(fs.readFileSync(path.join(root, 'installer', 'pins.json'), 'utf8'))
const stage = path.join(root, 'build', 'gateway')
const cache = path.join(root, 'build', 'cache')
const dist = path.join(root, 'dist')
const log = (m) => console.log(`[dist:gateway] ${m}`)
const die = (m) => {
  console.error(`[dist:gateway] ${m}`)
  process.exit(1)
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

async function ensureWinsw() {
  const pin = pins.winsw
  fs.mkdirSync(cache, { recursive: true })
  const file = path.join(cache, `WinSW-${pin.version}.exe`)
  if (fs.existsSync(file) && sha256(file) === pin.sha256) return file
  log(`下载 WinSW ${pin.version} ← ${pin.url}`)
  let body
  try {
    const res = await fetch(pin.url, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) die(`下载失败：HTTP ${res.status}。可手动下载后放到 ${file}`)
    body = Buffer.from(await res.arrayBuffer())
  } catch (err) {
    die(`下载失败：${err.cause?.message ?? err.message}。可手动下载后放到 ${file}`)
  }
  fs.writeFileSync(file, body)
  const got = sha256(file)
  if (got !== pin.sha256) {
    fs.unlinkSync(file)
    die(`WinSW SHA256 不匹配：期望 ${pin.sha256}，得到 ${got}`)
  }
  return file
}

function findMakensis() {
  if (process.env.MAKENSIS) {
    if (fs.existsSync(process.env.MAKENSIS)) return process.env.MAKENSIS
    die(`MAKENSIS=${process.env.MAKENSIS} 不存在`)
  }
  // electron-builder 缓存：Cache\nsis-3.0.4.1\nsis-3.0.4.1-<随机后缀>\Bin\makensis.exe（后缀每次下载不同，不能写死；根目录下同名的 makensis.exe 是 2.5 KB 的壳，不用）
  const cacheRoot = path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache')
  if (process.env.LOCALAPPDATA && fs.existsSync(cacheRoot)) {
    const found = []
    for (const d1 of fs.readdirSync(cacheRoot).filter((n) => /^nsis-\d/i.test(n))) {
      const p1 = path.join(cacheRoot, d1)
      if (!fs.statSync(p1).isDirectory()) continue
      for (const d2 of ['.', ...fs.readdirSync(p1)]) {
        const p = path.join(p1, d2, 'Bin', 'makensis.exe')
        if (fs.existsSync(p)) found.push(p)
      }
    }
    if (found.length > 0) return found.sort().at(-1)
  }
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['makensis'], { stdio: 'pipe', encoding: 'utf8' })
  if (r.status === 0 && r.stdout.trim()) return r.stdout.split(/\r?\n/)[0].trim()
  die('找不到 makensis.exe：先跑 npm run dist:client（electron-builder 会把 NSIS 下载到 %LOCALAPPDATA%\\electron-builder\\Cache\\nsis-*），或安装 NSIS 3 并设置 MAKENSIS 环境变量')
}

// 1. 暂存
fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(path.join(stage, 'runtime'), { recursive: true })
fs.mkdirSync(path.join(stage, 'service'), { recursive: true })
fs.copyFileSync(process.execPath, path.join(stage, 'runtime', 'node.exe'))
stageGatewayApp(root, stage, { version, die })
const npmSrc = path.join(path.dirname(process.execPath), 'node_modules', 'npm')
if (fs.existsSync(npmSrc)) {
  log('复制构建机 npm → runtime/node_modules/npm')
  fs.cpSync(npmSrc, path.join(stage, 'runtime', 'node_modules', 'npm'), { recursive: true })
} else {
  log('构建机 process.execPath 旁没有 node_modules/npm，安装版 /prepare 将返回 501 npm_missing')
}
fs.copyFileSync(path.join(root, 'installer', 'gateway', 'init.mjs'), path.join(stage, 'service', 'init.mjs'))
fs.copyFileSync(path.join(root, 'installer', 'gateway', 'TheDivaGateway.xml.tpl'), path.join(stage, 'service', 'TheDivaGateway.xml.tpl'))
fs.copyFileSync(await ensureWinsw(), path.join(stage, 'service', 'TheDivaGateway.exe'))
fs.writeFileSync(
  path.join(stage, 'README.txt'),
  [
    `valimart harness 公司网关 ${version}`,
    '',
    '服务：TheDivaGateway（services.msc 里可启停；命令行：service\\TheDivaGateway.exe start|stop|restart|status）',
    '配置：server\\config.local.json（host / port / publicUrl / dataDir / company / quota …，改完重启服务；升级不覆盖）',
    '数据：%ProgramData%\\valimart harness Gateway\\data（账号、令牌、任务、账本、通道凭据、公司盘）；日志：%ProgramData%\\valimart harness Gateway\\logs（TheDivaGateway.out.log / .err.log / .wrapper.log）',
    '权限：安装时把 %ProgramData%\\valimart harness Gateway 的 ACL 收紧为仅 SYSTEM 与 Administrators 完全控制（服务以 LocalSystem 运行；普通用户读不到账号 / 令牌 / 凭据）。',
    '卸载：保留 %ProgramData%\\valimart harness Gateway，并把 server\\config.local.json 备份为该目录下的 config.local.json.bak；重装后复制回 server\\ 再重启服务即可恢复端口 / publicUrl / 密钥。',
    '上游模型密钥（三种方式都能跨升级保留）：',
    '  1) 管理员在客户端「设置 → 同事 → 模型通道」接入，凭据存 data\\gateway.sqlite；',
    '  2) 写进 server\\config.local.json：{ "upstreams": { "deepseek": { "apiKey": "sk-…" } } }（键路径 upstreams.<上游id>.apiKey，id 见 config.json）；',
    '  3) 机器级环境变量，变量名即 config.json 里该上游的 apiKeyEnv（DeepSeek 为 DEEPSEEK_API_KEY）：管理员命令行 setx /M DEEPSEEK_API_KEY sk-…，或 系统属性 → 环境变量 → 系统变量；服务重启（service\\TheDivaGateway.exe restart）后生效。',
    '  注意：service\\TheDivaGateway.xml 每次安装 / 升级都由 init.mjs 按模板重新生成，手改（包括加 <env>）会丢，请勿手改。',
    '搜索密钥（AnySearch，可选）：管理页「模型 → 搜索密钥」粘贴 as_sk_… 保存（推荐，存服务端库、页面不回显）；或 server\\config.local.json 写 { "search": { "anysearch": { "apiKey": "as_sk_…" } } }，或机器级环境变量 ANYSEARCH_API_KEY。员工登录时客户端自动取回，不配则用匿名额度。',
    '端口改了要同步改防火墙规则「valimart harness Gateway」。',
    '管理页：http://<本机名>:8790/admin（首次打开引导设置公司名与初始管理员，没有演示账号）',
    '首次启动不播种任何账号或示例文件（安装包 config.json 与 config.local.json 均为 seedAdmin:false、seedUsers:[]、seedDriveSamples:false；服务 NODE_ENV=production）。打开管理页或客户端完成引导。',
    '',
    `运行时：node ${process.version}；服务封装：WinSW ${pins.winsw.version}（MIT）`,
  ].join('\r\n') + '\r\n',
)
assertGatewayStageClean(stage, { die })
log(`暂存 ${stage}`)

// 2. makensis
fs.mkdirSync(dist, { recursive: true })
const outFile = path.join(dist, `valimart-harness-Gateway-Setup-${version}.exe`)
const icon = path.join(root, 'desktop', 'build', 'icon.ico')
const makensis = findMakensis()
log(`makensis: ${makensis}`)
const nsisArgs = ['/INPUTCHARSET', 'UTF8', `/DVERSION=${version}`, `/DSTAGE=${stage}`, `/DOUTFILE=${outFile}`]
if (fs.existsSync(icon)) nsisArgs.push(`/DICON=${icon}`)
nsisArgs.push(path.join(root, 'installer', 'gateway.nsi'))
const r = spawnSync(makensis, nsisArgs, { stdio: 'inherit' })
if (r.status !== 0) die(`makensis 退出码 ${r.status}`)
if (!fs.existsSync(outFile)) die(`没找到产物 ${outFile}`)
log(`${outFile} (${(fs.statSync(outFile).size / 1024 / 1024).toFixed(1)} MB)`)
