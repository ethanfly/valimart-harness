import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const { attachWindowDrag } = createRequire(import.meta.url)('../../desktop/window-drag.cjs')

test('Electron 标题栏：better-sidebar 浮层（展开按钮簇 / 右侧面板）下移一个标题栏高度，不压住窗控', () => {
  const css = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'desk-ui', 'src', 'client', 'styles.css'), 'utf8')
  // 展开态：按钮簇骑在面板 34px 标签栏上（插件里就是 top: 3）
  assert.match(css, /html\.dk-desk-electron \[data-dsh-toggle-cluster\]\s*\{\s*top:\s*calc\(3px \+ var\(--dk-titlebar-h, 36px\)\)/)
  // 收起态：按钮簇对位 DSH 会话头那一行（插件里是 top: 14）
  assert.match(css, /html\.dk-desk-electron body\[data-dsh-sidebar-collapsed\] \[data-dsh-toggle-cluster\]\s*\{\s*top:\s*calc\(14px \+ var\(--dk-titlebar-h, 36px\)\)/)
  assert.match(css, /html\.dk-desk-electron \[data-dsh-panel\]\s*\{\s*top:\s*var\(--dk-titlebar-h, 36px\)/)
  // 一条 14px 管两态会把展开态的按钮簇压到标签栏下面 11px
  assert.doesNotMatch(css, /html\.dk-desk-electron \[data-dsh-toggle-cluster\]\s*\{\s*top:\s*calc\(14px \+ var\(--dk-titlebar-h, 36px\)\)/)
})

function harness(maximized = false) {
  const ipcMain = new EventEmitter(), win = new EventEmitter(), web = new EventEmitter()
  let bounds = maximized ? { x: 0, y: 0, width: 1920, height: 1080 } : { x: 100, y: 100, width: 900, height: 700 }
  Object.assign(web, { mainFrame: {}, getURL: () => 'http://127.0.0.1:3470' })
  Object.assign(win, { webContents: web, isDestroyed: () => false, isFullScreen: () => false,
    isMaximized: () => maximized, getBounds: () => ({ ...bounds }), getNormalBounds: () => ({ x: 100, y: 100, width: 900, height: 700 }),
    unmaximize: () => { maximized = false; bounds = win.getNormalBounds(); win.emit('unmaximize') },
    setPosition: (x, y) => { bounds = { ...bounds, x, y } },
  })
  attachWindowDrag(win, web.getURL(), { ipcMain })
  const event = { sender: web, senderFrame: web.mainFrame }
  return { win, ipcMain, event, send: (name, point) => ipcMain.emit('desk:drag-' + name, event, point) }
}

test('拖动使用事件原始屏幕坐标，松手、失焦、导航后停止，窗口关闭清理监听', () => {
  const { win, ipcMain, send } = harness()
  send('start', { x: 600, y: 118 })
  send('move', { x: 750, y: 218 })
  assert.deepEqual(win.getBounds(), { x: 250, y: 200, width: 900, height: 700 })
  for (const stop of [() => send('end'), () => win.emit('blur'), () => win.webContents.emit('did-start-navigation')]) {
    send('start', { x: 600, y: 118 }); stop(); send('move', { x: 900, y: 900 })
    assert.equal(win.getBounds().x, 250)
  }
  win.emit('closed')
  assert.equal(ipcMain.listenerCount('desk:drag-start'), 0)
})

test('最大化时按下不还原，真正移动后按抓取位置还原；拒绝其他窗口、子框架及无效坐标', () => {
  const { win, ipcMain, event, send } = harness(true)
  send('start', { x: 960, y: 18 })
  send('move', { x: 961, y: 18 })
  assert.equal(win.isMaximized(), true)
  send('move', { x: 1060, y: 118 })
  assert.equal(win.isMaximized(), false)
  assert.deepEqual(win.getBounds(), { x: 610, y: 100, width: 900, height: 700 })
  send('end')
  ipcMain.emit('desk:drag-start', { ...event, senderFrame: {} }, { x: 0, y: 0 })
  send('move', { x: 500, y: 500 })
  send('start', { x: NaN, y: 0 }); send('move', { x: 500, y: 500 })
  assert.equal(win.getBounds().x, 610)
})

test('Windows 延迟还原时保留最后拖动位置，松手后重试还原', () => {
  const { win, send } = harness(true)
  const unmaximize = win.unmaximize
  let attempts = 0
  win.unmaximize = () => { if (++attempts === 2) unmaximize() }
  send('start', { x: 960, y: 18 })
  send('move', { x: 1060, y: 118 })
  send('move', { x: 1100, y: 158 })
  assert.equal(win.isMaximized(), true)
  send('end')
  assert.equal(attempts, 2)
  assert.deepEqual(win.getBounds(), { x: 650, y: 140, width: 900, height: 700 })
})
