/**
 * T11 NSIS 真机验证（隔离，不碰正式 profile）：
 * 1) 静默安装到沙箱目录（NSIS /D=，必须放最后且不能加引号）。
 *    注意：$LOCALAPPDATA 是 NSIS 内置常量，改环境变量无效；旧写法会装进正式
 *    %LOCALAPPDATA%\Programs\valimart-harness 并因 runAfterFinish 拉起正式客户端。
 *    /D= 仍会改写开始菜单快捷方式，装完必须拨回正式目录。
 * 2) 校验 resources/payload（payload.json buildId / 运行时 node / kernel.tar / 插件齐全）；
 * 3) 用临时 DSH_HOME + 临时 app-dir 启动安装版客户端（不同 userData，不跟正式实例抢锁）；
 * 4) 校验宿主 HTTP 就绪、Mixed 本机 API 可达；
 * 5) 只杀本脚本拉起的进程树。正式安装目录若已存在，用 --existing 跳过安装器。
 *
 * 用法：
 *   node scripts/verify-installer-nsis.mjs [installer.exe]
 *   node scripts/verify-installer-nsis.mjs --existing [installDir]
 * 缺省 installer = dist/valimart-harness-Setup-<最新 payload.json installerVersion>.exe
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const SANDBOX = `C:\\Users\\ethan\\.dsh-nsis-${STAMP}`
const DSH_HOME = path.join(SANDBOX, 'dsh-home')
const APP_DIR = path.join(SANDBOX, 'app-dir')
const OFFICIAL_DIR = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'valimart-harness')
const OFFICIAL_EXE = path.join(OFFICIAL_DIR, 'valimart harness.exe')
const SHORTCUT_NAME = 'valimart harness.lnk'

function officialShortcutPaths() {
  return [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', SHORTCUT_NAME),
    path.join(process.env.USERPROFILE || '', 'Desktop', SHORTCUT_NAME),
  ]
}

/** /D= 沙箱安装仍会改写开始菜单 .lnk；装完拨回正式客户端，避免下次自动更新打开旧沙箱。 */
function restoreOfficialShortcuts() {
  if (!fs.existsSync(OFFICIAL_EXE)) return
  const paths = officialShortcutPaths().map((p) => `'${p.replace(/'/g, "''")}'`).join(', ')
  const target = OFFICIAL_EXE.replace(/'/g, "''")
  const workDir = OFFICIAL_DIR.replace(/'/g, "''")
  const ps = [
    `$sh = New-Object -ComObject WScript.Shell`,
    `foreach ($p in @(${paths})) {`,
    `  if (Test-Path -LiteralPath $p) {`,
    `    $s = $sh.CreateShortcut($p)`,
    `    $s.TargetPath = '${target}'`,
    `    $s.WorkingDirectory = '${workDir}'`,
    `    $s.Save()`,
    `  }`,
    `}`,
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) console.log(`[verify] 恢复正式快捷方式失败: ${(result.stderr || result.stdout || '').trim()}`)
  else console.log('[verify] 已把开始菜单/桌面快捷方式拨回正式安装目录')
}
const PORT_LO = 3470
const PORT_HI = 3479
const cleanup = process.argv.includes('--cleanup')
const skipInstall = process.argv.includes('--existing')

const argvPos = process.argv.slice(2).filter((a) => !a.startsWith('--'))
let installer = argvPos[0]
let existingDir = skipInstall ? (argvPos[0] || OFFICIAL_DIR) : null

const built = JSON.parse(fs.readFileSync(path.join(root, 'build', 'payload', 'payload.json'), 'utf8'))
if (!skipInstall && !installer) {
  installer = path.join(root, 'dist', `valimart-harness-Setup-${built.installerVersion || built.version}.exe`)
}
if (!skipInstall && !fs.existsSync(installer)) {
  console.error(`[verify] 安装器不存在: ${installer}`)
  process.exit(1)
}
if (skipInstall && !fs.existsSync(existingDir)) {
  console.error(`[verify] --existing 目录不存在: ${existingDir}`)
  process.exit(1)
}

console.log(skipInstall
  ? `[verify] 跳过安装器，复查已装目录: ${existingDir}`
  : `[verify] 安装器: ${installer}`)

const results = []
let outBuf = ''
let payload = built
const assert = (label, ok, detail = null) => {
  results.push({ label, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== null && detail !== undefined ? `  [${typeof detail === 'string' ? detail : JSON.stringify(detail)}]` : ''}`)
  if (!ok) process.exitCode = 1
}

const sleep = (ms) => new Promise((r2) => setTimeout(r2, ms))

async function portAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(400) })
    return res.status > 0
  } catch {
    return false
  }
}

async function mixedApiStatus(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/desk/api/mixed/config`, {
      headers: { 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${port}` },
      signal: AbortSignal.timeout(800),
    })
    return res.status
  } catch {
    return 0
  }
}

async function busyPorts() {
  const ports = []
  for (let p = PORT_LO; p <= PORT_HI; p++) if (await portAlive(p)) ports.push(p)
  return ports
}

function writeEvidence(extra = {}) {
  const evidenceDir = path.join(root, 'docs', 'evidence', 'mixed')
  fs.mkdirSync(evidenceDir, { recursive: true })
  const evFile = path.join(evidenceDir, `installer-verify-${STAMP}.json`)
  fs.writeFileSync(evFile, JSON.stringify({
    case: skipInstall
      ? 'T11 NSIS 已装目录复查 + 临时 DSH_HOME 启动（不二次跑安装器）'
      : 'T11 NSIS 真机验证（/D 沙箱安装 + 临时 DSH_HOME，不改环境变量 LOCALAPPDATA）',
    installer: installer ? path.basename(installer) : null,
    skipInstall,
    sandbox: SANDBOX,
    buildId: payload.buildId,
    assertions: results,
    allPassed: results.length > 0 && results.every((a) => a.ok),
    tail: outBuf.slice(-2000),
    finishedAt: new Date().toISOString(),
    ...extra,
  }, null, 2))
  console.log(`\n证据: ${evFile}`)
  console.log(`全部通过: ${results.length > 0 && results.every((a) => a.ok)}`)
  return evFile
}

fs.mkdirSync(DSH_HOME, { recursive: true })
fs.mkdirSync(APP_DIR, { recursive: true })

let installDir
if (skipInstall) {
  installDir = existingDir
  assert('复查目录存在', fs.existsSync(installDir), installDir)
} else {
  installDir = path.join(SANDBOX, 'Programs', 'valimart-harness')
  fs.mkdirSync(installDir, { recursive: true })
  console.log(`\n== 静默安装（NSIS /D=${installDir}）`)
  // /D 必须最后、不能加引号。改 LOCALAPPDATA 环境变量对 NSIS 内置 $LOCALAPPDATA 无效。
  // --no-desktop-shortcut 只能挡住桌面；开始菜单仍会被改写，装完立刻把正式快捷方式拨回去。
  const bat = path.join(SANDBOX, 'install.bat')
  fs.writeFileSync(bat, `@echo off\r\n"${installer}" /S --no-desktop-shortcut /D=${installDir}\r\n`, { encoding: 'utf8' })
  const r = spawnSync(process.env.ComSpec, ['/c', bat], { stdio: 'inherit', windowsHide: true, timeout: 300_000 })
  assert('NSIS 静默安装退出 0', r.status === 0, { status: r.status })
  restoreOfficialShortcuts()
  const isolated = fs.existsSync(path.join(installDir, 'valimart harness.exe'))
  assert('安装落入 /D 沙箱（未写正式 Programs）', isolated, {
    sandboxExe: path.join(installDir, 'valimart harness.exe'),
    officialStill: OFFICIAL_DIR,
  })
  if (!isolated) {
    writeEvidence({ note: '隔离失败：安装器未写入 /D。不要把正式目录当成沙箱通过。' })
    process.exit(1)
  }
}

const exe = path.join(installDir, 'valimart harness.exe')
assert('主程序存在', fs.existsSync(exe), exe)

const payloadFile = path.join(installDir, 'resources', 'payload', 'payload.json')
assert('payload.json 存在', fs.existsSync(payloadFile), payloadFile)
if (fs.existsSync(payloadFile)) {
  payload = JSON.parse(fs.readFileSync(payloadFile, 'utf8'))
  assert('buildId 与本次构建一致', payload.buildId === built.buildId, { installed: payload.buildId, built: built.buildId })
  assert('版本一致', payload.version === built.version, { installed: payload.version, built: built.version })
}
assert('payload 自带 node 运行时', fs.existsSync(path.join(installDir, 'resources', 'payload', 'runtime', 'node.exe')))
assert('kernel.tar 存在', fs.existsSync(path.join(installDir, 'resources', 'payload', 'kernel.tar')))
assert('desk-host 插件（含 mixed）存在', fs.existsSync(path.join(installDir, 'resources', 'payload', 'plugins', 'desk-host', 'lib', 'mixed', 'store.js')))
assert('desk-ui 插件存在', fs.existsSync(path.join(installDir, 'resources', 'payload', 'plugins', 'desk-ui', 'lib', 'client.js')))

console.log(`\n== 启动安装版客户端（--dsh-home ${DSH_HOME}，--app-dir ${APP_DIR}）`)
const beforePorts = await busyPorts()
console.log(`  启动前已占用: ${beforePorts.join(', ') || '无'}`)

const child = spawn(exe, ['--dsh-home', DSH_HOME, '--app-dir', APP_DIR], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  cwd: installDir,
})
child.stdout.on('data', (d) => { outBuf += d.toString() })
child.stderr.on('data', (d) => { outBuf += d.toString() })
child.on('error', (e) => console.log(`[proc] 启动失败: ${e.message}`))
child.on('exit', (code) => console.log(`[proc] 退出 code=${code}`))

let readyPort = 0
let mixedStatus = 0
for (let i = 0; i < 120; i++) {
  await sleep(1000)
  if (child.exitCode !== null) break
  for (let p = PORT_LO; p <= PORT_HI; p++) {
    if (beforePorts.includes(p)) continue
    if (!(await portAlive(p))) continue
    const st = await mixedApiStatus(p)
    if (st === 401 || st === 200 || st === 403) {
      readyPort = p
      mixedStatus = st
      break
    }
  }
  if (readyPort) break
}
assert('客户端 HTTP 就绪（安装版 + 临时 DSH_HOME）', Boolean(readyPort), {
  port: readyPort || null,
  mixedStatus,
  beforePorts,
  out: outBuf.slice(-400),
})

if (readyPort) {
  assert('宿主 Mixed API 路由在线（401 未登录 / 200 已登录 / 403 同源校验，而非 404）', mixedStatus === 401 || mixedStatus === 200 || mixedStatus === 403, { status: mixedStatus, port: readyPort })
}

console.log('\n== 清理（只杀本脚本进程树，不卸载正式安装）')
try { execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore', windowsHide: true }) } catch { /* 可能已退出 */ }
await sleep(1000)
if (cleanup) {
  fs.rmSync(SANDBOX, { recursive: true, force: true })
  console.log(`沙箱已删除: ${SANDBOX}`)
} else {
  console.log(`沙箱保留供复查: ${SANDBOX}（node scripts/verify-installer-nsis.mjs --cleanup 或手动删除）`)
}

writeEvidence({ readyPort, installDir })
if (process.exitCode) process.exit(process.exitCode)
