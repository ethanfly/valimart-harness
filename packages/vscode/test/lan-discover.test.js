import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import dgram from 'node:dgram'
import {
  LAN_PRODUCT,
  LAN_PROTO,
  LAN_UDP_PORT,
  LAN_MULTICAST,
  DEFAULT_GATEWAY_PORT,
  encodeLanMessage,
  decodeLanMessage,
  isPrivateIPv4,
  listLanIPv4,
  normalizeUrl,
  parseHealthHello,
  httpProbeTargets,
  pickBestUrl,
  pickGatewayUrl,
  mergeGateways,
  portFromUrl,
  discoverGateways,
  GatewayFinder,
} from '../src/lib/lan-discover.js'

function startHealthServer(payload) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404)
      res.end()
      return
    }
    const raw = JSON.stringify(payload)
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) })
    res.end(raw)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ port, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

const HEALTH = {
  ok: true,
  product: LAN_PRODUCT,
  name: 'ValimartHarness',
  port: DEFAULT_GATEWAY_PORT,
  publicUrl: 'http://ethanrog:8790',
  needsSetup: false,
  instanceId: 'ecfd3c8d-44c8-4e03-a448-f7efc975bcf9',
}

test('局域网协议：编解码只认本公司信标', () => {
  const buf = encodeLanMessage({ type: 'hello' })
  const decoded = decodeLanMessage(buf)
  assert.equal(decoded.product, LAN_PRODUCT)
  assert.equal(decoded.proto, LAN_PROTO)
  assert.equal(decoded.type, 'hello')
  assert.equal(LAN_UDP_PORT, 18790)
  assert.equal(LAN_MULTICAST, '239.255.87.90')

  assert.equal(decodeLanMessage(Buffer.from('not json')), null)
  assert.equal(decodeLanMessage(encodeLanMessage({ type: 'ping' })), null, '未知 type 丢弃')
  assert.equal(decodeLanMessage(Buffer.from(JSON.stringify({ product: 'other', proto: LAN_PROTO, type: 'here' }))), null)
  assert.equal(decodeLanMessage(Buffer.from(JSON.stringify({ product: LAN_PRODUCT, proto: 2, type: 'here' }))), null, '协议版本不匹配')
  assert.equal(decodeLanMessage(encodeLanMessage({ type: 'here' })).type, 'here')
})

test('/health 契约：ok+product 才算网关，缺 instanceId 也能用', () => {
  const g = parseHealthHello(HEALTH, 'http://127.0.0.1:8790/')
  assert.deepEqual(g, {
    url: 'http://127.0.0.1:8790',
    name: 'ValimartHarness',
    needsSetup: false,
    publicUrl: 'http://ethanrog:8790',
    source: 'http',
    instanceId: HEALTH.instanceId,
  })
  assert.equal(parseHealthHello({ ok: true, product: 'other' }, 'http://127.0.0.1:8790'), null)
  assert.equal(parseHealthHello({ ok: false, product: LAN_PRODUCT }, 'http://127.0.0.1:8790'), null)
  assert.equal(parseHealthHello(HEALTH, 'not-a-url'), null)
  assert.equal(parseHealthHello({ ok: true, product: LAN_PRODUCT }, 'ftp://x/y'), null)
  const noId = parseHealthHello({ ok: true, product: LAN_PRODUCT }, 'http://10.0.0.9:8790')
  assert.equal(noId.instanceId, undefined)
  assert.equal(noId.url, 'http://10.0.0.9:8790')
})

test('本机网卡与地址归一化', () => {
  const nics = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    eth: [
      { family: 'IPv4', address: '10.56.41.39', internal: false },
      { family: 'IPv4', address: '169.254.1.2', internal: false },
      { family: 'IPv6', address: 'fe80::1', internal: false },
    ],
    wifi: [{ family: 4, address: '192.168.201.204', internal: false }],
  }
  assert.deepEqual(listLanIPv4(nics), ['10.56.41.39', '192.168.201.204'])
  assert.equal(isPrivateIPv4('10.0.0.1'), true)
  assert.equal(isPrivateIPv4('172.16.0.1'), true)
  assert.equal(isPrivateIPv4('172.32.0.1'), false)
  assert.equal(isPrivateIPv4('192.168.1.1'), true)
  assert.equal(isPrivateIPv4('198.18.0.1'), false, '虚拟网卡段不算私网')
  assert.equal(normalizeUrl('http://x:8790/'), 'http://x:8790')
  assert.equal(normalizeUrl('ftp://x'), '')
  assert.equal(normalizeUrl('garbage'), '')
  assert.equal(portFromUrl('http://x:9000'), 9000)
  assert.equal(portFromUrl('http://x'), DEFAULT_GATEWAY_PORT)
  assert.equal(portFromUrl('garbage'), DEFAULT_GATEWAY_PORT)
})

test('探测目标：本机 → 网段；只有私网地址才做 /24 扫描', () => {
  const base = httpProbeTargets({ lastUrl: 'http://10.0.0.5:8790', hostname: 'ethanrog', lanIps: ['192.168.201.204'] })
  assert.equal(base[0], 'http://10.0.0.5:8790')
  assert.ok(base.includes('http://127.0.0.1:8790'))
  assert.ok(base.includes('http://localhost:8790'))
  assert.ok(base.includes('http://ethanrog:8790'))
  assert.ok(base.includes('http://192.168.201.204:8790'))
  assert.equal(base.length, 5, '默认不扫网段')

  const scanned = httpProbeTargets({ lanIps: ['192.168.201.204'], scanSubnet: true })
  assert.equal(scanned.length, 2 + 254, '本机两个 + 整个 /24')
  assert.ok(scanned.includes('http://192.168.201.1:8790'))
  assert.ok(scanned.includes('http://192.168.201.254:8790'))

  const virtual = httpProbeTargets({ lanIps: ['198.18.0.1'], scanSubnet: true })
  assert.equal(virtual.length, 3, '非私网地址只探自己，不扫 /24')
})

test('多网关合并与择优：本机 > 上次用过 > 同网段', () => {
  const merged = mergeGateways([
    { name: 'A', instanceId: 'id-1', urls: ['http://10.0.0.2:8790'] },
    { name: 'A', instanceId: 'id-1', urls: ['http://192.168.1.2:8790'] },
    { name: 'B', urls: ['http://10.0.0.3:8790'] },
    { name: 'B', urls: ['http://10.0.0.4:8790'] },
  ])
  assert.equal(merged.length, 2)
  assert.deepEqual(merged[0].urls, ['http://10.0.0.2:8790', 'http://192.168.1.2:8790'])
  assert.deepEqual(merged[1].urls, ['http://10.0.0.3:8790', 'http://10.0.0.4:8790'])

  const lanIps = ['10.0.0.9']
  assert.equal(pickBestUrl(['http://10.0.0.2:8790', 'http://127.0.0.1:8790']), 'http://127.0.0.1:8790')
  assert.equal(pickBestUrl(['http://10.0.0.2:8790', 'http://192.168.1.2:8790'], { lastUrl: 'http://192.168.1.2:8790' }), 'http://192.168.1.2:8790')
  assert.equal(pickBestUrl(['http://10.0.0.2:8790', 'http://192.168.1.2:8790'], { lanIps }), 'http://10.0.0.2:8790')
  assert.equal(pickBestUrl([], { lastUrl: 'http://10.0.0.5:8790' }), 'http://10.0.0.5:8790')
  // 同网段里优先真正的私网地址：198.18/198.19 是虚拟网卡段（RFC 2544 基准测试网段）
  assert.equal(
    pickBestUrl(['http://198.18.0.1:8790', 'http://10.56.41.39:8790', 'http://192.168.201.204:8790'], { lanIps: ['198.18.0.1', '10.56.41.39'] }),
    'http://10.56.41.39:8790',
  )
  assert.equal(pickGatewayUrl({ found: [{ urls: ['http://10.0.0.2:8790'] }], lanIps }), 'http://10.0.0.2:8790')
})

test('发现：先探本机 /health，找到就停（不再扫网段）', async () => {
  const gw = await startHealthServer(HEALTH)
  const calls = []
  const fetchFn = (url, opts) => {
    calls.push(url)
    return fetch(url, opts)
  }
  try {
    const r = await discoverGateways({ lastUrl: gw.url, udp: false, fetchFn, lanIps: ['10.56.41.39'] })
    assert.equal(r.gateways.length, 1)
    assert.equal(r.gateways[0].name, 'ValimartHarness')
    assert.equal(r.gateways[0].instanceId, HEALTH.instanceId)
    assert.equal(r.gateways[0].urls[0], gw.url)
    assert.equal(r.picked, gw.url)
    assert.equal(calls.length, 2, '只探本机的两个写法，不扫网段')
    assert.ok(calls.every((u) => /^http:\/\/(127\.0\.0\.1|localhost):/.test(u)))
  } finally {
    await gw.close()
  }
})

test('发现：本机没有时走 UDP 信标（局域网网关回 here）', async () => {
  const sock = dgram.createSocket('udp4')
  await new Promise((r) => sock.bind(0, '127.0.0.1', r))
  const udpPort = sock.address().port
  sock.on('message', (msg, rinfo) => {
    const decoded = decodeLanMessage(msg)
    if (!decoded || decoded.type !== 'hello') return
    const reply = encodeLanMessage({
      type: 'here',
      name: 'ValimartHarness',
      instanceId: 'id-udp-1',
      urls: [`http://10.0.0.7:8790`, `http://127.0.0.1:${udpPort}`],
      publicUrl: 'http://ethanrog:8790',
    })
    sock.send(reply, rinfo.port, rinfo.address)
  })
  try {
    const r = await discoverGateways({
      udpPort,
      timeoutMs: 600,
      httpProbe: false,
      lastUrl: `http://127.0.0.1:${udpPort}`,
      lanIps: ['10.0.0.9'],
    })
    assert.equal(r.gateways.length, 1)
    assert.equal(r.gateways[0].source, 'udp')
    assert.equal(r.gateways[0].instanceId, 'id-udp-1')
    assert.equal(r.gateways[0].urls[0], `http://127.0.0.1:${udpPort}`, '本机地址排最前')
    assert.ok(r.gateways[0].urls.includes('http://10.0.0.7:8790'))
    assert.equal(r.picked, `http://127.0.0.1:${udpPort}`)
  } finally {
    await new Promise((r) => sock.close(r))
  }
})

test('发现：UDP 无应答时 HTTP /24 扫描兜底，未开扫描则不扫', async () => {
  const gw = await startHealthServer(HEALTH)
  const lanIps = ['127.0.0.1']
  try {
    const scanned = []
    const r = await discoverGateways({
      udp: false,
      lastUrl: 'http://127.0.0.1:1',
      defaultPort: gw.port,
      hostname: '',
      lanIps,
      scanSubnet: true,
      timeoutMs: 300,
      fetchFn: (url, opts) => { scanned.push(url); return fetch(url, opts) },
    })
    assert.ok(r.gateways.length >= 1)
    assert.ok(r.picked.includes(`:${gw.port}`))
    assert.ok(scanned.some((u) => u.includes(`127.0.0.${1}:${gw.port}`) || u.includes('127.0.0.1')), '扫了本网段')

    const noScan = []
    await discoverGateways({
      udp: false,
      lastUrl: 'http://127.0.0.1:1',
      defaultPort: gw.port,
      hostname: '',
      lanIps,
      scanSubnet: false,
      timeoutMs: 300,
      fetchFn: (url, opts) => { noScan.push(url); return fetch(url, opts) },
    })
    assert.ok(!noScan.some((u) => /127\.0\.0\.(2|3|100):/.test(u)), '关掉扫描就不该扫邻居')
  } finally {
    await gw.close()
  }
})

test('发现：什么都没找到时返回空列表而不是抛错', async () => {
  const r = await discoverGateways({
    udp: false,
    lastUrl: 'http://127.0.0.1:1',
    defaultPort: 1,
    hostname: '',
    lanIps: [],
    timeoutMs: 200,
  })
  assert.deepEqual(r.gateways, [])
  assert.equal(r.picked, '')
})

test('GatewayFinder：TTL 内复用、force 重扫、并发只跑一次', async () => {
  let calls = 0
  let release
  const gate = new Promise((r) => { release = r })
  const finder = new GatewayFinder({
    discover: async ({ lastUrl }) => {
      calls++
      await gate
      return { gateways: [{ name: 'X', urls: ['http://10.0.0.2:8790'] }], picked: 'http://10.0.0.2:8790', lastUrl }
    },
  })
  const a = finder.find({ lastUrl: 'http://10.0.0.2:8790' })
  const b = finder.find({ lastUrl: 'http://10.0.0.2:8790' })
  release()
  const [first, second] = await Promise.all([a, b])
  assert.equal(calls, 1, '同一时刻只跑一次')
  assert.deepEqual(first.gateways, second.gateways)
  assert.equal(first.cached, false)

  const again = await finder.find({ lastUrl: 'http://10.0.0.2:8790' })
  assert.equal(again.cached, true)
  assert.equal(calls, 1, 'TTL 内不重扫')

  await finder.find({ lastUrl: 'http://10.0.0.2:8790', force: true })
  assert.equal(calls, 2, 'force 重扫')
})
