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

test('discoverGateways：本机 /health 通就不再扫局域网', async () => {
  const calls = []
  const r = await discoverGateways({
    udp: false,
    httpProbe: true,
    scanSubnet: true,
    timeoutMs: 200,
    lastUrl: 'http://127.0.0.1:8790',
    hostname: 'pc',
    lanIps: ['192.168.1.8'],
    fetchFn: async (url) => {
      calls.push(url)
      if (url === 'http://127.0.0.1:8790/health' || url === 'http://localhost:8790/health') {
        return {
          ok: true,
          json: async () => ({ ok: true, product: 'valimart-harness', name: '本机公司', needsSetup: false, publicUrl: 'http://127.0.0.1:8790' }),
        }
      }
      throw new Error(`不该再探 ${url}`)
    },
  })
  assert.equal(r.picked, 'http://127.0.0.1:8790')
  assert.equal(r.gateways[0].name, '本机公司')
  assert.ok(calls.every((u) => /127\.0\.0\.1|localhost/.test(u)), `本机命中后仍探了：${calls.join(', ')}`)
})

test('discoverGateways：HTTP 扫到同一 instanceId 的多个 IP 只算一台', async () => {
  const r = await discoverGateways({
    udp: false,
    httpProbe: true,
    scanSubnet: false,
    timeoutMs: 200,
    lastUrl: '',
    hostname: 'pc',
    lanIps: ['192.168.1.20'],
    fetchFn: async (url) => {
      const origin = url.replace(/\/health$/, '')
      if (origin === 'http://127.0.0.1:8790' || origin === 'http://localhost:8790') throw new Error('offline')
      if (!['http://192.168.1.8:8790', 'http://172.28.80.1:8790', 'http://10.8.0.5:8790'].includes(origin)) {
        throw new Error('offline')
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          product: 'valimart-harness',
          name: 'Acme',
          instanceId: 'gw-1',
          needsSetup: false,
          publicUrl: 'http://192.168.1.8:8790',
        }),
      }
    },
    extraHttpTargets: ['http://192.168.1.8:8790', 'http://172.28.80.1:8790', 'http://10.8.0.5:8790'],
  })
  assert.equal(r.gateways.length, 1)
  assert.equal(r.gateways[0].instanceId, 'gw-1')
  assert.equal(r.picked, 'http://192.168.1.8:8790')
})

test('discoverGateways：UDP 广告多地址时只保留 /health 通的', async () => {
  const udpPort = 18000 + Math.floor(Math.random() * 2000)
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  await new Promise((resolve) => sock.bind(udpPort, '127.0.0.1', resolve))
  sock.on('message', (msg, rinfo) => {
    if (JSON.parse(msg.toString()).type !== 'hello') return
    sock.send(
      encodeLanMessage({
        type: 'here',
        name: 'Acme',
        instanceId: 'gw-1',
        needsSetup: false,
        urls: ['http://172.28.80.1:8790', 'http://192.168.1.8:8790'],
      }),
      rinfo.port,
      rinfo.address,
    )
  })
  try {
    const r = await discoverGateways({
      udpPort,
      timeoutMs: 600,
      httpProbe: true,
      scanSubnet: false,
      lastUrl: '',
      hostname: 'pc',
      lanIps: ['192.168.1.20'],
      fetchFn: async (url) => {
        if (url === 'http://192.168.1.8:8790/health') {
          return {
            ok: true,
            json: async () => ({ ok: true, product: 'valimart-harness', name: 'Acme', instanceId: 'gw-1', needsSetup: false }),
          }
        }
        throw new Error('unreachable')
      },
    })
    assert.equal(r.gateways.length, 1)
    assert.deepEqual(r.gateways[0].urls, ['http://192.168.1.8:8790'])
    assert.equal(r.picked, 'http://192.168.1.8:8790')
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
