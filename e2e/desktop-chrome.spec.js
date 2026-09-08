import { test, expect, _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { serveSessionImage } from '../plugins/desk-host/lib/session-image.js'
const electronBinary = path.resolve('desktop/node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
test.skip(!fs.existsSync(electronBinary), '需要已安装的桌面 Electron 依赖')

test('Electron：会话标题贴顶、操作可点击，标题可拖动，最大化无外围留白', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<html class="dk-desk-electron"><style>
      ${fs.readFileSync('plugins/desk-ui/src/client/styles.css', 'utf8')}
      .session-header { padding:12px 20px 0; }
      .session-header > :first-child {display:flex;align-items:center}
      .test_titleCluster {display:flex;flex:1;align-items:center;gap:10px;min-width:0}
      .test_headerUtilities {display:flex;flex:none;align-items:center;margin-left:20px}
      .test_headerActions {flex:none}
      .session-header [role=tablist] {height:28px;margin-top:4px}
    </style><body><div id="root"><div class="dk-frame" data-mode="chat" data-dsh-frame>
      <aside class="dk-col-sidebar" style="width:280px"></aside>
      <main class="dk-col-main"><div data-slot="conversation.session.header" style="display:contents">
        <header class="session-header"><div class="test_titleRow"><div class="test_titleCluster"><nav>会话标题</nav><div class="test_headerActions">标准模式</div></div><div class="test_headerUtilities"><div data-slot="conversation.session.header.utilities"><button id="utility" class="test_sessionLogButton"><span>Session 日志</span><svg width="12" height="12" aria-hidden="true"></svg></button></div></div></div>
          <div role="tablist"><button role="tab">对话</button><button role="tab">轨迹</button></div>
        </header></div></main></div></div>
      <header class="dk-titlebar"><div class="dk-titlebar-side"></div><div class="dk-titlebar-main">
        <div class="dk-titlebar-controls"><button class="dk-winbtn" aria-label="最大化">□</button></div>
      </div></header>
      <script>window.clicks=[]; document.addEventListener('click',e=>{const button=e.target.closest('button');if(button)window.clicks.push(button.textContent)});
      document.querySelector('.dk-winbtn').onclick=()=>window.deskShell.maximize();</script>
    </body></html>`)
  })
  let app
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    app = await electron.launch({ executablePath: electronBinary, args: [path.resolve('e2e/fixtures/desktop-chrome.cjs'), `http://127.0.0.1:${server.address().port}`] })
    const page = await app.firstWindow()
    await page.waitForLoadState()
    const verify = async () => {
      const geometry = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON()
        return { header: rect('.session-header'), row: rect('.session-header > div'), sidebar: rect('.dk-col-sidebar'), frame: rect('.dk-frame'), w: innerWidth, h: innerHeight }
      })
      expect(geometry.header.top).toBe(0)
      expect(geometry.row.top).toBe(8)
      expect(geometry.sidebar.left).toBe(0)
      expect(geometry.sidebar.top).toBe(0)
      expect(geometry.sidebar.bottom).toBe(geometry.h)
      expect(geometry.frame.right).toBe(geometry.w)
      expect(geometry.frame.bottom).toBe(geometry.h)
      const title = await page.locator('.test_titleCluster nav').boundingBox()
      const download = await page.locator('#utility').boundingBox()
      expect(download.x - title.x - title.width).toBeCloseTo(6, 1)
      expect(download.y + download.height / 2).toBeCloseTo(title.y + title.height / 2, 1)
      await page.getByRole('tab', { name: '轨迹' }).click()
      await page.getByRole('button', { name: 'Session 日志' }).click()
    }
    await verify()
    if (process.platform === 'win32') {
      const before = await app.evaluate(() => global.testWindow.getBounds())
      await page.mouse.move(500, 18)
      await page.mouse.down()
      await page.mouse.move(560, 58)
      await page.mouse.up()
      await expect.poll(() => app.evaluate(() => { const {x,y}=global.testWindow.getBounds();return {x,y} })).toEqual({x:before.x+60,y:before.y+40})
    }
    await app.evaluate(() => global.testWindow.showInactive())
    await page.getByRole('button', { name: '最大化' }).click()
    await expect.poll(() => app.evaluate(() => global.testWindow.isMaximized())).toBe(true)
    await verify()
    await page.getByRole('button', { name: '最大化' }).click()
    await expect.poll(() => app.evaluate(() => global.testWindow.isMaximized())).toBe(false)
    await verify()
    expect(await page.evaluate(() => window.clicks.filter(v => v === '轨迹'))).toHaveLength(3)
    expect(await page.evaluate(() => window.clicks.filter(v => v === 'Session 日志'))).toHaveLength(3)
  } finally {
    await app?.close()
    await new Promise(resolve => server.close(resolve))
  }
})

test('Electron：图片预览右键复制与文件定位，标题栏拖动产生窗口位移', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-chrome-'))
  const file = path.join(tmp, '图 (1).svg')
  fs.writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="red"/></svg>')
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname.endsWith('/image')) {
      try { return await serveSessionImage(req, res, { loggedIn: true, session: { header: { cwd: tmp } }, source: url.searchParams.get('path'), info: url.searchParams.get('info') === '1' }) }
      catch (e) { res.writeHead(e.status ?? 500); return res.end(e.message) }
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<html class="dk-desk-electron"><style>${fs.readFileSync('plugins/desk-ui/src/client/styles.css', 'utf8')}</style>
      <div class="dk-frame"><header class="dk-titlebar"><div class="dk-titlebar-side"></div><div class="dk-titlebar-main"><div class="dk-titlebar-controls"><button class="dk-winbtn">关闭</button></div></div></header>
      <aside class="dk-col-sidebar" style="width:280px"><div class="dk-brand">品牌<button>新会话</button></div></aside></div>
      <dialog><img src="/desk/api/sessions/one/image?path=${encodeURIComponent('图 (1).svg')}" /></dialog>`)
  })
  let app
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    app = await electron.launch({ executablePath: electronBinary, args: [path.resolve('e2e/fixtures/desktop-chrome.cjs'), `http://127.0.0.1:${server.address().port}`] })
    const page = await app.firstWindow()
    await page.waitForLoadState()
    const regions = await page.evaluate(() => {
      const region = (x, y) => getComputedStyle(document.elementFromPoint(x, y)).getPropertyValue('-webkit-app-region')
      return { title: region(500, 18), button: region(innerWidth - 23, 18), brand: region(30, 20) }
    })
    expect(regions).toEqual(process.platform === 'win32' ? { title: 'no-drag', button: 'no-drag', brand: 'no-drag' } : { title: 'drag', button: 'no-drag', brand: 'drag' })
    if (process.platform === 'win32') {
      const before = await app.evaluate(() => global.testWindow.getBounds())
      await page.mouse.move(500, 18)
      await page.mouse.down()
      await page.mouse.move(580, 68)
      await page.mouse.up()
      await expect.poll(() => app.evaluate(() => { const { x, y } = global.testWindow.getBounds(); return { x, y } })).toEqual({ x: before.x + 80, y: before.y + 50 })
      const after = await app.evaluate(() => global.testWindow.getBounds())
      await page.mouse.move(600, 100)
      expect(await app.evaluate(() => global.testWindow.getBounds())).toEqual(after)
      // Window buttons must remain clickable and must not start a move.
      await page.locator('.dk-winbtn').click()
      expect(await app.evaluate(() => global.testWindow.getBounds())).toEqual(after)
      await app.evaluate(() => { global.testWindow.showInactive(); global.testWindow.maximize() })
      await expect.poll(() => app.evaluate(() => global.testWindow.isMaximized())).toBe(true)
      await page.mouse.move(500, 18)
      await page.mouse.down()
      await page.mouse.move(600, 118)
      await page.mouse.up()
      await expect.poll(() => app.evaluate(() => global.testWindow.isMaximized())).toBe(false)
    }
    await page.evaluate(() => document.querySelector('dialog').showModal())
    await page.locator('dialog img').click({ button: 'right' })
    await expect.poll(() => app.evaluate(() => global.testMenu?.items.map((i) => i.label))).toEqual(['复制图片', '打开图片文件所在位置'])
    await app.evaluate(() => global.testMenu.items[0].click())
    await app.evaluate(() => global.testMenu.items[1].click())
    await expect.poll(() => app.evaluate(() => global.actions.revealed)).toEqual([fs.realpathSync(file)])
    const actions = await app.evaluate(() => global.actions)
    expect(actions.copied).toHaveLength(1)
    expect(actions.revealed).toEqual([fs.realpathSync(file)])
    expect(actions.errors).toEqual([])
  } finally {
    await app?.close()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
