/**
 * 员工机寻找公司网关：UDP hello（优先）+ HTTP /health 兜底（含局域网 /24 扫描）。
 */
import dgram from 'node:dgram'
import os from 'node:os'
import {
  LAN_UDP_PORT,
  LAN_MULTICAST,
  encodeLanMessage,
  decodeLanMessage,
  listLanIPv4,
  pickGatewayUrl,
  httpProbeTargets,
  parseHealthHello,
  portFromUrl,
} from '../../../scripts/lib/lan-protocol.mjs'

async function udpDiscover({ udpPort, timeoutMs, addGw }) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const hello = encodeLanMessage({ type: 'hello' })
  await new Promise((resolve, reject) => {
    sock.once('error', reject)
    sock.bind(0, () => resolve())
  })
  sock.on('error', () => {})
  sock.on('message', (msg) => {
    const m = decodeLanMessage(msg)
    if (!m || m.type !== 'here') return
    addGw({
      name: m.name ?? '',
      needsSetup: !!m.needsSetup,
      urls: Array.isArray(m.urls) ? m.urls : [],
      publicUrl: m.publicUrl,
      source: 'udp',
    })
  })
  try {
    try { sock.setBroadcast(true) } catch { /* 某些网卡不允许 */ }
    try { sock.addMembership(LAN_MULTICAST) } catch { /* 组播可选 */ }
    const send = (host) => {
      try { sock.send(hello, udpPort, host) } catch { /* 广播/组播可能被网卡拒绝 */ }
    }
    send('127.0.0.1')
    send('255.255.255.255')
    send(LAN_MULTICAST)
    await new Promise((r) => setTimeout(r, timeoutMs))
  } finally {
    await new Promise((resolve) => sock.close(resolve))
  }
}

async function httpDiscover({ targets, fetchFn, addGw, timeoutMs }) {
  const concurrency = 32
  let i = 0
  const worker = async () => {
    while (i < targets.length) {
      const url = targets[i++]
      try {
        const healthUrl = `${url.replace(/\/+$/, '')}/health`
        const ac = typeof AbortController !== 'undefined' ? new AbortController() : null
        const timer = setTimeout(() => ac?.abort(), timeoutMs)
        const res = await fetchFn(healthUrl, ac ? { signal: ac.signal } : {})
        clearTimeout(timer)
        if (!res?.ok) continue
        const json = await res.json()
        const g = parseHealthHello(json, url)
        if (g) addGw({ ...g, urls: [g.url] })
      } catch {
        /* 主机无网关 */
      }
    }
  }
  const n = Math.min(concurrency, Math.max(targets.length, 0))
  if (!n) return
  await Promise.all(Array.from({ length: n }, () => worker()))
}

export async function discoverGateways({
  udpPort = LAN_UDP_PORT,
  timeoutMs = 1500,
  udp = true,
  httpProbe = true,
  scanSubnet = true,
  lastUrl,
  hostname = os.hostname(),
  lanIps,
  fetchFn = globalThis.fetch,
  defaultPort,
} = {}) {
  const found = []
  const seen = new Set()
  const addGw = (g) => {
    const urls = (g.urls ?? (g.url ? [g.url] : [])).filter(Boolean)
    if (!urls.length) return
    const key = [...urls].sort().join('|')
    if (seen.has(key)) return
    seen.add(key)
    found.push({ ...g, urls })
  }

  if (udp) {
    try {
      await udpDiscover({ udpPort, timeoutMs, addGw })
    } catch {
      /* 本机 UDP 不可用时走 HTTP */
    }
  }

  if (httpProbe) {
    const ips = lanIps ?? listLanIPv4()
    const port = defaultPort ?? portFromUrl(lastUrl, 8790)
    const targets = httpProbeTargets({
      lastUrl,
      defaultPort: port,
      hostname,
      lanIps: ips,
      scanSubnet: scanSubnet && found.length === 0,
    })
    await httpDiscover({ targets, fetchFn, addGw, timeoutMs: Math.min(timeoutMs, 400) })
  }

  return {
    gateways: found,
    picked: pickGatewayUrl({ found, lastUrl }) || '',
  }
}
