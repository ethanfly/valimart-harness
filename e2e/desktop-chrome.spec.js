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
      <aside class="dk-col-sidebar" style="width:280px"><div class="dk-brand"><span>品牌</span><div class="dk-row"><button class="dk-iconbtn" type="button">新会话</button><button class="dk-iconbtn" type="button">收起侧边栏</button></div></div></aside>
      <main class="dk-col-main"><div data-slot="conversation.session.header" style="display:contents">
        <header class="session-header"><div class="test_titleRow"><div class="test_titleCluster"><nav>会话标题</nav><div class="test_headerActions">标准模式</div></div></div>
          <div role="tablist"><button role="tab">对话</button><button role="tab">轨迹</button></div>
        </header></div></main></div></div>
      <header class="dk-titlebar"><div class="dk-titlebar-side"></div><div class="dk-titlebar-main"></div>
        <div class="dk-titlebar-controls"><button class="dk-winbtn" aria-label="最大化">□</button></div>
      </header>
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
      expect(title.y + title.height / 2).toBeLessThan(40)
      await page.getByRole('tab', { name: '轨迹' }).click()
    }
    await verify()
    const sessionDrag = await page.evaluate(() => {
      const el = document.elementFromPoint(500, 18)
      return getComputedStyle(el).getPropertyValue('-webkit-app-region')
    })
    expect(sessionDrag).toBe('drag')
    const brandHit = await page.evaluate(() => {
      const button = document.querySelector('.dk-brand .dk-iconbtn')
      const r = button.getBoundingClientRect()
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return el instanceof Element && el.closest('.dk-iconbtn') !== null
    })
    expect(brandHit).toBe(true)
    await page.getByRole('button', { name: '新会话' }).click()
    await page.getByRole('button', { name: '收起侧边栏' }).click()
    await app.evaluate(() => global.testWindow.showInactive())
    await page.getByRole('button', { name: '最大化' }).click()
    await expect.poll(() => app.evaluate(() => global.testWindow.isMaximized())).toBe(true)
    await verify()
    await page.getByRole('button', { name: '最大化' }).click()
    await expect.poll(() => app.evaluate(() => global.testWindow.isMaximized())).toBe(false)
    await verify()
    expect(await page.evaluate(() => window.clicks.filter(v => v === '轨迹'))).toHaveLength(3)
  } finally {
    await app?.close()
    await new Promise(resolve => server.close(resolve))
  }
})

test('Electron：图片预览右键复制与文件定位，标题栏为原生拖区且按钮可点', async () => {
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
      <div class="dk-frame"><header class="dk-titlebar"><div class="dk-titlebar-side"></div><div class="dk-titlebar-main"></div><div class="dk-titlebar-controls"><button class="dk-winbtn">关闭</button></div></header>
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
    expect(regions).toEqual({ title: 'drag', button: 'no-drag', brand: 'drag' })
    const after = await app.evaluate(() => global.testWindow.getBounds())
    await page.locator('.dk-winbtn').click()
    expect(await app.evaluate(() => global.testWindow.getBounds())).toEqual(after)
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
