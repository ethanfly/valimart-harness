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
 * 启动前会自动：确认内核已安装（否则跑 install-kernel.mjs：npm 装锁定版本 + 打补丁）、profile 已安装（否则安装/刷新，
 * 与 setup-profile.mjs 同一套逻辑）、客户端 bundle 是最新的（否则跑 build-client.mjs）。编排逻辑在 scripts/lib/bootstrap.mjs。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defaultDshHome, defaultPrefix } from './kernel/locate.mjs'
import { ensureBundle, ensureKernelDev, ensureProfile, killTree, profileNeedsSetup, readGatewayUrl, spawnClient, waitHttp } from './lib/bootstrap.mjs'
import { createDshWebUrlWatcher, hasLaunchToken, resolveDshWebUrl } from './lib/dsh-web-url.mjs'

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
const bareUrl = `http://127.0.0.1:${port}/`
let url = bareUrl

const log = (msg) => console.log(`[launch] ${msg}`)
const die = (msg) => {
  console.error(`[launch] ${msg}`)
  process.exit(1)
}

// ---------- 0. 内核 ----------
let kernel
try {
  kernel = ensureKernelDev({ prefix, dshHome, log })
} catch (err) {
  die(err.message)
}
const dshBin = kernel.bin

// ---------- 1. profile ----------
const profileDir = path.join(dshHome, 'profiles', 'desk')
const repoPatch = path.join(root, 'profile', 'cordis.patch.yml')
if (profileNeedsSetup({ profileDir, patchFile: repoPatch })) {
  log('安装/刷新 desk profile …')
  try {
    ensureProfile({ profileName: 'desk', dshHome, root, pluginsDir: path.join(root, 'plugins'), patchFile: repoPatch, kernel, log: (m) => log(`[profile] ${m}`) })
  } catch (err) {
    die(`setup-profile 失败：${err.message}`)
  }
}

// ---------- 2. 客户端 bundle ----------
try {
  ensureBundle({ log })
} catch (err) {
  die(err.message)
}

// ---------- 3. 网关地址 ----------
const gatewayUrl = (argOf('--gateway') ?? process.env.DESK_GATEWAY_URL ?? readGatewayUrl(repoPatch)).replace(/\/+$/, '')

const children = []
let shuttingDown = false
function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) killTree(c)
  setTimeout(() => process.exit(code), 200)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

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
  try {
    await waitHttp(health, { label: '网关' })
  } catch (err) {
    die(err.message)
  }
  log('网关就绪')
}

// ---------- 5. 客户端（dsh desk profile）----------
async function startClient() {
  log(`启动客户端 ${bareUrl} …`)
  const webUrl = createDshWebUrlWatcher()
  const child = spawnClient({ kernelBin: dshBin, profileName: 'desk', port, dshHome, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d) => {
    process.stdout.write(d)
    webUrl.feed(d)
  })
  child.stderr.on('data', (d) => {
    process.stderr.write(d)
    webUrl.feed(d)
  })
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[launch] 客户端退出（${code}）`)
      shutdown(code ?? 1)
    }
  })
  try {
    url = await resolveDshWebUrl({ port, getPrinted: () => webUrl.get(), timeoutMs: 60000 })
    const printed = webUrl.get()
    if (printed && hasLaunchToken(printed)) url = printed
  } catch (err) {
    die(err.message)
  }
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
log(`valimart harness 已就绪：${url}（网关 ${gatewayUrl}）。Ctrl+C 退出。`)
