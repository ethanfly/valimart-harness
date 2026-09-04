import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    channel: process.env.PW_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
    headless: true,
  },
})
