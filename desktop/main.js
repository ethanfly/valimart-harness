/**
 * THE DIVA 桌面客户端（Electron 主进程）：只做窗口与进程编排，业务都在 dsh 内核 + 公司插件里。
 *
 * 启动：单实例锁 → 启动页 → 用随包 node.exe 跑 payload/scripts/lib/bootstrap.mjs --packaged（解内核 / 同步技能根 / 装 profile）
 *      → 选端口 → node.exe 起内核 → 等 HTTP 就绪 → 主窗口 loadURL。关窗 → taskkill 内核进程树 → 退出。
 * 参数（开发时）：--payload <dir>（默认 resources/payload）、--app-dir <dir>（默认 ~/.company-desk/app）、--dsh-home <dir>（默认 $DSH_HOME 或 ~/.dsh）
 *                 --url <http> 附着到已在跑的内核（跳过启动页与 payload）；--screenshot <png> 加载后截图（配合 --url 可截完退出）
 * 日志：~/.company-desk/logs/desktop.log（5 MB 滚动保留 3 份）；Electron 自身状态（userData）：<appDir>/electron
 */
'use strict'
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, screen, shell } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createDshWebUrlWatcher, hasLaunchToken, resolveDshWebUrl, sameWebOrigin } = require('./dsh-web-url.cjs')
const { closePromptToResponse, readDesktopPrefs, writeDesktopPrefs, resolveCloseChoice } = require('./prefs.cjs')
const { attachImageMenu } = require('./image-menu.cjs')
const { attachWindowDrag } = require('./window-drag.cjs')

const APP_ID = 'team.ethan.valimart-harness'
const args = process.argv
const argOf = (k, dflt) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] && !String(args[i + 1]).startsWith('-') ? args[i + 1] : dflt
}
const payloadDir = path.resolve(argOf('--payload', path.join(process.resourcesPath, 'payload')))
const appDir = path.resolve(argOf('--app-dir', path.join(os.homedir(), '.company-desk', 'app')))
const dshHome = path.resolve(argOf('--dsh-home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh')))
const attachUrl = argOf('--url')
const screenshotPath = argOf('--screenshot')
const logDir = path.join(os.homedir(), '.company-desk', 'logs')
const nodeExe = path.join(payloadDir, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')

// ---------- 日志 ----------
class Log {
  constructor(file) {
    this.file = file
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
    } catch {
      /* 日志目录建不起来（如 home 只读）时只降级为不落盘，不打断启动 */
    }
    this.rotate()
  }
  rotate() {
    try {
      if (fs.statSync(this.file).size <= 5 * 1024 * 1024) return
      for (let i = 2; i >= 1; i--) if (fs.existsSync(`${this.file}.${i}`)) fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`)
      fs.renameSync(this.file, `${this.file}.1`)
    } catch {
      /* 不存在 */
    }
  }
  write(tag, text) {
    const line = `${new Date().toISOString()} [${tag}] ${String(text).replace(/\s+$/, '')}\n`
    try {
      fs.appendFileSync(this.file, line)
    } catch {
      /* 磁盘问题不影响运行 */
    }
    if (!app.isPackaged) process.stdout.write(line)
  }
}
const log = new Log(path.join(logDir, 'desktop.log'))

// ---------- 小工具（与 scripts/lib/bootstrap.mjs 同逻辑；主进程是 CJS，不直接 import 那个 ESM）----------
async function findFreePort(preferred, tries) {
  const probe = (port) =>
    new Promise((resolve) => {
      const srv = net.createServer()
      srv.unref()
      srv.once('error', () => resolve(false))
      srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => srv.close(() => resolve(true)))
    })
  for (let p = preferred; p < preferred + tries; p++) if (await probe(p)) return p
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen({ port: 0, host: '127.0.0.1' }, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else child.kill('SIGTERM')
  } catch {
    /* 已退出 */
  }
}

// ---------- 自定义标题栏（frameless + 渲染进程自绘；不走 titleBarOverlay，避免整条原生色带）----------
function windowFrom(event) {
  return BrowserWindow.fromWebContents(event.sender)
}
function windowState(win) {
  if (!win || win.isDestroyed()) return { maximized: false, focused: false, inset: 0 }
  let inset = 0
  if (process.platform === 'win32' && win.isMaximized()) {
    try {
      const { workArea } = screen.getDisplayMatching(win.getBounds())
      const b = win.getBounds()
      inset = Math.max(0, Math.round(Math.max(b.height - workArea.height, b.width - workArea.width) / 2))
    } catch {
      inset = 0
    }
  }
  return { maximized: win.isMaximized(), focused: win.isFocused(), inset }
}
function sendWindowState(win) {
  if (!win || win.isDestroyed()) return
  win.webContents.send('desk:window-state', windowState(win))
}
ipcMain.on('desk:window-minimize', (event) => windowFrom(event)?.minimize())
ipcMain.on('desk:window-maximize', (event) => {
  const win = windowFrom(event)
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
})
ipcMain.on('desk:window-close', (event) => {
  const win = windowFrom(event)
  if (win) requestClose(win)
})
ipcMain.handle('desk:prefs-get', () => readDesktopPrefs())
ipcMain.handle('desk:prefs-set', (_event, patch) => {
  if (!patch || typeof patch !== 'object') return readDesktopPrefs()
  return writeDesktopPrefs({ closeAction: patch.closeAction })
})
ipcMain.handle('desk:window-state', (event) => windowState(windowFrom(event)))
ipcMain.on('desk:window-bg', (event, color) => {
  const win = windowFrom(event)
  if (!win || typeof color !== 'string' || color.length > 64) return
  if (!/^(#|rgb|hsl|hwb)/i.test(color.trim())) return
  win.setBackgroundColor(color.trim())
})
ipcMain.on('desk:open-external', (_event, u) => {
  if (typeof u === 'string') openExternal(u)
})
function attachWindowChrome(win) {
  const relay = () => sendWindowState(win)
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur']) win.on(ev, relay)
  win.webContents.on('did-finish-load', relay)
}

// ---------- 启动页 ----------
function createSplash() {
  const win = new BrowserWindow({ width: 420, height: 260, frame: false, resizable: false, show: false, backgroundColor: '#ffffff', webPreferences: { contextIsolation: true, sandbox: true } })
  win.loadFile(path.join(__dirname, 'splash.html'))
  win.once('ready-to-show', () => win.show())
  return win
}
function setStatus(text) {
  log.write('status', text)
  if (splash && !splash.isDestroyed()) splash.webContents.executeJavaScript(`window.__setStatus && window.__setStatus(${JSON.stringify(text)})`).catch(() => {})
}

// ---------- bootstrap（准备内核 / profile）----------
const STEP_LABEL = { extract: '解压内核', kernel: '校验内核补丁', profile: '安装工作台配置', log: '' }
function describe(ev) {
  const label = STEP_LABEL[ev.step] ?? ev.step
  if (ev.status === 'skip') return `${label}：已就位`
  return ev.detail ? `${label}：${ev.detail}` : `${label}…`
}
function runBootstrap() {
  return new Promise((resolve, reject) => {
    const script = path.join(payloadDir, 'scripts', 'lib', 'bootstrap.mjs')
    const child = spawn(nodeExe, [script, '--packaged', '--payload', payloadDir, '--app-dir', appDir, '--dsh-home', dshHome], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    bootstrapChild = child
    let ready = null
    let buf = ''
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killTree(child)
      reject(err)
    }
    const win = (ev) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ev)
    }
    // 总超时：解压/装内核卡住时不能永远停在 splash（fatal 兜底也会把 bootstrap 进程一起杀）
    const timer = setTimeout(() => fail(new Error('启动准备超过 3 分钟仍未完成，已中止')), 180_000)
    const handleLine = (raw) => {
      const line = raw.trim()
      if (!line) return
      log.write('bootstrap', line)
      let ev
      try {
        ev = JSON.parse(line)
      } catch {
        return
      }
      if (!ev || typeof ev !== 'object') return
      if (ev.step === 'ready') ready = ev
      else if (ev.step === 'error') fail(new Error(ev.detail))
      else setStatus(describe(ev))
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        handleLine(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => log.write('bootstrap:err', d))
    child.on('error', (err) => fail(err))
    // close（而不是 exit）：此时 stdio 已全部读完，最后一行 ready 不会丢；再把没带换行的尾巴解析掉
    child.on('close', (code) => {
      bootstrapChild = null
      handleLine(buf)
      buf = ''
      if (code === 0 && ready) win(ready)
      else fail(new Error(`启动准备失败（退出码 ${code}）`))
    })
  })
}

// ---------- 内核 ----------
function startKernel(ready, port) {
  const child = spawn(nodeExe, [ready.kernelBin, '--profile', ready.profileName, '--no-open', '--port', String(port)], {
    cwd: appDir,
    env: { ...process.env, DSH_HOME: dshHome, DESK_APP_DIR: appDir, DESK_PAYLOAD_DIR: payloadDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const webUrl = createDshWebUrlWatcher()
  child.webUrl = webUrl
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d) => {
    log.write('dsh', d)
    webUrl.feed(d)
  })
  child.stderr.on('data', (d) => {
    log.write('dsh:err', d)
    webUrl.feed(d)
  })
  child.on('error', (err) => fatal(new Error(`内核进程无法启动：${err.message}`)))
  child.on('exit', (code, signal) => {
    log.write('dsh', `exit code=${code} signal=${signal}`)
    if (!quitting) fatal(new Error(`内核进程意外退出（${code ?? signal}）`))
  })
  return child
}

// ---------- 主流程 ----------
let splash = null
let mainWin = null
let tray = null
let bootstrapChild = null
let kernel = null
let quitting = false
let closeBusy = false
let forceClose = false
let shutdownStarted = false
/** 主窗口已经正常打开过（决定崩溃对话框文案与「重新打开」按钮） */
let appLive = false

/** 只放行 http/https 到系统浏览器，其他协议一律丢弃。 */
function openExternal(u) {
  if (/^https?:/i.test(u)) shell.openExternal(u)
}

function trayImage() {
  const ico = path.join(__dirname, 'build', 'icon.ico')
  const png = path.join(__dirname, 'build', 'icon.png')
  if (process.platform === 'win32' && fs.existsSync(ico)) return nativeImage.createFromPath(ico)
  const img = nativeImage.createFromPath(png)
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 })
}

function showMainWindow() {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.show()
    if (mainWin.isMinimized()) mainWin.restore()
    mainWin.focus()
    return
  }
  if (splash && !splash.isDestroyed()) {
    splash.show()
    splash.focus()
  }
}

function showClosePrompt(parent) {
  return new Promise((resolve) => {
    const prompt = new BrowserWindow({
      parent,
      modal: true,
      width: 420,
      height: 268,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      frame: false,
      show: false,
      backgroundColor: '#f6f4ef',
      roundedCorners: true,
      hasShadow: true,
      icon: path.join(__dirname, 'build', 'icon.png'),
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        preload: path.join(__dirname, 'close-prompt-preload.js'),
      },
    })
    prompt.setMenu(null)
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      ipcMain.removeListener('desk:close-prompt', onReply)
      if (!prompt.isDestroyed()) prompt.close()
      resolve(payload)
    }
    const onReply = (event, payload) => {
      if (event.sender !== prompt.webContents) return
      const action = payload && typeof payload.action === 'string' ? payload.action : 'cancel'
      finish({ response: closePromptToResponse(action), checkboxChecked: Boolean(payload && payload.remember) })
    }
    ipcMain.on('desk:close-prompt', onReply)
    prompt.on('closed', () => finish({ response: 2, checkboxChecked: false }))
    prompt.once('ready-to-show', () => prompt.show())
    prompt.loadFile(path.join(__dirname, 'close-prompt.html')).catch((err) => {
      log.write('app', `关窗提示加载失败：${err && err.message ? err.message : err}`)
      finish({ response: 2, checkboxChecked: false })
    })
  })
}

function hideToTray() {
  if (!mainWin || mainWin.isDestroyed()) return
  if (!tray) {
    tray = new Tray(trayImage())
    tray.setToolTip('valimart harness')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开 valimart harness', click: () => showMainWindow() },
        { type: 'separator' },
        { label: '退出', click: () => quitApp() },
      ]),
    )
    tray.on('click', () => showMainWindow())
  }
  mainWin.hide()
  log.write('app', '后台运行（托盘）')
}

function destroyTray() {
  if (!tray) return
  tray.destroy()
  tray = null
}

function quitApp() {
  if (shutdownStarted) return
  forceClose = true
  quitting = true
  destroyTray()
  if (mainWin && !mainWin.isDestroyed()) mainWin.close()
  else shutdown(0)
}

async function requestClose(win) {
  if (!win || win.isDestroyed() || quitting || closeBusy) return
  const decided = resolveCloseChoice(readDesktopPrefs().closeAction)
  if (decided.do === 'minimize') return hideToTray()
  if (decided.do === 'quit') return quitApp()
  closeBusy = true
  try {
    const { response, checkboxChecked } = await showClosePrompt(win)
    const next = resolveCloseChoice('ask', { response, remember: checkboxChecked })
    if (next.save) writeDesktopPrefs({ closeAction: next.save })
    if (next.do === 'minimize') hideToTray()
    else if (next.do === 'quit') quitApp()
  } finally {
    closeBusy = false
  }
}

async function openMainWindow(url, { attach = false } = {}) {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'valimart harness',
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, 'build', 'icon.png'),
    frame: false,
    titleBarStyle: 'hidden',
    roundedCorners: true,
    hasShadow: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  mainWin.setMenu(null)
  attachWindowChrome(mainWin)
  attachImageMenu(mainWin, url, { Menu, shell, dialog })
  if (process.platform === 'win32') attachWindowDrag(mainWin, url, { ipcMain })
  mainWin.webContents.setWindowOpenHandler(({ url: u }) => {
    if (sameWebOrigin(u, url)) return { action: 'allow' }
    openExternal(u)
    return { action: 'deny' }
  })
  mainWin.webContents.on('will-navigate', (e, u) => {
    if (!sameWebOrigin(u, url)) {
      e.preventDefault()
      openExternal(u)
    }
  })
  mainWin.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F12') {
      mainWin.webContents.toggleDevTools()
      e.preventDefault()
    } else if (input.key === 'F5') {
      mainWin.webContents.reload()
      e.preventDefault()
    }
  })
  mainWin.on('page-title-updated', (e) => e.preventDefault())
  mainWin.once('ready-to-show', () => {
    mainWin.show()
    if (splash && !splash.isDestroyed()) splash.close()
    splash = null
  })
  mainWin.on('close', (e) => {
    if (attach) {
      forceClose = true
      quitting = true
      return
    }
    if (forceClose) return
    e.preventDefault()
    requestClose(mainWin)
  })
  mainWin.on('closed', () => {
    mainWin = null
    if (attach) {
      app.exit(0)
      return
    }
    shutdown(0)
  })
  if (screenshotPath) {
    mainWin.webContents.on('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 2200))
      if (!mainWin || mainWin.isDestroyed()) return
      let chrome = null
      try {
        chrome = await mainWin.webContents.executeJavaScript(`(() => {
          const bar = document.querySelector('.dk-titlebar')
          const btns = [...document.querySelectorAll('.dk-winbtn')].map((b) => b.getAttribute('aria-label'))
          return {
            hasTitlebar: Boolean(bar),
            fallback: Boolean(document.getElementById('dk-shell-fallback')),
            winbtn: btns,
            electron: document.documentElement.classList.contains('dk-desk-electron'),
            svgMarks: document.querySelectorAll('svg.dk-logo-mark').length,
            pngMasks: [...document.querySelectorAll('.dk-logo-mark, .dk-logo-img')].filter((el) => getComputedStyle(el).webkitMaskImage && getComputedStyle(el).webkitMaskImage !== 'none').length,
          }
        })()`)
      } catch (err) {
        chrome = { error: String(err && err.message ? err.message : err) }
      }
      const img = await mainWin.capturePage()
      const dest = path.resolve(screenshotPath)
      const before = windowState(mainWin)
      await mainWin.webContents.executeJavaScript(`document.querySelector('.dk-winbtn[aria-label="最大化"], .dk-winbtn[aria-label="还原"]')?.click()`)
      await new Promise((r) => setTimeout(r, 250))
      const afterClick = windowState(mainWin)
      fs.writeFileSync(dest, img.toPNG())
      fs.writeFileSync(dest.replace(/\.png$/i, '.json'), `${JSON.stringify({ chrome, before, afterClick }, null, 2)}\n`)
      log.write('app', `截图 ${dest} chrome=${JSON.stringify(chrome)} maximized ${before.maximized}->${afterClick.maximized}`)
      if (attach) {
        quitting = true
        app.exit(0)
      }
    })
  }
  let authReload = false
  mainWin.webContents.on('did-finish-load', () => {
    const tokenUrl = kernel?.webUrl?.get?.()
    if (authReload || !tokenUrl || !hasLaunchToken(tokenUrl) || hasLaunchToken(url)) return
    mainWin.webContents
      .executeJavaScript('document.body ? document.body.innerText : ""')
      .then((text) => {
        if (authReload || !/authentication required/i.test(String(text || ''))) return
        authReload = true
        log.write('app', `页面要求令牌，改开 ${tokenUrl}`)
        return mainWin.loadURL(tokenUrl)
      })
      .catch((err) => log.write('app', `令牌重开失败：${err && err.message ? err.message : err}`))
  })
  try {
    await mainWin.loadURL(url)
  } catch (err) {
    if (quitting || !mainWin || mainWin.isDestroyed()) {
      log.write('app', `加载中关窗，忽略：${err && err.message ? err.message : err}`)
      return
    }
    throw err
  }
  appLive = true
  log.write('app', `就绪 ${url}`)
}

async function loadClientUpdateMod() {
  const packaged = path.join(payloadDir, 'scripts', 'lib', 'client-update.mjs')
  const fallback = path.join(__dirname, '..', 'scripts', 'lib', 'client-update.mjs')
  const file = fs.existsSync(packaged) ? packaged : fallback
  return import(pathToFileURL(file).href)
}

async function loadHashMod() {
  const packaged = path.join(payloadDir, 'scripts', 'lib', 'kernel-update.mjs')
  const fallback = path.join(__dirname, '..', 'scripts', 'lib', 'kernel-update.mjs')
  const file = fs.existsSync(packaged) ? packaged : fallback
  return import(pathToFileURL(file).href)
}

async function maybeApplyPendingClient() {
  if (!app.isPackaged) return false
  try {
    const mod = await loadClientUpdateMod()
    const { hashFile } = await loadHashMod()
    const result = mod.applyPendingClientUpdate({
      pendingDir: path.join(appDir, 'client-next'),
      payloadDir,
      packaged: true,
      hashFile,
      spawn,
      afterSpawn: ({ buildId }) => {
        log.write('app', `应用客户端更新 ${buildId}，退出后由安装器在更新完成时重新打开客户端`)
        setTimeout(() => app.exit(0), 400)
      },
    })
    if (!result.applied && (result.reason === 'already-current' || result.reason === 'hash-mismatch')) {
      log.write('app', `丢弃客户端 pending：${result.reason}`)
    }
    return result.applied
  } catch (err) {
    log.write('app', `客户端更新未应用：${err && err.message ? err.message : err}`)
    return false
  }
}

async function main() {
  app.setAppUserModelId(APP_ID)
  log.write('app', `valimart harness ${app.getVersion()} packaged=${app.isPackaged} payload=${payloadDir} appDir=${appDir} dshHome=${dshHome}`)
  if (await maybeApplyPendingClient()) return
  if (attachUrl) {
    if (!/^https?:\/\//i.test(attachUrl)) throw new Error('`--url` 必须是 http(s) 地址')
    await openMainWindow(attachUrl, { attach: true })
    return
  }
  if (!fs.existsSync(nodeExe)) throw new Error(`缺少运行时 ${nodeExe}`)
  if (!fs.existsSync(path.join(payloadDir, 'payload.json'))) throw new Error(`缺少 ${path.join(payloadDir, 'payload.json')}（开发时先 node scripts/build-payload.mjs）`)
  splash = createSplash()
  setStatus('正在准备工作台…')
  const ready = await runBootstrap()
  if (quitting) return
  const port = await findFreePort(3470, 10)
  if (quitting) return
  setStatus(`启动内核（端口 ${port}）…`)
  kernel = startKernel(ready, port)
  let url = await resolveDshWebUrl({ port, getPrinted: () => kernel.webUrl.get(), timeoutMs: 60000 })
  const printed = kernel.webUrl.get()
  if (printed && hasLaunchToken(printed)) url = printed
  log.write('app', `打开 ${url}${printed && printed !== url ? `（stdout ${printed}）` : ''}`)
  if (quitting) return
  await openMainWindow(url)
}

function shutdown(code) {
  if (shutdownStarted) return
  shutdownStarted = true
  forceClose = true
  quitting = true
  destroyTray()
  // killTree 是同步 taskkill（约 0.4 s）。shutdown 挂在主窗口 close 上，若在此同步杀进程，
  // 窗口要等 taskkill 返回才会消失，点 × 会有可感知的滞留；先让窗口销毁完再杀
  setTimeout(() => {
    killTree(bootstrapChild)
    killTree(kernel)
  }, 50)
  // 触发时再杀一次：关启动页那一刻 main() 可能正卡在 await 上，内核在这 200 ms 里才被 spawn
  setTimeout(() => {
    killTree(kernel)
    app.exit(code)
  }, 200)
}

async function fatal(err) {
  if (quitting) {
    // 用户已在关闭（如启动中关掉启动页，bootstrap 被杀后 reject 到这里）：不是故障，不弹框
    log.write('app', `退出中，忽略：${err && err.message ? err.message : err}`)
    return
  }
  log.write('app', `FATAL ${err && err.stack ? err.stack : err}`)
  quitting = true
  killTree(kernel)
  killTree(bootstrapChild)
  if (splash && !splash.isDestroyed()) splash.hide()
  const live = appLive && mainWin && !mainWin.isDestroyed()
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: live ? 'valimart harness 运行中断' : 'valimart harness 无法启动',
    message: live ? '内核进程意外退出，工作台已关闭。' : 'valimart harness 无法启动',
    detail: `${err.message}\n\n日志：${log.file}`,
    buttons: live ? ['重新打开', '打开日志目录', '退出'] : ['打开日志目录', '退出'],
    defaultId: live ? 0 : 1,
    cancelId: live ? 2 : 1,
    noLink: true,
  })
  if (live && response === 0) {
    app.relaunch()
    app.exit(0)
  } else {
    if ((live && response === 1) || (!live && response === 0)) await shell.openPath(logDir)
    app.exit(1)
  }
}

// Electron 自身状态（Chromium 缓存 / 单实例锁文件）也放进 appDir，运行时状态只落 ~/.company-desk 与 ~/.dsh；须在取锁之前设好
const electronDir = path.join(appDir, 'electron')
try {
  fs.mkdirSync(electronDir, { recursive: true })
  app.setPath('userData', electronDir)
  app.setPath('sessionData', electronDir)
} catch {
  // appDir 不可写（home 只读 / 磁盘满 / 路径被占用）：退回 Electron 默认 userData，不让原生错误框打断启动
}

app.on('window-all-closed', () => shutdown(0))
app.on('before-quit', () => {
  forceClose = true
  quitting = true
  destroyTray()
  killTree(bootstrapChild)
  killTree(kernel)
})
if (attachUrl) {
  // 开发附着：不要跟已安装的客户端抢单实例锁
  app.whenReady().then(main).catch(fatal)
} else if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.on('second-instance', () => {
    log.write('app', '已有实例在运行，转到前台')
    showMainWindow()
  })
  app.whenReady().then(main).catch(fatal)
}
