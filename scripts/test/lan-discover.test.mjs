/**
 * 客户端局域网发现：UDP hello 收 here，HTTP /health 兜底。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { LAN_UDP_PORT, encodeLanMessage } from '../lib/lan-protocol.mjs'
import { discoverGateways } from '../../plugins/desk-host/lib/lan-discover.js'

test('discoverGateways：UDP here 收成网关列表', async () => {
  const udpPort = 18000 + Math.floor(Math.random() * 2000)
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  await new Promise((resolve) => sock.bind(udpPort, '127.0.0.1', resolve))
  sock.on('message', (msg, rinfo) => {
    const decoded = JSON.parse(msg.toString())
    if (decoded.type !== 'hello') return
    const reply = encodeLanMessage({
      type: 'here',
      name: '演示公司',
      needsSetup: false,
      port: 8790,
      urls: ['http://192.168.1.8:8790'],
    })
    sock.send(reply, rinfo.port, rinfo.address)
  })
  try {
    const r = await discoverGateways({
      udpPort,
      timeoutMs: 600,
      httpProbe: false,
      lastUrl: 'http://127.0.0.1:8790',
    })
    assert.equal(r.gateways.length, 1)
    assert.equal(r.gateways[0].name, '演示公司')
    assert.equal(r.picked, 'http://192.168.1.8:8790')
    assert.equal(r.gateways[0].source, 'udp')
  } finally {
    await new Promise((resolve) => sock.close(resolve))
  }
})

test('discoverGateways：UDP 空时用 HTTP /health', async () => {
  const calls = []
  const r = await discoverGateways({
    udpPort: LAN_UDP_PORT,
    timeoutMs: 200,
    udp: false,
    httpProbe: true,
    scanSubnet: false,
    lastUrl: 'http://gw.lan:8790',
    hostname: 'pc',
    lanIps: [],
    fetchFn: async (url) => {
      calls.push(url)
      if (url === 'http://gw.lan:8790/health') {
        return {
          ok: true,
          json: async () => ({ ok: true, product: 'valimart-harness', name: 'LAN 公司', needsSetup: true, publicUrl: 'http://gw.lan:8790' }),
        }
      }
      throw new Error('offline')
    },
  })
  assert.ok(calls.includes('http://gw.lan:8790/health'))
  assert.equal(r.gateways.length, 1)
  assert.equal(r.picked, 'http://gw.lan:8790')
  assert.equal(r.gateways[0].needsSetup, true)
})
