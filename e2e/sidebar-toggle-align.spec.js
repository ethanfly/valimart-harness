/**
 * Real desk and workbench stylesheets verify caption-row tabs and hit testing,
 * stationary collapsed controls, and the bottom panel's independent
 * bottom anchor. CSS module suffixes are represented on the fixture tab bar.
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { defaultPrefix, locateKernel } from '../scripts/kernel/locate.mjs'

const DESK_CSS = fs.readFileSync(path.resolve('plugins/desk-ui/src/client/styles.css'), 'utf8')

/** CSS Modules 的 :global(sel) → sel（括号配对扫描，兼容 :global(x:not(y))）。 */
function stripGlobal(css) {
  let out = ''
  for (let i = 0; i < css.length;) {
    if (css.startsWith(':global(', i)) {
      let depth = 0
      let j = i + 7
      for (; j < css.length; j++) {
        if (css[j] === '(') depth++
        else if (css[j] === ')' && --depth === 0) break
      }
      out += css.slice(i + 8, j)
      i = j + 1
    } else {
      out += css[i]
      i++
    }
  }
  return out
}

function pluginCssPath() {
  const root = locateKernel(defaultPrefix())?.root ?? path.resolve('build/kernel-stage/node_modules/@deepseek-ai/dsh')
  const candidates = [
    path.resolve(root, '..', '..', 'dsh-better-sidebar', 'src', 'client', 'sidebar.module.css'),
    path.join(root, 'node_modules', 'dsh-better-sidebar', 'src', 'client', 'sidebar.module.css'),
    path.resolve('build/kernel-stage/node_modules/dsh-better-sidebar/src/client/sidebar.module.css'),
  ]
  return candidates.find((p) => fs.existsSync(p))
}

const pluginCss = pluginCssPath()
test.skip(pluginCss === undefined, '需要内核前缀里的 dsh-better-sidebar（先 npm run kernel）')

function fixture() {
  return `<!doctype html>
<html class="dk-desk-electron dk-desk-maximized" style="--dsh-sidebar-width:442px">
<head><meta charset="utf-8">
<style>${DESK_CSS}</style>
<style>${stripGlobal(fs.readFileSync(pluginCss, 'utf8'))}</style>
<style>${fs.readFileSync(path.join(path.dirname(pluginCss), 'layout.css'), 'utf8')}</style>
<style>html, body { margin: 0; background: #fff; }
    [data-slot='conversation.session.header.utilities'] button { width: 28px; height: 28px; border: 0; padding: 0; }
    </style>
</head>
<body>
  <div id="root"><div data-slot="root" style="display:contents">
    <div class="dk-frame" data-mode="chat" data-dsh-frame>
      <div class="dk-col-sidebar" style="width:280px"></div>
      <div class="dk-resizer"></div>
      <div class="dk-col-main"><div class="dk-slot-fill" data-dsh-center-col>
        <div data-slot="conversation" style="display:contents"><div style="height:100%;display:flex;flex-direction:column;min-height:0">
          <div style="flex:1;min-height:0;overflow:auto">Conversation</div><input aria-label="composer" style="height:80px;flex:none" />
        </div></div>
      </div></div>
    </div>
  </div></div>
  <header class="dk-titlebar" data-focused>
    <div class="dk-titlebar-side" aria-hidden="true"></div>
    <div class="dk-titlebar-main">
      <span class="dk-titlebar-title">valimart harness</span>
    </div>
    <div class="dk-titlebar-controls">
      <button type="button" class="dk-winbtn" aria-label="最小化"></button>
      <button type="button" class="dk-winbtn" aria-label="最大化"></button>
      <button type="button" class="dk-winbtn close" aria-label="关闭"></button>
    </div>
  </header>
  <div data-slot="conversation.session.header.utilities" class="headerUtilities">
    <button type="button" class="openFolder" aria-label="打开文件夹"></button>
    <button type="button" class="test_sessionLogButton" aria-label="下载会话日志"></button>
  </div>
  <div data-dsh-panel-host>
    <div class="bottomPanel" data-dsh-panel data-dsh-bottom-panel style="height:220px;left:285px;right:442px">
      <div class="tabBar">Terminal</div><div class="panelBody"></div>
    </div>
    <div class="toggleCluster" data-dsh-toggle-cluster>
      <button type="button" class="toggleButton" aria-label="展开底部面板"></button>
      <button type="button" class="toggleButton" aria-label="展开右侧面板"></button>
    </div>
    <div class="panel" data-dsh-panel style="width:442px">
      <div class="tabBar test_tabBar">
        <div class="tabList test_tabList">
          <button type="button" class="tabBarPlus" aria-label="新建标签页">+</button>
        </div>
      </div>
      <div class="panelBody"></div>
    </div>
  </div>
</body>
</html>`
}

function probe(page) {
  return page.evaluate(() => {
    const box = (selector) => {
      const node = document.querySelector(selector)
      if (node === null) throw new Error(`missing ${selector}`)
      const r = node.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height, center: r.top + r.height / 2 }
    }
    const toggle = box('[data-dsh-toggle-cluster] .toggleButton')
    const actions = box('[data-slot="conversation.session.header.utilities"]')
    const hit = document.elementFromPoint(innerWidth - 23, 18)
    // 按钮簇自己身上命中的是不是它自己：落到标题栏条里就会被 .dk-titlebar-main
    // （-webkit-app-region: drag）吃掉点击，变成拖窗。
    const toggleHit = document.elementFromPoint(toggle.left + toggle.width / 2, toggle.center)
    const actionHitEl = document.elementFromPoint(actions.left + 8, actions.center)
    const actionHit = actionHitEl instanceof Element && actionHitEl.closest('[data-slot="conversation.session.header.utilities"]') !== null
    return {
      titlebar: box('.dk-titlebar'),
      cluster: box('[data-dsh-toggle-cluster]'),
      toggle,
      actions,
      winbtn: box('.dk-winbtn'),
      panel: box('[data-dsh-panel]:not([data-dsh-bottom-panel])'),
      tabBar: box('[data-dsh-panel]:not([data-dsh-bottom-panel]) .tabBar'),
      tabPlus: box('[data-dsh-panel]:not([data-dsh-bottom-panel]) .tabBarPlus'),
      plusHit: (() => {
        const r = box('.tabBarPlus')
        return document.elementFromPoint(r.left + r.width / 2, r.center)?.closest('.tabBarPlus') !== null
      })(),
      winButtonHit: hit instanceof Element && hit.closest('.dk-winbtn') !== null,
      toggleHit: toggleHit instanceof Element && toggleHit.closest('[data-dsh-toggle-cluster]') !== null,
      actionHit,
    }
  })
}

test('展开态：按钮簇骑在右侧面板的标签栏上（与 + 同一条基线），且不压住窗控', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 819 })
  await page.setContent(fixture(), { waitUntil: 'load' })
  const open = await probe(page)

  // The panel's tabs now share the top row with the native window controls.
  expect(open.panel.top).toBeCloseTo(0, 1)
  expect(open.tabBar.top).toBeCloseTo(0, 1)
  expect(open.tabBar.height).toBeCloseTo(36, 1)
  // 按钮簇在标签栏带内，且与「+」垂直居中同一行
  expect(open.toggle.top).toBeGreaterThanOrEqual(open.tabBar.top)
  expect(open.toggle.bottom).toBeLessThanOrEqual(open.tabBar.bottom)
  expect(Math.abs(open.toggle.center - open.tabPlus.center)).toBeLessThanOrEqual(1)
  // 不压住自绘标题栏的窗控；文件夹 / 日志与面板开关并排居中
  expect(open.toggle.center).toBeCloseTo(open.titlebar.center, 1)
  expect(open.actions.center).toBeCloseTo(open.toggle.center, 1)
  expect(open.actions.right).toBeLessThanOrEqual(open.cluster.left)
  expect(open.cluster.right).toBeLessThanOrEqual(1280 - 138)
  expect(open.winButtonHit).toBe(true)
  expect(open.toggleHit).toBe(true)
  expect(open.actionHit).toBe(true)
  expect(open.plusHit).toBe(true)
  await page.locator('.tabBarPlus').click()
})

for (const size of [{ width: 1280, height: 819 }, { width: 1000, height: 650 }]) {
  test(`两面板同时展开：底部贴底，会话输入框不被遮挡 ${size.width}`, async ({ page }) => {
    await page.setViewportSize(size)
    await page.setContent(fixture())
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--dsh-sidebar-width', '442px')
      document.documentElement.style.setProperty('--dsh-sidebar-height', '220px')
    })
    const boxes = await page.evaluate(() => {
      const rect = s => document.querySelector(s).getBoundingClientRect().toJSON()
      return { bottom: rect('[data-dsh-bottom-panel]'), center: rect('[data-dsh-center-col]'), input: rect('input'), right: rect('[data-dsh-panel]:not([data-dsh-bottom-panel])'), frame: rect('.dk-frame') }
    })
    expect(boxes.bottom.bottom).toBeCloseTo(size.height, 1)
    expect(boxes.bottom.height).toBeCloseTo(220, 1)
    expect(boxes.center.bottom).toBeCloseTo(boxes.bottom.top, 1)
    expect(boxes.input.bottom).toBeLessThanOrEqual(boxes.bottom.top)
    expect(boxes.center.right).toBeCloseTo(boxes.right.left, 1)
    expect(boxes.frame.width).toBe(size.width)
  })
}

test('收起态：按钮簇保持顶部原位，窗控与面板开关仍可点', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 819 })
  await page.setContent(fixture(), { waitUntil: 'load' })
  const open = await probe(page)
  await page.evaluate(() => {
    document.body.setAttribute('data-dsh-sidebar-collapsed', '')
    document.documentElement.style.setProperty('--dsh-sidebar-width', '0px')
    document.querySelector('[data-dsh-panel]:not([data-dsh-bottom-panel])').classList.add('panelHidden')
  })
  const collapsed = await probe(page)

  expect(collapsed.cluster).toEqual(open.cluster)
  expect(collapsed.toggle.center).toBeCloseTo(collapsed.titlebar.center, 1)
  expect(collapsed.actions.center).toBeCloseTo(collapsed.toggle.center, 1)
  expect(collapsed.winButtonHit).toBe(true)
  expect(collapsed.toggleHit).toBe(true)
  expect(collapsed.actionHit).toBe(true)
  // 收起时面板滑出屏幕，按钮簇仍贴视口右上角
  expect(collapsed.cluster.right).toBeCloseTo(1280 - 148, 1)
  await page.locator('[data-dsh-toggle-cluster] button').last().click()
})

for (const viewport of [{ width: 1920, height: 1152 }, { width: 1536, height: 864 }]) {
  test(`Windows 最大化 ${viewport.width}：四周无留白，标题栏与两面板贴边，收起不跳位`, async ({ page }) => {
    const inset = 0
    await page.setViewportSize(viewport)
    await page.setContent(fixture())
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--dsh-sidebar-height', '220px')
      // Same viewport coordinates written by the workbench's center locator.
      const center = document.querySelector('[data-dsh-center-col]').getBoundingClientRect()
      const bottom = document.querySelector('[data-dsh-bottom-panel]')
      bottom.style.left = `${center.left}px`
      bottom.style.right = `${innerWidth - center.right}px`
    })
    const open = await probe(page)
    expect(open.panel.top).toBe(inset)
    expect(open.panel.right).toBe(viewport.width - inset)
    expect(open.panel.bottom).toBe(viewport.height - inset)
    expect(open.toggle.center).toBeCloseTo(open.titlebar.center, 1)
    expect(Math.abs(open.tabPlus.center - open.titlebar.center)).toBeLessThanOrEqual(1)
    expect(open.winButtonHit && open.toggleHit && open.plusHit).toBe(true)
    const geometry = await page.evaluate(() => {
      const rect = s => document.querySelector(s).getBoundingClientRect().toJSON()
      return { center: rect('[data-dsh-center-col]'), bottom: rect('[data-dsh-bottom-panel]'), right: rect('[data-dsh-panel]:not([data-dsh-bottom-panel])') }
    })
    expect(geometry.bottom.bottom).toBe(viewport.height - inset)
    expect(geometry.center.bottom).toBeCloseTo(geometry.bottom.top, 1)
    expect(geometry.center.right).toBeCloseTo(geometry.right.left, 1)
    expect(geometry.bottom.right).toBeCloseTo(geometry.right.left, 1)
    await page.evaluate(() => {
      document.body.setAttribute('data-dsh-sidebar-collapsed', '')
      document.documentElement.style.setProperty('--dsh-sidebar-width', '0px')
      document.querySelector('[data-dsh-panel]:not([data-dsh-bottom-panel])').classList.add('panelHidden')
    })
    const closed = await probe(page)
    expect(closed.cluster).toEqual(open.cluster)
    expect(closed.winButtonHit && closed.toggleHit).toBe(true)
    await page.locator('[data-dsh-toggle-cluster] button').last().click()
  })
}

test('设置弹层打开时面板开关不挡模态框，窗控仍在', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 819 })
  await page.setContent(fixture(), { waitUntil: 'load' })
  await page.evaluate(() => {
    const overlay = document.createElement('div')
    overlay.className = 'dk-overlay'
    overlay.innerHTML = '<div role="dialog"><div class="dk-settings"><button type="button" id="dlg-close">关闭设置</button></div></div>'
    document.body.append(overlay)
  })
  const covered = await page.evaluate(() => {
    const cluster = document.querySelector('[data-dsh-toggle-cluster]')
    const actions = document.querySelector('[data-slot="conversation.session.header.utilities"]')
    const controls = document.querySelector('.dk-titlebar-controls')
    return {
      clusterHidden: getComputedStyle(cluster).visibility === 'hidden',
      actionsHidden: getComputedStyle(actions).visibility === 'hidden',
      controlsHidden: getComputedStyle(controls).visibility === 'hidden',
      closeVisible: document.getElementById('dlg-close').getBoundingClientRect().width > 0,
    }
  })
  expect(covered.clusterHidden).toBe(true)
  expect(covered.actionsHidden).toBe(true)
  expect(covered.controlsHidden).toBe(false)
  expect(covered.closeVisible).toBe(true)
})
