/**
 * 管理页冒烟：登录遮罩 → 登录 → 看到内核 / 技能。
 * 自带临时网关，不依赖已启动的开发服务。
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../server/src/index.js'

let gw
let base
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-e2e-admin-'))

test.beforeAll(async () => {
  gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: tmp,
    seedUsers: [],
    upstreams: { mock: { kind: 'mock', label: 'Mock', models: [{ id: 'mock-echo', name: 'Mock Echo', priceCnyPerM: { input: 0, output: 0, cachedInput: 0 } }] } },
    channels: [],
    defaultModel: 'mock-echo',
    fetchReleases: async () => [],
  })
  base = await gw.listen()
})

test.afterAll(async () => {
  await gw.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('管理页：登录后可见内核与公司技能', async ({ page }) => {
  await page.goto(base + '/admin')
  await expect(page.locator('input[name="username"]')).toBeVisible()
  await page.locator('input[name="username"]').fill('boss')
  await page.locator('input[name="password"]').fill('boss123456')
  await page.locator('form#loginForm button[type="submit"]').click()
  await expect(page.locator('#kernel h2')).toHaveText('内核', { timeout: 10_000 })
  await expect(page.locator('body')).toContainText('company-briefing')
  await expect(page.locator('header .logo .word')).toBeVisible()
  await expect(page.locator('header .logo .mark')).toHaveCount(0)
  await expect(page.locator('header .logo small')).toHaveCount(0)
})
