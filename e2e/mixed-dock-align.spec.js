/**
 * Mixed 运行条必须跟官方输入框同宽、居中：最大化（列很宽、吃 max-width）
 * 和缩小窗口（吃 side-clearance）都要对齐；展开/收起外框不变。
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const DESK_CSS = fs.readFileSync(path.resolve('plugins/desk-ui/src/client/styles.css'), 'utf8')

function fixture() {
  return `<!doctype html>
<html>
<head><meta charset="utf-8">
<style>${DESK_CSS}</style>
<style>
  html, body { margin: 0; background: #fff; }
  .wSkVaW_root {
    --dsh-composer-side-clearance: 16px;
    --dsh-composer-card-max-width: 780px;
    --dsh-composer-stack-gap: 6px;
  }
  .wSkVaW_composerStack { gap: var(--dsh-composer-stack-gap); flex-direction: column; display: flex; }
  .uV2eYG_root { padding: 0 var(--dsh-composer-side-clearance) 8px; flex-direction: column; align-items: center; display: flex; }
  .uV2eYG_card { box-sizing: border-box; width: 100%; max-width: var(--dsh-composer-card-max-width); height: 48px; border-radius: 22px; background: #f3f3f3; }
</style>
</head>
<body>
  <div class="wSkVaW_root" id="col">
    <div class="wSkVaW_composerStack">
      <div class="dk-mixed-panel active" id="mixed">
        <div class="dk-mixed-bar"><span class="dk-mixed-goal">goal</span></div>
        <div class="dk-mixed-body">body</div>
      </div>
      <div class="uV2eYG_root">
        <div class="uV2eYG_card" id="card"></div>
      </div>
    </div>
  </div>
</body>
</html>`
}

async function measure(page) {
  return page.evaluate(() => {
    const box = (id) => {
      const r = document.getElementById(id).getBoundingClientRect()
      return { left: r.left, right: r.right, width: r.width, center: r.left + r.width / 2 }
    }
    return { mixed: box('mixed'), card: box('card'), col: document.getElementById('col').getBoundingClientRect().width }
  })
}

async function assertAligned(page) {
  const { mixed, card } = await measure(page)
  expect(mixed.width).toBeCloseTo(card.width, 1)
  expect(mixed.left).toBeCloseTo(card.left, 1)
  expect(mixed.right).toBeCloseTo(card.right, 1)
  expect(mixed.center).toBeCloseTo(card.center, 1)
}

test('宽列（最大化）：Mixed 与输入框同宽且居中', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 800 })
  await page.setContent(fixture())
  await page.locator('#col').evaluate((el) => {
    el.style.width = '1400px'
  })
  await assertAligned(page)
  const { mixed } = await measure(page)
  expect(mixed.width).toBeCloseTo(780, 1)
})

test('窄列（非最大化）：Mixed 仍与输入框同宽且居中', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 })
  await page.setContent(fixture())
  await page.locator('#col').evaluate((el) => {
    el.style.width = '720px'
  })
  await assertAligned(page)
  const { mixed } = await measure(page)
  expect(mixed.width).toBeCloseTo(720 - 32, 1)
})

test('收起后外框宽度不变', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 800 })
  await page.setContent(fixture())
  await page.locator('#col').evaluate((el) => {
    el.style.width = '1400px'
  })
  const open = await measure(page)
  await page.locator('#mixed').evaluate((el) => el.classList.add('collapsed'))
  const shut = await measure(page)
  expect(shut.mixed.width).toBeCloseTo(open.mixed.width, 1)
  expect(shut.mixed.left).toBeCloseTo(open.mixed.left, 1)
  await assertAligned(page)
})
