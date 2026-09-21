/**
 * 局域网找公司网关：UDP hello + 本机 /health。不扫整段 /24（CLI 要快）。
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

async function udpDiscover(list, timeoutMs) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const hello = encode({ type: 'hello' })
  await new Promise((resolve, reject) => {
    sock.once('error', reject)
    sock.bind(0, () => resolve())
  })
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
    try {
      sock.setBroadcast(true)
    } catch {
      /* ignore */
    }
    try {
      sock.addMembership(LAN_MULTICAST)
    } catch {
      /* ignore */
    }
    const send = (host) => {
      try {
        sock.send(hello, LAN_UDP_PORT, host)
      } catch {
        /* ignore */
      }
    }
    send('127.0.0.1')
    send('255.255.255.255')
    send(LAN_MULTICAST)
    await new Promise((r) => setTimeout(r, timeoutMs))
  } finally {
    await new Promise((resolve) => sock.close(resolve))
  }
}

async function healthProbe(list, url, timeoutMs = 1500) {
  const root = normalizeGatewayUrl(url)
  if (!root) return
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`${root}/health`, { signal: ac.signal })
    const json = await res.json()
    if (!json?.ok) return
    addGw(list, {
      name: json.name || 'valimart harness',
      instanceId: json.instanceId || root,
      needsSetup: !!json.needsSetup,
      urls: [root, json.publicUrl].filter(Boolean),
      source: 'http',
    })
  } catch {
    /* offline */
  } finally {
    clearTimeout(timer)
  }
}

export async function discoverGateways({ timeoutMs = 800 } = {}) {
  const list = []
  await Promise.all([udpDiscover(list, timeoutMs), healthProbe(list, 'http://127.0.0.1:8790')])
  return list
}
