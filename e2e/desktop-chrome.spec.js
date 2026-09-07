import { test, expect, _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { serveSessionImage } from '../plugins/desk-host/lib/session-image.js'
const electronBinary = path.resolve('desktop/node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
test.skip(!fs.existsSync(electronBinary), '需要已安装的桌面 Electron 依赖')

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
