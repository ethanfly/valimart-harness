/**
 * 管理页首次引导：空库 → 公司名 / 管理员 / 跳过同事 → 进入管理页。
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../server/src/index.js'

let gw
let base
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-e2e-setup-'))

test.beforeAll(async () => {
  gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: tmp,
    seedAdmin: false,
    seedUsers: [],
    company: { name: 'valimart harness', plan: '团队版', seats: 10 },
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

test('空库管理页走首次引导，完成后进入服务器页', async ({ page }) => {
  await page.goto(base + '/admin')
  await expect(page.locator('#setupForm')).toBeVisible()
  await expect(page.locator('body')).toContainText('首次安装')
  await page.locator('input[name="companyName"]').fill('瓦力商贸')
  await page.locator('#setupForm button[type="submit"]').click()
  await page.locator('input[name="username"]').fill('admin')
  await page.locator('input[name="displayName"]').fill('系统管理员')
  await page.locator('input[name="password"]').fill('admin123456')
  await page.locator('input[name="passwordConfirm"]').fill('admin123456')
  await page.locator('#setupForm button[type="submit"]').click()
  await expect(page.locator('input[name="cUsername"]')).toBeVisible()
  await page.locator('#setupForm button[type="submit"]').click()
  await expect(page.locator('#kernel h2')).toHaveText('内核', { timeout: 10_000 })
  await expect(page.locator('#who')).toContainText('系统管理员')
  await expect(page.locator('body')).toContainText('瓦力商贸')
})
