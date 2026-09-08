/**
 * 展开/收起按钮簇（better-sidebar [data-dsh-toggle-cluster]）在 Electron 自绘标题栏下的几何对齐。
 *
 * 为什么不是只断言 CSS 文本：这条 bug 是两套样式表的层叠结果 ——
 *   - 插件按面板状态给两档 top（展开 3px 骑 34px 标签栏 / 收起 14px 对位会话头）；
 *   - desk-ui 要把两者整体下移一个标题栏高度（--dk-titlebar-h: 36px），
 *     用属性选择器覆盖，特异性 (0,2,1) 会盖掉插件自己的 body[data-dsh-sidebar-collapsed] 规则。
 * 所以这里把两份「真样式表」同时喂给页面量真实 rect：
 *   plugins/desk-ui/src/client/styles.css + 内核前缀里 dsh-better-sidebar 的 sidebar.module.css
 * （后者只做 :global() 去壳，类名不哈希 —— desk-ui 的覆盖用的是属性选择器，与哈希无关）。
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
    path.join(root, 'node_modules', 'dsh-better-sidebar', 'src', 'client', 'sidebar.module.css'),
    path.resolve('build/kernel-stage/node_modules/dsh-better-sidebar/src/client/sidebar.module.css'),
  ]
  return candidates.find((p) => fs.existsSync(p))
}

const pluginCss = pluginCssPath()
test.skip(pluginCss === undefined, '需要内核前缀里的 dsh-better-sidebar（先 npm run kernel）')

function fixture() {
  return `<!doctype html>
<html class="dk-desk-electron dk-desk-maximized">
<head><meta charset="utf-8">
<style>${DESK_CSS}</style>
<style>${stripGlobal(fs.readFileSync(pluginCss, 'utf8'))}</style>
<style>html, body { margin: 0; background: #fff; }</style>
</head>
<body>
  <header class="dk-titlebar" data-focused>
    <div class="dk-titlebar-side" aria-hidden="true"></div>
    <div class="dk-titlebar-main">
      <span class="dk-titlebar-title">valimart harness</span>
      <div class="dk-titlebar-controls">
        <button type="button" class="dk-winbtn" aria-label="最小化"></button>
        <button type="button" class="dk-winbtn" aria-label="最大化"></button>
        <button type="button" class="dk-winbtn close" aria-label="关闭"></button>
      </div>
    </div>
  </header>
  <div data-dsh-panel-host>
    <div class="toggleCluster" data-dsh-toggle-cluster>
      <button type="button" class="toggleButton" aria-label="展开底部面板"></button>
      <button type="button" class="toggleButton" aria-label="展开右侧面板"></button>
    </div>
    <div class="panel" data-dsh-panel style="width:442px">
      <div class="tabBar">
        <div class="tabList">
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
    const hit = document.elementFromPoint(innerWidth - 23, 18)
    // 按钮簇自己身上命中的是不是它自己：落到标题栏条里就会被 .dk-titlebar-main
    // （-webkit-app-region: drag）吃掉点击，变成拖窗。
    const toggleHit = document.elementFromPoint(toggle.left + toggle.width / 2, toggle.center)
    return {
      titlebar: box('.dk-titlebar'),
      cluster: box('[data-dsh-toggle-cluster]'),
      toggle,
      panel: box('[data-dsh-panel]'),
      tabBar: box('[data-dsh-panel] .tabBar'),
      tabPlus: box('[data-dsh-panel] .tabBarPlus'),
      winButtonHit: hit instanceof Element && hit.closest('.dk-winbtn') !== null,
      toggleHit: toggleHit instanceof Element && toggleHit.closest('[data-dsh-toggle-cluster]') !== null,
    }
  })
}

test('展开态：按钮簇骑在右侧面板的标签栏上（与 + 同一条基线），且不压住窗控', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 819 })
  await page.setContent(fixture(), { waitUntil: 'load' })
  const open = await probe(page)

  // 面板整体下移一个标题栏高度，标签栏就从 y=36 起
  expect(open.panel.top).toBeCloseTo(36, 1)
  expect(open.tabBar.top).toBeCloseTo(36, 1)
  expect(open.tabBar.height).toBeCloseTo(34, 1)
  // 按钮簇在标签栏带内，且与「+」垂直居中同一行
  expect(open.toggle.top).toBeGreaterThanOrEqual(open.tabBar.top)
  expect(open.toggle.bottom).toBeLessThanOrEqual(open.tabBar.bottom)
  expect(Math.abs(open.toggle.center - open.tabPlus.center)).toBeLessThanOrEqual(1)
  // 不压住自绘标题栏的窗控，按钮自己也点得到（落进标题栏条就会被拖窗吃掉）
  expect(open.toggle.top).toBeGreaterThanOrEqual(open.titlebar.bottom)
  expect(open.winButtonHit).toBe(true)
  expect(open.toggleHit).toBe(true)
})

test('收起态：按钮簇落到会话头那一行（top = 标题栏 + 14），窗控仍可点', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 819 })
  await page.setContent(fixture(), { waitUntil: 'load' })
  await page.evaluate(() => { document.body.setAttribute('data-dsh-sidebar-collapsed', '') })
  await expect.poll(async () => (await probe(page)).toggle.top).toBeCloseTo(36 + 14, 1)
  const collapsed = await probe(page)

  expect(collapsed.toggle.top).toBeGreaterThanOrEqual(collapsed.titlebar.bottom)
  expect(collapsed.winButtonHit).toBe(true)
  expect(collapsed.toggleHit).toBe(true)
  // 收起时面板滑出屏幕，按钮簇仍贴视口右上角
  expect(collapsed.cluster.right).toBeCloseTo(1280 - 10, 1)
})
