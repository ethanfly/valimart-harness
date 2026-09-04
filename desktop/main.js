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
const { app, BrowserWindow, dialog, ipcMain, screen, shell } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

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
    fs.mkdirSync(path.dirname(file), { recursive: true })
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
async function waitHttp(url, timeoutMs) {
  const started = Date.now()
  for (;;) {
    try {
      const r = await fetch(url)
      if (r.ok || r.status < 500) return
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`内核 ${timeoutMs / 1000} 秒内没有就绪（${url}）`)
    await new Promise((r) => setTimeout(r, 300))
  }
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
ipcMain.on('desk:window-close', (event) => windowFrom(event)?.close())
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
      else if (ev.step === 'error') reject(new Error(ev.detail))
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
    child.on('error', reject)
    // close（而不是 exit）：此时 stdio 已全部读完，最后一行 ready 不会丢；再把没带换行的尾巴解析掉
    child.on('close', (code) => {
      bootstrapChild = null
      handleLine(buf)
      buf = ''
      if (code === 0 && ready) resolve(ready)
      else reject(new Error(`启动准备失败（退出码 ${code}）`))
    })
  })
}

// ---------- 内核 ----------
function startKernel(ready, port) {
  const child = spawn(nodeExe, [ready.kernelBin, '--profile', ready.profileName, '--no-open', '--port', String(port)], {
    cwd: appDir,
    env: { ...process.env, DSH_HOME: dshHome, DESK_APP_DIR: appDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d) => log.write('dsh', d))
  child.stderr.on('data', (d) => log.write('dsh:err', d))
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
let bootstrapChild = null
let kernel = null
let quitting = false

/** 只放行 http/https 到系统浏览器，其他协议一律丢弃。 */
function openExternal(u) {
  if (/^https?:/i.test(u)) shell.openExternal(u)
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
  mainWin.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith(url)) return { action: 'allow' }
    openExternal(u)
    return { action: 'deny' }
  })
  mainWin.webContents.on('will-navigate', (e, u) => {
    if (!u.startsWith(url)) {
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
  const leave = () => {
    if (attach) {
      quitting = true
      mainWin = null
      app.exit(0)
      return
    }
    shutdown(0)
  }
  mainWin.on('close', leave)
  mainWin.on('closed', () => {
    mainWin = null
    if (!attach) shutdown(0)
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
  try {
    await mainWin.loadURL(url)
  } catch (err) {
    if (quitting || !mainWin || mainWin.isDestroyed()) {
      log.write('app', `加载中关窗，忽略：${err && err.message ? err.message : err}`)
      return
    }
    throw err
  }
  log.write('app', `就绪 ${url}`)
}

async function main() {
  app.setAppUserModelId(APP_ID)
  log.write('app', `valimart harness ${app.getVersion()} packaged=${app.isPackaged} payload=${payloadDir} appDir=${appDir} dshHome=${dshHome}`)
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
  const url = `http://127.0.0.1:${port}/`
  await waitHttp(url, 60000)
  if (quitting) return
  await openMainWindow(url)
}

function shutdown(code) {
  if (quitting) return
  quitting = true
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
  if (splash && !splash.isDestroyed()) splash.hide()
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'valimart harness 无法启动',
    message: 'valimart harness 无法启动',
    detail: `${err.message}\n\n日志：${log.file}`,
    buttons: ['打开日志目录', '退出'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  if (response === 0) await shell.openPath(logDir)
  app.exit(1)
}

// Electron 自身状态（Chromium 缓存 / 单实例锁文件）也放进 appDir，运行时状态只落 ~/.company-desk 与 ~/.dsh；须在取锁之前设好
const electronDir = path.join(appDir, 'electron')
fs.mkdirSync(electronDir, { recursive: true })
app.setPath('userData', electronDir)
app.setPath('sessionData', electronDir)

app.on('window-all-closed', () => shutdown(0))
app.on('before-quit', () => {
  quitting = true
  killTree(bootstrapChild)
  killTree(kernel)
})
if (attachUrl) {
  // 开发附着：不要跟已安装的客户端抢单实例锁
  app.whenReady().then(main).catch(fatal)
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore()
      mainWin.focus()
    }
  })
  app.whenReady().then(main).catch(fatal)
}
