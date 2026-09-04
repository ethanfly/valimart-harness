/**
 * THE DIVA 启动器：一条命令拉起「公司网关（可选）+ dsh desk profile + 桌面窗口」。
 *
 *   node scripts/launch.mjs                         # 只起客户端（浏览器打开 http://127.0.0.1:3470）
 *   node scripts/launch.mjs --desktop               # 客户端 + 独立桌面窗口（Edge/Chrome 应用模式，关窗即退出）
 *   node scripts/launch.mjs --with-server --desktop # 网关 + 客户端 + 桌面窗口（单机演示）
 *
 * 其他参数：
 *   --port <n>          客户端端口（默认 3470）
 *   --gateway <url>     覆盖网关地址（默认取 profile/cordis.patch.yml 里的 gatewayUrl）
 *   --no-open           不自动打开浏览器
 *   --prefix <dir>      dsh 内核前缀（默认 ~/.company-desk/kernel，或 DESK_KERNEL_PREFIX）
 *   --dsh-home <dir>    dsh 数据目录（默认 ~/.dsh，或 DSH_HOME）
 *
 * 启动前会自动：确认内核已安装（否则跑 install-kernel.mjs：npm 装锁定版本 + 打补丁）、profile 已安装（否则跑
 * setup-profile.mjs）、客户端 bundle 是最新的（否则跑 build-client.mjs）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defaultDshHome, defaultPrefix, locateKernel } from './kernel/locate.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const has = (k) => args.includes(k)
const argOf = (k, dflt) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}

const prefix = path.resolve(argOf('--prefix', defaultPrefix()))
const dshHome = path.resolve(argOf('--dsh-home', defaultDshHome()))
const port = Number(argOf('--port', process.env.DESK_PORT ?? '3470'))
const withServer = has('--with-server')
const desktop = has('--desktop')
const noOpen = has('--no-open')
const url = `http://127.0.0.1:${port}/`

const log = (msg) => console.log(`[launch] ${msg}`)
const die = (msg) => {
  console.error(`[launch] ${msg}`)
  process.exit(1)
}

// ---------- 0. 内核 ----------
let kernel = locateKernel(prefix)
if (!kernel) {
  log(`${prefix} 里还没有 dsh 内核，先安装（需要网络）…`)
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'install-kernel.mjs'), '--prefix', prefix, '--dsh-home', dshHome], { stdio: 'inherit' })
  if (r.status !== 0) die('内核安装失败')
  kernel = locateKernel(prefix)
  if (!kernel) die(`内核安装后仍找不到：${prefix}`)
}
const dshBin = kernel.bin

// ---------- 1. profile ----------
const profileDir = path.join(dshHome, 'profiles', 'desk')
const profilePatch = path.join(profileDir, 'cordis.patch.yml')
const repoPatch = path.join(root, 'profile', 'cordis.patch.yml')
const needSetup =
  !fs.existsSync(profilePatch) ||
  !fs.existsSync(path.join(profileDir, 'node_modules', '@company-desk', 'desk-ui')) ||
  fs.readFileSync(profilePatch, 'utf8') !== fs.readFileSync(repoPatch, 'utf8')
if (needSetup) {
  log('安装/刷新 desk profile …')
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'setup-profile.mjs'), '--prefix', prefix, '--dsh-home', dshHome], { stdio: 'inherit' })
  if (r.status !== 0) die('setup-profile 失败')
}

// ---------- 2. 客户端 bundle ----------
const bundle = path.join(root, 'plugins', 'desk-ui', 'lib', 'client.js')
const srcDir = path.join(root, 'plugins', 'desk-ui', 'src')
const newestSrc = (dir) => {
  let t = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    t = Math.max(t, e.isDirectory() ? newestSrc(p) : fs.statSync(p).mtimeMs)
  }
  return t
}
if (!fs.existsSync(bundle) || fs.statSync(bundle).mtimeMs < newestSrc(srcDir)) {
  log('构建客户端 bundle …')
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-client.mjs')], { stdio: 'inherit' })
  if (r.status !== 0) die('build-client 失败')
}

// ---------- 3. 网关地址 ----------
const gatewayUrl = (argOf('--gateway') ?? process.env.DESK_GATEWAY_URL ?? /gatewayUrl:\s*'([^']+)'/.exec(fs.readFileSync(repoPatch, 'utf8'))?.[1] ?? 'http://127.0.0.1:8790').replace(/\/+$/, '')

const children = []
let shuttingDown = false
function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
      else c.kill('SIGTERM')
    } catch {
      /* 已退出 */
    }
  }
  setTimeout(() => process.exit(code), 200)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

async function waitHttp(u, { timeoutMs = 30000, label = u } = {}) {
  const started = Date.now()
  for (;;) {
    try {
      const r = await fetch(u)
      if (r.ok || r.status < 500) return true
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - started > timeoutMs) die(`${label} ${timeoutMs / 1000}s 内没有就绪`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

// ---------- 4. 网关 ----------
async function ensureGateway() {
  const health = `${gatewayUrl}/health`
  const alive = await fetch(health).then((r) => r.ok).catch(() => false)
  if (alive) {
    log(`网关已在运行：${gatewayUrl}`)
    return
  }
  if (!withServer) {
    log(`提示：网关 ${gatewayUrl} 未响应；客户端会显示离线并等待登录。用 --with-server 可在本机一起启动。`)
    return
  }
  log(`启动网关 ${gatewayUrl} …`)
  const env = { ...process.env }
  try {
    const u = new URL(gatewayUrl)
    env.DESK_GATEWAY_PORT ??= u.port || '80'
    env.DESK_GATEWAY_HOST ??= u.hostname
  } catch {
    /* 用 config.json 的默认 */
  }
  const child = spawn(process.execPath, [path.join(root, 'server', 'src', 'index.js')], { cwd: root, stdio: 'inherit', env })
  children.push(child)
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[launch] 网关退出（${code}），一起收工`)
      shutdown(code ?? 1)
    }
  })
  await waitHttp(health, { label: '网关' })
  log('网关就绪')
}

// ---------- 5. 客户端（dsh desk profile）----------
function startClient() {
  log(`启动客户端 ${url} …`)
  const child = spawn(process.execPath, [dshBin, '--profile', 'desk', '--no-open', '--port', String(port)], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, DSH_HOME: dshHome },
  })
  children.push(child)
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[launch] 客户端退出（${code}）`)
      shutdown(code ?? 1)
    }
  })
  return waitHttp(url, { label: '客户端', timeoutMs: 60000 })
}

// ---------- 6. 桌面窗口 ----------
function findBrowser() {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
        : ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'chromium', 'chromium-browser']
  for (const c of candidates) {
    if (path.isAbsolute(c)) {
      if (fs.existsSync(c)) return c
    } else {
      const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [c], { stdio: 'ignore' })
      if (r.status === 0) return c
    }
  }
  return null
}

function openDesktopWindow() {
  const browser = findBrowser()
  if (!browser) {
    log('没找到 Edge/Chrome，退回默认浏览器打开')
    openDefault()
    return
  }
  const dataDir = path.join(dshHome, 'desk', 'window-profile')
  fs.mkdirSync(dataDir, { recursive: true })
  const child = spawn(
    browser,
    [`--app=${url}`, `--user-data-dir=${dataDir}`, '--window-size=1280,820', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate,msEdgeSidebarV2', '--disable-session-crashed-bubble', '--disable-infobars'],
    { stdio: 'ignore', detached: false },
  )
  children.push(child)
  log(`桌面窗口已打开（${path.basename(browser)} 应用模式）；关掉窗口即退出`)
  child.on('exit', () => {
    if (!shuttingDown) {
      log('桌面窗口已关闭，收工')
      shutdown(0)
    }
  })
}

function openDefault() {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref()
  } catch {
    log(`请手动打开 ${url}`)
  }
}

await ensureGateway()
await startClient()
if (desktop) openDesktopWindow()
else if (!noOpen) openDefault()
log(`THE DIVA 已就绪：${url}（网关 ${gatewayUrl}）。Ctrl+C 退出。`)
