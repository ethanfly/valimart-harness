/**
 * 局域网找公司网关：UDP hello + 本机 /health。不扫整段 /24（CLI 要快）。
 * 协议与桌面客户端、pi 包相同：product=valimart-harness，UDP 18790。
 */
import dgram from 'node:dgram'
import { normalizeGatewayUrl } from './gateway.mjs'

const LAN_PRODUCT = 'valimart-harness'
const LAN_PROTO = 1
const LAN_UDP_PORT = 18790
const LAN_MULTICAST = '239.255.87.90'

function encode(obj) {
  return Buffer.from(JSON.stringify({ product: LAN_PRODUCT, proto: LAN_PROTO, ...obj }))
}

function decode(buf) {
  try {
    const o = JSON.parse(Buffer.from(buf).toString('utf8'))
    if (o?.product !== LAN_PRODUCT || o.proto !== LAN_PROTO) return null
    if (o.type !== 'here') return null
    return o
  } catch {
    return null
  }
}

function addGw(list, gw) {
  const urls = [...(gw.urls ?? []), gw.publicUrl].map(normalizeGatewayUrl).filter(Boolean)
  if (!urls.length) return
  const key = gw.instanceId || urls[0]
  const existing = list.find((x) => x.instanceId === key || x.urls[0] === urls[0])
  if (existing) {
    for (const u of urls) if (!existing.urls.includes(u)) existing.urls.push(u)
    return
  }
  list.push({
    name: gw.name || 'valimart harness',
    instanceId: gw.instanceId || key,
    needsSetup: !!gw.needsSetup,
    urls,
    source: gw.source,
  })
}

async function probeLocal(list) {
  for (const url of ['http://127.0.0.1:8790', 'http://localhost:8790']) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(800) })
      if (!res.ok) continue
      const body = await res.json().catch(() => ({}))
      addGw(list, {
        name: body.company || body.name || '本机网关',
        instanceId: body.instanceId || `local:${url}`,
        urls: [url],
        source: 'local',
      })
    } catch {
      /* 没开着 */
    }
  }
}

async function udpDiscover(list, timeoutMs) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const hello = encode({ type: 'hello' })
  try {
    await new Promise((resolve, reject) => {
      sock.once('error', reject)
      sock.bind(0, () => resolve())
    })
  } catch {
    try { sock.close() } catch { /* ignore */ }
    return
  }
  sock.on('error', () => {})
  sock.on('message', (msg) => {
    const m = decode(msg)
    if (!m) return
    addGw(list, {
      name: m.name ?? '',
      instanceId: m.instanceId,
      needsSetup: !!m.needsSetup,
      urls: Array.isArray(m.urls) ? m.urls : [],
      publicUrl: m.publicUrl,
      source: 'udp',
    })
  })
  try {
    try { sock.setBroadcast(true) } catch { /* ignore */ }
    try { sock.addMembership(LAN_MULTICAST) } catch { /* ignore */ }
    for (const host of ['127.0.0.1', '255.255.255.255', LAN_MULTICAST]) {
      try { sock.send(hello, LAN_UDP_PORT, host) } catch { /* ignore */ }
    }
    await new Promise((resolve) => setTimeout(resolve, timeoutMs))
  } finally {
    try { sock.close() } catch { /* ignore */ }
  }
}

export async function discoverGateways({ timeoutMs = 900 } = {}) {
  const list = []
  await Promise.all([probeLocal(list), udpDiscover(list, timeoutMs)])
  return list
}

export function gatewayChoices(list) {
  const out = []
  for (const gw of list) {
    for (const url of gw.urls) {
      out.push({ url, label: `${gw.name}  ${url}${gw.source === 'local' ? '  （本机）' : ''}` })
    }
  }
  return out
}
