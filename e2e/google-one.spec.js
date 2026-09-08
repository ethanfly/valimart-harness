/** Full admin UI → OAuth → gateway chat, with a local Google transport stub. */
import { test, expect } from '@playwright/test'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../server/src/index.js'

let gw, upstream, base, upstreamBase
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-e2e-google-'))
const calls = []
const defaults = JSON.parse(fs.readFileSync(new URL('../server/config.json', import.meta.url)))

test.beforeAll(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString()
    calls.push({ url: req.url, authorization: req.headers.authorization, raw })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/token') {
      const form = new URLSearchParams(raw)
      if (form.get('grant_type') === 'authorization_code' && form.get('code') !== 'good-code') {
        res.statusCode = 400; res.end('{"error":"invalid_grant"}'); return
      }
      res.end(JSON.stringify({ access_token: 'private-google-access', refresh_token: 'private-google-refresh', expires_in: 3600 }))
    } else if (req.url === '/v1internal:loadCodeAssist') {
      res.end(JSON.stringify({ currentTier: { id: 'standard-tier' }, cloudaicompanionProject: 'google-project' }))
    } else if (req.url?.includes('GenerateContent') || req.url?.includes('generateContent')) {
      const body = JSON.parse(raw)
      if (req.headers.authorization !== 'Bearer private-google-access' || body.project !== 'google-project') {
        res.statusCode = 401; res.end('{"error":"unauthorized"}'); return
      }
      const response = { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'Google 接入成功' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 10 } } }
      if (req.url.includes('streamGenerateContent')) {
        res.setHeader('content-type', 'text/event-stream')
        res.end(`data: ${JSON.stringify(response)}\n\n`)
      } else res.end(JSON.stringify(response))
    } else {
      res.statusCode = 404; res.end('{}')
    }
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`
  gw = createGateway({ host: '127.0.0.1', port: 0, dataDir: tmp, lanDiscover: false,
    seedUsers: [], upstreams: {}, fetchReleases: async () => [],
    channels: defaults.channels.map((c) => c.id === 'gemini' ? { ...c, baseUrl: `${upstreamBase}/v1internal` } : c),
    oauth: { gemini: { tokenUrl: `${upstreamBase}/token`, authorizeUrl: `${upstreamBase}/authorize` } },
  })
  base = await gw.listen()
})

test.afterAll(async () => {
  await gw?.close()
  if (upstream) await new Promise((resolve) => upstream.close(resolve))
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('加入 Google One：登录说明、回调、选择模型、接入及流式/非流式网关调用', async ({ page, request }) => {
  await page.goto(`${base}/admin`)
  await page.locator('input[name=username]').fill('boss')
  await page.locator('input[name=password]').fill('boss123456')
  await page.locator('#loginForm button[type=submit]').click()
  await page.locator('#nav a[href="#models"]').click()
  await page.locator('#addSub').click()
  await page.locator('#cf select[name=id]').selectOption('gemini')
  await expect(page.locator('#connDesc')).toContainText('Google AI Pro / Ultra')
  await expect(page.locator('#oauthStatus')).toContainText('完整回调网址')
  await expect(page.locator('#oauthLogin')).toBeEnabled()
  const startResponse = page.waitForResponse((r) => r.url().endsWith('/channels/gemini/oauth/start'))
  await page.locator('#oauthLogin').click()
  const start = await (await startResponse).json()
  expect(start.flow).toBe('authorization_code_paste')
  await expect(page.locator('#oauthStatus')).toContainText('localhost')
  await page.locator('#oauthPasteCode').fill(`http://localhost:45289/oauth2callback?code=good-code&state=${start.state}`)
  await page.locator('#oauthComplete').click()
  await expect(page.locator('#modelPickField')).toBeVisible()
  await expect(page.locator('#modelPick')).toContainText('gemini-2.5-pro')
  await page.locator('#connSubmit').click()
  await expect(page.locator('#cf')).toHaveCount(0)
  await expect(page.locator('#channels tr').filter({ hasText: 'Google One / Gemini' })).toContainText('已接')
  expect(gw.channels.view().find((c) => c.id === 'gemini').connected).toBe(true)
  await page.screenshot({ path: 'test-results/google-one-connected.png', fullPage: true })

  const loginRes = await request.post(`${base}/api/auth/login`, { data: { username: 'boss', password: 'boss123456', device: 'gemini-e2e' } })
  const login = await loginRes.json()
  const headers = { authorization: `Bearer ${login.gatewayToken}` }
  for (const stream of [false, true]) {
    const res = await request.post(`${base}/v1/chat/completions`, { headers, data: { model: 'gemini-2.5-pro', messages: [{ role: 'user', content: '你好' }], stream } })
    expect(res.status()).toBe(200)
    const body = await res.text()
    expect(body).toContain('Google 接入成功')
    expect(body).not.toContain('private-google')
    if (stream) expect(body).toContain('[DONE]')
    else expect(JSON.parse(body).usage.completion_tokens).toBe(5)
  }
  expect(calls.some((c) => c.url === '/v1internal:generateContent')).toBe(true)
  expect(calls.some((c) => c.url === '/v1internal:streamGenerateContent?alt=sse')).toBe(true)
  expect(calls.some((c) => c.url.includes('/models'))).toBe(false)
  const entries = gw.ledger.entriesSince(0, (e) => e.provider === 'gemini')
  expect(entries).toHaveLength(2)
  expect(entries.every((e) => e.status === 'ok' && e.promptTokens === 5 && e.completionTokens === 5)).toBe(true)
  const list = await request.get(`${base}/api/channels`, { headers: { authorization: `Bearer ${login.sessionToken}` } })
  expect(await list.text()).not.toContain('private-google')
})
