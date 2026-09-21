/**
 * Merged caption (VS Code style): session title row, right-sidebar tab strip
 * and window controls share the top 36px. Toggles sit left of the win buttons.
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const DESK_CSS = fs.readFileSync(path.resolve('plugins/desk-ui/src/client/styles.css'), 'utf8')

function fixture({ expanded } = { expanded: false }) {
  const corner = expanded
    ? ''
    : `<div data-conversation-header-corner>
              <button type="button" data-sidebar-right-expand aria-label="打开右侧边栏"></button>
            </div>`
  const right = expanded
    ? `<div class="dk-col-right" data-rightbar-col style="width:440px;position:relative">
            <div data-sidebar-right-panel="push" data-sidebar-right-open class="fake-panel">
              <div class="fake-strip">
                <button type="button" class="chip">文件</button>
                <button type="button" aria-label="新建标签页">+</button>
                <span class="fake-strip-spacer"></span>
                <button type="button" data-sidebar-right-mode aria-label="全屏"></button>
                <button type="button" data-sidebar-right-toggle aria-label="关闭右侧边栏"></button>
              </div>
            </div>
          </div>`
    : `<div class="dk-col-right" data-rightbar-col data-collapsed style="width:0"></div>`
  return `<!doctype html>
<html class="dk-desk-electron dk-desk-maximized">
<head><meta charset="utf-8">
<style>${DESK_CSS}</style>
<style>
  html, body { margin: 0; background: #fff; }
  .session-header { display: flex; flex-direction: column; }
  .title-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
  [data-conversation-header-corner] { display: flex; gap: 6px; flex: none; }
  [data-sidebar-right-expand],
  [data-sidebar-right-toggle],
  [data-sidebar-right-mode] {
    width: 28px;
    height: 28px;
    border: 0;
    background: #ddd;
  }
  .fake-panel {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 0;
    width: 440px;
    display: flex;
    flex-direction: column;
    background: #f7f7f8;
  }
  .fake-strip {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 36px;
    padding: 0 8px;
    flex: none;
  }
  .fake-strip-spacer { flex: 1; }
  .chip { border: 0; background: #eee; height: 24px; }
</style>
</head>
<body>
  <div id="root"><div data-slot="root" style="display:contents">
    <div class="dk-frame" data-mode="chat" data-dsh-frame ${expanded ? '' : 'data-rightbar-collapsed'}>
      <div class="dk-col-sidebar" style="width:280px"></div>
      <div class="dk-col-main">
        <div data-slot="conversation.session.header" style="display:contents">
          <header class="session-header">
            <div class="title-row">
              <div>会话标题</div>
              ${corner}
            </div>
          </header>
        </div>
      </div>
      ${right}
    </div>
  </div></div>
  <header class="dk-titlebar" data-focused>
    <div class="dk-titlebar-side" aria-hidden="true"></div>
    <div class="dk-titlebar-main">
      <span class="dk-titlebar-title">valimart harness</span>
    </div>
    <div class="dk-titlebar-pass" aria-hidden="true"></div>
    <div class="dk-titlebar-controls">
      <button type="button" class="dk-winbtn" aria-label="最小化"></button>
      <button type="button" class="dk-winbtn" aria-label="最大化"></button>
      <button type="button" class="dk-winbtn close" aria-label="关闭"></button>
    </div>
  </header>
</body>
</html>`
}

test('收起态：无顶部空边，展开按钮与窗控同一行且不重叠', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 819 })
  await page.setContent(fixture({ expanded: false }), { waitUntil: 'load' })
  const open = await page.evaluate(() => {
    const box = (selector) => {
      const node = document.querySelector(selector)
      if (node === null) throw new Error(`missing ${selector}`)
      const r = node.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height, center: r.top + r.height / 2 }
    }
    const expand = box('[data-sidebar-right-expand]')
    const winbtn = box('.dk-winbtn.close')
    const hit = (x, y) => document.elementFromPoint(x, y)
    return {
      titlebar: box('.dk-titlebar'),
      header: box('[data-slot="conversation.session.header"] > header'),
      winbtn,
      expand,
      expandDisplay: getComputedStyle(document.querySelector('[data-sidebar-right-expand]')).display,
      titlebarRegion: getComputedStyle(document.querySelector('.dk-titlebar')).getPropertyValue('-webkit-app-region'),
      passRegion: getComputedStyle(document.querySelector('.dk-titlebar-pass')).getPropertyValue('-webkit-app-region'),
      expandRegion: getComputedStyle(document.querySelector('[data-sidebar-right-expand]')).getPropertyValue('-webkit-app-region'),
      pass: box('.dk-titlebar-pass'),
      winButtonHit: hit(innerWidth - 23, 16)?.closest?.('.dk-winbtn') != null,
      expandHit: hit(expand.left + expand.width / 2, expand.center)?.closest?.('[data-sidebar-right-expand]') != null,
    }
  })

  expect(open.expandDisplay).not.toBe('none')
  expect(open.titlebarRegion).toBe('drag')
  expect(open.passRegion).toBe('no-drag')
  expect(open.expandRegion).toBe('no-drag')
  expect(open.expand.left).toBeGreaterThanOrEqual(open.pass.left - 1)
  expect(open.expand.right).toBeLessThanOrEqual(open.pass.right + 1)
  expect(open.titlebar.height).toBeCloseTo(36, 1)
  expect(open.header.top).toBeCloseTo(0, 1)
  expect(open.winbtn.top).toBeCloseTo(0, 1)
  expect(open.winbtn.height).toBeCloseTo(36, 1)
  expect(open.expand.top).toBeGreaterThanOrEqual(0)
  expect(open.expand.bottom).toBeLessThanOrEqual(open.titlebar.bottom + 1)
  expect(open.expand.right).toBeLessThanOrEqual(open.winbtn.left + 0.5)
  expect(open.winButtonHit).toBe(true)
  expect(open.expandHit).toBe(true)
  await page.locator('[data-sidebar-right-expand]').click()
})

test('展开态：文件标签条贴顶，折叠/全屏在窗控左侧同一行', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 819 })
  await page.setContent(fixture({ expanded: true }), { waitUntil: 'load' })
  const open = await page.evaluate(() => {
    const box = (selector) => {
      const node = document.querySelector(selector)
      if (node === null) throw new Error(`missing ${selector}`)
      const r = node.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height, center: r.top + r.height / 2 }
    }
    const toggle = box('[data-sidebar-right-toggle]')
    const mode = box('[data-sidebar-right-mode]')
    const winbtn = box('.dk-winbtn.close')
    const panel = box('[data-sidebar-right-panel]')
    const titleRow = box('.title-row')
    const strip = box('.fake-strip')
    const hit = (x, y) => document.elementFromPoint(x, y)
    return {
      titlebar: box('.dk-titlebar'),
      winbtn,
      toggle,
      mode,
      panel,
      titleRow,
      strip,
      toggleDisplay: getComputedStyle(document.querySelector('[data-sidebar-right-toggle]')).display,
      modeDisplay: getComputedStyle(document.querySelector('[data-sidebar-right-mode]')).display,
      titlebarRegion: getComputedStyle(document.querySelector('.dk-titlebar')).getPropertyValue('-webkit-app-region'),
      toggleRegion: getComputedStyle(document.querySelector('[data-sidebar-right-toggle]')).getPropertyValue('-webkit-app-region'),
      winButtonHit: hit(innerWidth - 23, 16)?.closest?.('.dk-winbtn') != null,
      toggleHit: hit(toggle.left + toggle.width / 2, toggle.center)?.closest?.('[data-sidebar-right-toggle]') != null,
      modeHit: hit(mode.left + mode.width / 2, mode.center)?.closest?.('[data-sidebar-right-mode]') != null,
    }
  })

  expect(open.toggleDisplay).not.toBe('none')
  expect(open.modeDisplay).not.toBe('none')
  expect(open.titlebarRegion).toBe('drag')
  expect(open.toggleRegion).toBe('no-drag')
  expect(open.panel.top).toBeCloseTo(0, 1)
  expect(open.titleRow.bottom).toBeCloseTo(open.strip.bottom, 1)
  expect(open.titleRow.bottom).toBeCloseTo(open.titlebar.bottom, 1)
  expect(open.toggle.top).toBeGreaterThanOrEqual(-0.5)
  expect(open.toggle.bottom).toBeLessThanOrEqual(open.titlebar.bottom + 1)
  expect(open.mode.bottom).toBeLessThanOrEqual(open.titlebar.bottom + 1)
  expect(open.toggle.right).toBeLessThanOrEqual(open.winbtn.left + 0.5)
  expect(open.mode.right).toBeLessThanOrEqual(open.winbtn.left + 0.5)
  expect(open.winButtonHit).toBe(true)
  expect(open.toggleHit).toBe(true)
  expect(open.modeHit).toBe(true)
  await page.locator('[data-sidebar-right-toggle]').click()
  await page.locator('[data-sidebar-right-mode]').click()
})

test('设置弹层打开时窗控仍在', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 819 })
  await page.setContent(fixture({ expanded: true }), { waitUntil: 'load' })
  await page.evaluate(() => {
    const overlay = document.createElement('div')
    overlay.className = 'dk-overlay'
    overlay.innerHTML = '<div role="dialog"><div class="dk-settings"><button type="button" id="dlg-close">关闭设置</button></div></div>'
    document.body.append(overlay)
  })
  const covered = await page.evaluate(() => {
    const controls = document.querySelector('.dk-titlebar-controls')
    return {
      controlsHidden: getComputedStyle(controls).visibility === 'hidden',
      closeVisible: document.getElementById('dlg-close').getBoundingClientRect().width > 0,
    }
  })
  expect(covered.controlsHidden).toBe(false)
  expect(covered.closeVisible).toBe(true)
})
