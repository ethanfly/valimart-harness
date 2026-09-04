/**
 * Grok 订阅：Grok CLI 公开 client + RFC 8628 设备码（mock，不打真网）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Channels } from '../src/channels.js'
import { OAuthSubscribe, describeOAuth } from '../src/oauth-subscribe.js'

const ACCESS = 'grok-device-access'
const REFRESH = 'grok-device-refresh'
let mock
let mockBase
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-grok-device-'))

before(async () => {
  mock = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const params = new URLSearchParams(raw)
      if (req.method === 'POST' && req.url === '/oauth/device') {
        if (params.get('client_id') !== 'b1a00492-073a-47ea-816f-4c329264a828') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid_client' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          user_code: 'ABCD-EFGH',
          device_code: 'rfc-device-1',
          verification_uri: `${mockBase}/activate`,
          interval: 0,
          expires_in: 900,
        }))
        return
      }
      if (req.method === 'POST' && req.url === '/oauth/token') {
        if (params.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:device_code' || params.get('device_code') !== 'rfc-device-1') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'authorization_pending' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 }))
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
  mockBase = `http://127.0.0.1:${mock.address().port}`
})

after(async () => {
  await new Promise((resolve) => mock.close(resolve))
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows 占用 */ }
})

test('未配 oauth.grok.clientId 时仍可用公开客户端，flow 是设备码', () => {
  const channel = { id: 'grok', label: 'Grok', kind: 'subscription', hint: 'grok-4.6' }
  const o = describeOAuth(channel, { publicUrl: 'http://gw.test:8790', oauth: { grok: { clientId: '' } } })
  assert.equal(o.available, true)
  assert.equal(o.configured, true)
  assert.equal(o.flow, 'device_code')
})

test('Grok RFC 设备码：start 出 user_code；status 换到 access_token', async () => {
  const cfg = {
    publicUrl: 'http://gw.test:8790',
    oauth: {
      grok: {
        deviceUserCodeUrl: `${mockBase}/oauth/device`,
        tokenUrl: `${mockBase}/oauth/token`,
      },
    },
    channels: [{ id: 'grok', label: 'Grok', kind: 'subscription', baseUrl: 'https://api.x.ai/v1', hint: 'grok-4.6' }],
    upstreams: {},
  }
  const channels = new Channels(cfg, tmp)
  const oauth = new OAuthSubscribe({ cfg, channels })
  const start = await oauth.start('grok', { id: 'u1', username: 'boss' }, { models: 'grok-4.6' })
  assert.equal(start.flow, 'device_code')
  assert.equal(start.userCode, 'ABCD-EFGH')
  assert.ok(start.verificationUri)
  const st = await oauth.status(start.state, { id: 'u1' })
  assert.equal(st.status, 'success')
  assert.equal(channels.store.load().items.grok.credential, ACCESS)
  assert.equal(channels.store.load().items.grok.refreshToken, REFRESH)
})
