/**
 * 网关 UDP 信标：收到 hello 回 here；/health 带产品标记。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import dgram from 'node:dgram'
import { createGateway } from '../src/index.js'
import { decodeLanMessage, encodeLanMessage } from '../../scripts/lib/lan-protocol.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-lan-beacon-'))
const udpPort = 19000 + Math.floor(Math.random() * 2000)
let gw
let base

before(async () => {
  gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: tmp,
    seedAdmin: false,
    seedUsers: [],
    company: { name: '信标公司', plan: '团队版', seats: 5 },
    publicUrl: 'http://office-pc:8790',
    lanDiscover: true,
    lanDiscoverPort: udpPort,
    upstreams: {},
    channels: [],
    fetchReleases: async () => [],
  })
  base = await gw.listen()
})

after(async () => {
  await gw.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('/health 带 product，供客户端 HTTP 兜底识别', async () => {
  const r = await fetch(base + '/health')
  const j = await r.json()
  assert.equal(r.status, 200)
  assert.equal(j.ok, true)
  assert.equal(j.product, 'valimart-harness')
  assert.equal(j.name, '信标公司')
  assert.equal(typeof j.port, 'number')
  assert.equal(j.needsSetup, true)
})

test('UDP hello 收到 here，urls 含局域网或主机名', async () => {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const got = []
  sock.on('message', (msg) => {
    const m = decodeLanMessage(msg)
    if (m?.type === 'here') got.push(m)
  })
  await new Promise((resolve) => sock.bind(0, '127.0.0.1', resolve))
  sock.send(encodeLanMessage({ type: 'hello' }), udpPort, '127.0.0.1')
  const start = Date.now()
  while (!got.length && Date.now() - start < 1500) await new Promise((r) => setTimeout(r, 40))
  sock.close()
  assert.ok(got.length >= 1, '应收到 here')
  assert.equal(got[0].name, '信标公司')
  assert.ok(Array.isArray(got[0].urls) && got[0].urls.length >= 1)
  assert.ok(got[0].urls.every((u) => !u.includes('0.0.0.0')))
})
