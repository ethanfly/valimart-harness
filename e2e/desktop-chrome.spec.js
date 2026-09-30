/**
 * Electron caption（照上游桌面端）：独占 40px 一行、与侧栏同色、内容整体下移，
 * 左边折叠按钮 +「应用 / 编辑」菜单、右边自绘窗控，主列左上 16px 圆角。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { serveSessionImage } from '../plugins/desk-host/lib/session-image.js'
const electronBinary = path.resolve('desktop/node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
test.skip(!fs.existsSync(electronBinary), '需要已安装的桌面 Electron 依赖')

const DESK_CSS = fs.readFileSync('plugins/desk-ui/src/client/styles.css', 'utf8')

test('Electron：caption 40px 独占一行，菜单/折叠/窗控可点，内容整体下移且主列带圆角', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<html class="dk-desk-electron"><style>
      ${DESK_CSS}
      .session-header { padding:12px 20px 0; }
      .session-header > :first-child {display:flex;align-items:center}
      .test_titleCluster {display:flex;flex:1;align-items:center;gap:10px;min-width:0}
      .test_headerUtilities {display:flex;flex:none;align-items:center;margin-left:20px}
      .test_headerActions {flex:none}
      .session-header [role=tablist] {height:28px;margin-top:4px}
    </style><body><div id="root"><div class="dk-frame" data-mode="chat" data-dsh-frame>
      <aside class="dk-col-sidebar" style="width:280px"><div class="dk-brand"><span>品牌</span><div class="dk-row"><button class="dk-iconbtn dk-collapse-btn" type="button">收起侧边栏</button></div></div></aside>
      <main class="dk-col-main"><div data-slot="conversation.session.header" style="display:contents">
        <header class="session-header"><div class="test_titleRow"><div class="test_titleCluster"><nav>会话标题</nav><div class="test_headerActions">标准模式</div></div></div>
          <div role="tablist"><button role="tab">对话</button><button role="tab">轨迹</button></div>
        </header></div></main></div></div>
      <header class="dk-titlebar" data-focused>
        <button type="button" class="dk-caption-btn dk-caption-toggle" id="cap-toggle" aria-label="收起侧边栏">▤</button>
        <div class="dk-caption-menubar" role="menubar">
          <button type="button" role="menuitem" class="dk-caption-btn" id="cap-app">应用</button>
          <button type="button" role="menuitem" class="dk-caption-btn" id="cap-edit">编辑</button>
        </div>
        <div class="dk-titlebar-spacer" aria-hidden></div>
        <div class="dk-titlebar-controls">
          <button type="button" class="dk-winbtn" aria-label="最小化">-</button>
          <button type="button" class="dk-winbtn" aria-label="最大化">□</button>
          <button type="button" class="dk-winbtn close" aria-label="关闭">✕</button>
        </div>
      </header>
      <script>window.clicks=[]; document.addEventListener('click',e=>{const button=e.target.closest('button');if(button)window.clicks.push(button.getAttribute('aria-label')||button.textContent.trim())});
      document.querySelector('[aria-label=最大化]').onclick=()=>window.deskShell.maximize();
      document.getElementById('cap-app').onclick=async(e)=>{const r=e.currentTarget.getBoundingClientRect();await window.deskShell.openMenu('application',Math.round(r.left),Math.round(r.bottom))};</script>
    </body></html>`)
  })
  let app
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    app = await electron.launch({ executablePath: electronBinary, args: [path.resolve('e2e/fixtures/desktop-chrome.cjs'), `http://127.0.0.1:${server.address().port}`] })
    const page = await app.firstWindow()
    await page.waitForLoadState()
    const geometry = async () => page.evaluate(() => {
      const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON()
      const titlebar = document.querySelector('.dk-titlebar')
      return {
        titlebar: box('.dk-titlebar'),
        titlebarRegion: getComputedStyle(titlebar).getPropertyValue('-webkit-app-region'),
        frameBg: getComputedStyle(document.querySelector('.dk-frame')).backgroundColor,
        sidebarBg: getComputedStyle(document.querySelector('.dk-col-sidebar')).backgroundColor,
        mainRadius: getComputedStyle(document.querySelector('.dk-col-main')).borderTopLeftRadius,
        mainOverflow: getComputedStyle(document.querySelector('.dk-col-main')).overflow,
        header: box('.session-header'),
        row: box('.session-header > div'),
        sidebar: box('.dk-col-sidebar'),
        frame: box('.dk-frame'),
        w: innerWidth,
        h: innerHeight,
      }
    })
    const verify = async () => {
      const g = await geometry()
      expect(g.titlebar.height).toBe(40)
      // caption 是独立一行：会话顶栏、侧栏都从它下面开始。
      expect(g.header.top).toBe(40)
      expect(g.row.top).toBe(g.header.top + 12)
      expect(g.sidebar.top).toBe(40)
      expect(g.sidebar.left).toBe(0)
      expect(g.sidebar.bottom).toBe(g.h)
      expect(g.frame.right).toBe(g.w)
      expect(g.frame.bottom).toBe(g.h)
      expect(g.titlebarRegion).toBe('drag')
      // 圆角里要透出 caption 的底色，两者必须同色。
      expect(g.frameBg).toBe(g.sidebarBg)
      expect(g.mainRadius).toBe('16px')
      // 主列里的会话根节点自带不透明底色，不裁剪就会把圆角盖成直角。
      expect(g.mainOverflow).toBe('hidden')
    }
    await verify()
    const title = await page.locator('.test_titleCluster nav').boundingBox()
    expect(title.y).toBeGreaterThanOrEqual(40)
    // caption 上的按钮落在 caption 行内、能收到点击，且不压住窗控。
    const caption = await page.evaluate(() => {
      const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON()
      const hit = (selector) => {
        const r = document.querySelector(selector).getBoundingClientRect()
        return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest?.(selector) != null
      }
      return {
        menuStart: box('#cap-app').left,
        menuBottom: box('#cap-app').bottom,
        toggleLeft: box('#cap-toggle').left,
        editRight: box('#cap-edit').right,
        winLeft: box('.dk-winbtn.close').left,
        menuHit: hit('#cap-app'),
        toggleHit: hit('#cap-toggle'),
        winHit: hit('.dk-winbtn.close'),
      }
    })
    expect(caption.toggleLeft).toBeGreaterThanOrEqual(4)
    expect(caption.menuStart).toBeGreaterThanOrEqual(caption.toggleLeft + 28)
    expect(caption.menuBottom).toBeLessThanOrEqual(40)
    expect(caption.editRight).toBeLessThan(caption.winLeft)
    expect(caption.menuHit).toBe(true)
    expect(caption.toggleHit).toBe(true)
    expect(caption.winHit).toBe(true)
    await page.locator('#cap-toggle').click()
    await page.locator('#cap-app').click()
    expect(await app.evaluate(() => global.testPopups)).toEqual([expect.objectContaining({ name: 'application' })])
    expect(await page.evaluate(() => window.clicks)).toContain('收起侧边栏')
    await app.evaluate(() => global.testWindow.showInactive())
    await page.getByRole('button', { name: '最大化' }).click()
    await expect.poll(() => app.evaluate(() => global.testWindow.isMaximized())).toBe(true)
    await verify()
    await page.getByRole('button', { name: '最大化' }).click()
    await expect.poll(() => app.evaluate(() => global.testWindow.isMaximized())).toBe(false)
    await verify()
    await page.getByRole('tab', { name: '轨迹' }).click()
    expect(await page.evaluate(() => window.clicks.filter(v => v === '轨迹'))).toHaveLength(1)
  } finally {
    await app?.close()
    await new Promise(resolve => server.close(resolve))
  }
})

test('Electron：图片预览右键复制与文件定位，caption/品牌行是原生拖区且按钮可点', async () => {
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
    res.end(`<html class="dk-desk-electron"><style>${DESK_CSS}</style>
      <div class="dk-frame"><header class="dk-titlebar"><button type="button" class="dk-caption-btn dk-caption-toggle">▤</button><div class="dk-titlebar-spacer"></div><div class="dk-titlebar-controls"><button class="dk-winbtn">关闭</button></div></header>
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
      const region = (selector) => getComputedStyle(document.querySelector(selector)).getPropertyValue('-webkit-app-region')
      return {
        caption: region('.dk-titlebar'),
        button: region('.dk-winbtn'),
        brand: region('.dk-brand'),
        menuStart: document.querySelector('.dk-caption-toggle').getBoundingClientRect().right,
      }
    })
    expect(regions.caption).toBe('drag')
    expect(regions.button).toBe('no-drag')
    expect(regions.brand).toBe('drag')
    expect(regions.menuStart).toBeLessThanOrEqual(48)
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
