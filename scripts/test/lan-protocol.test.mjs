/**
 * 局域网发现协议：编码、广告 URL、挑选默认网关、HTTP 探测目标。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LAN_PRODUCT,
  LAN_PROTO,
  encodeLanMessage,
  decodeLanMessage,
  listLanIPv4,
  advertisedUrls,
  pickGatewayUrl,
  httpProbeTargets,
  parseHealthHello,
  mergeGateways,
  pickBestUrl,
} from '../lib/lan-protocol.mjs'

test('decodeLanMessage：只认本产品 hello/here', () => {
  const hello = encodeLanMessage({ type: 'hello' })
  assert.deepEqual(decodeLanMessage(hello), { product: LAN_PRODUCT, proto: LAN_PROTO, type: 'hello' })
  assert.equal(decodeLanMessage(Buffer.from('not-json')), null)
  assert.equal(decodeLanMessage(Buffer.from(JSON.stringify({ product: 'other', proto: 1, type: 'hello' }))), null)
  assert.equal(decodeLanMessage(Buffer.from(JSON.stringify({ product: LAN_PRODUCT, proto: 9, type: 'hello' }))), null)
  assert.equal(decodeLanMessage(Buffer.from(JSON.stringify({ product: LAN_PRODUCT, proto: LAN_PROTO, type: 'bye' }))), null)
})

test('listLanIPv4：丢掉回环 / 链路本地 / 内网卡', () => {
  const ips = listLanIPv4({
    eth0: [
      { family: 'IPv4', address: '192.168.1.8', internal: false },
      { family: 'IPv6', address: 'fe80::1', internal: false },
    ],
    wifi: [{ family: 4, address: '10.0.0.4', internal: false }],
    apipa: [{ family: 'IPv4', address: '169.254.1.2', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  })
  assert.deepEqual(ips, ['192.168.1.8', '10.0.0.4'])
})

test('advertisedUrls：有局域网 IP 时不广告 0.0.0.0 / 回环', () => {
  const urls = advertisedUrls({
    httpPort: 8790,
    publicUrl: 'http://127.0.0.1:8790',
    hostname: 'ETHANFLY',
    lanIps: ['192.168.1.8'],
  })
  assert.deepEqual(urls, ['http://192.168.1.8:8790', 'http://ethanfly:8790'])
})

test('advertisedUrls：没有局域网 IP 时退回 publicUrl / 回环', () => {
  const urls = advertisedUrls({
    httpPort: 8790,
    publicUrl: 'http://0.0.0.0:8790',
    hostname: '',
    lanIps: [],
  })
  assert.deepEqual(urls, ['http://127.0.0.1:8790'])
})

test('pickGatewayUrl：上次地址仍在列表里则沿用', () => {
  const picked = pickGatewayUrl({
    found: [
      { urls: ['http://192.168.1.8:8790'], name: 'A' },
      { urls: ['http://192.168.1.9:8790'], name: 'B' },
    ],
    lastUrl: 'http://192.168.1.9:8790',
  })
  assert.equal(picked, 'http://192.168.1.9:8790')
})

test('pickGatewayUrl：本机与局域网同时在时优先本机', () => {
  const picked = pickGatewayUrl({
    found: [{ urls: ['http://192.168.1.8:8790', 'http://127.0.0.1:8790'], name: 'Acme' }],
    lastUrl: 'http://192.168.1.8:8790',
  })
  assert.equal(picked, 'http://127.0.0.1:8790')
})

test('pickGatewayUrl：没有本机时才用局域网', () => {
  const picked = pickGatewayUrl({
    found: [{ urls: ['http://192.168.1.8:8790', 'http://ethanfly:8790'], name: 'Acme' }],
    lastUrl: 'http://127.0.0.1:8790',
  })
  assert.equal(picked, 'http://192.168.1.8:8790')
})

test('httpProbeTargets：含上次地址、本机、主机名，扫描时不含 .0/.255', () => {
  const targets = httpProbeTargets({
    lastUrl: 'http://old-gw:8790',
    defaultPort: 8790,
    hostname: 'pc',
    lanIps: ['192.168.1.8'],
    scanSubnet: true,
  })
  assert.ok(targets.includes('http://old-gw:8790'))
  assert.ok(targets.includes('http://127.0.0.1:8790'))
  assert.ok(targets.includes('http://localhost:8790'))
  assert.ok(targets.includes('http://pc:8790'))
  assert.ok(targets.includes('http://192.168.1.8:8790'))
  assert.ok(targets.includes('http://192.168.1.1:8790'))
  assert.ok(targets.includes('http://192.168.1.254:8790'))
  assert.equal(targets.includes('http://192.168.1.0:8790'), false)
  assert.equal(targets.includes('http://192.168.1.255:8790'), false)
})

test('parseHealthHello：只认本产品 /health', () => {
  assert.deepEqual(
    parseHealthHello({ ok: true, product: LAN_PRODUCT, name: 'Acme', needsSetup: false, publicUrl: 'http://gw:8790' }, 'http://192.168.1.8:8790'),
    { url: 'http://192.168.1.8:8790', name: 'Acme', needsSetup: false, publicUrl: 'http://gw:8790', source: 'http' },
  )
  assert.equal(parseHealthHello({ ok: true, name: 'x' }, 'http://1.1.1.1:8790'), null)
})

test('parseHealthHello：带上 instanceId', () => {
  const g = parseHealthHello(
    { ok: true, product: LAN_PRODUCT, name: 'Acme', instanceId: 'gw-1', needsSetup: false, publicUrl: 'http://gw:8790' },
    'http://192.168.1.8:8790',
  )
  assert.equal(g.instanceId, 'gw-1')
})

test('mergeGateways：同一 instanceId 的多个 IP 收成一台', () => {
  const merged = mergeGateways([
    { instanceId: 'gw-1', name: 'Acme', urls: ['http://192.168.1.8:8790'] },
    { instanceId: 'gw-1', name: 'Acme', urls: ['http://172.28.80.1:8790'] },
    { instanceId: 'gw-1', name: 'Acme', urls: ['http://10.8.0.5:8790'] },
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].instanceId, 'gw-1')
  assert.deepEqual(merged[0].urls, ['http://192.168.1.8:8790', 'http://172.28.80.1:8790', 'http://10.8.0.5:8790'])
})

test('mergeGateways：没有 instanceId 时按公司名+端口合并', () => {
  const merged = mergeGateways([
    { name: 'Acme', urls: ['http://192.168.1.8:8790'] },
    { name: 'Acme', urls: ['http://172.28.80.1:8790'] },
  ])
  assert.equal(merged.length, 1)
})

test('mergeGateways：不同 instanceId 即使同名也分开', () => {
  const merged = mergeGateways([
    { instanceId: 'a', name: 'Acme', urls: ['http://192.168.1.8:8790'] },
    { instanceId: 'b', name: 'Acme', urls: ['http://192.168.1.9:8790'] },
  ])
  assert.equal(merged.length, 2)
})

test('pickBestUrl：优先本机，其次上次地址，再同网段', () => {
  assert.equal(
    pickBestUrl(['http://192.168.1.8:8790', 'http://127.0.0.1:8790'], { lastUrl: 'http://192.168.1.8:8790', lanIps: ['192.168.1.20'] }),
    'http://127.0.0.1:8790',
  )
  assert.equal(
    pickBestUrl(['http://172.28.80.1:8790', 'http://192.168.1.8:8790'], { lastUrl: 'http://192.168.1.8:8790', lanIps: ['192.168.1.20'] }),
    'http://192.168.1.8:8790',
  )
  assert.equal(
    pickBestUrl(['http://172.28.80.1:8790', 'http://192.168.1.8:8790'], { lanIps: ['192.168.1.20'] }),
    'http://192.168.1.8:8790',
  )
})
