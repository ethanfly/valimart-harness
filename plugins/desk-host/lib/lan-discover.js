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
  isLoopbackHost,
  listLanIPv4,
  pickGatewayUrl,
  pickBestUrl,
  httpProbeTargets,
  parseHealthHello,
  mergeGateways,
  normalizeUrl,
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
      instanceId: m.instanceId,
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
        if (g) addGw({ ...g, urls: [g.url], instanceId: g.instanceId })
      } catch {
        /* 主机无网关 */
      }
    }
  }
  const n = Math.min(concurrency, Math.max(targets.length, 0))
  if (!n) return
  await Promise.all(Array.from({ length: n }, () => worker()))
}

function localProbeTargets(port) {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
}

async function filterReachableUrls(gateways, { fetchFn, timeoutMs }) {
  const next = []
  for (const g of gateways) {
    const ok = []
    await Promise.all((g.urls ?? []).map(async (url) => {
      try {
        const healthUrl = `${String(url).replace(/\/+$/, '')}/health`
        const ac = typeof AbortController !== 'undefined' ? new AbortController() : null
        const timer = setTimeout(() => ac?.abort(), timeoutMs)
        const res = await fetchFn(healthUrl, ac ? { signal: ac.signal } : {})
        clearTimeout(timer)
        if (!res?.ok) return
        const json = await res.json()
        const parsed = parseHealthHello(json, url)
        if (!parsed) return
        if (g.instanceId && parsed.instanceId && parsed.instanceId !== g.instanceId) return
        ok.push(url)
      } catch {
        /* 这个广告地址从本机走不通 */
      }
    }))
    next.push({ ...g, urls: ok.length ? ok : g.urls })
  }
  return next
}

function orderGatewayUrls(urls, { lastUrl, lanIps }) {
  const best = pickBestUrl(urls, { lastUrl, lanIps })
  const rest = (urls ?? []).filter((u) => normalizeUrl(u) !== normalizeUrl(best))
  return best ? [best, ...rest] : [...(urls ?? [])]
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
  extraHttpTargets = [],
} = {}) {
  const found = []
  const addGw = (g) => {
    const urls = (g.urls ?? (g.url ? [g.url] : [])).filter(Boolean)
    if (!urls.length) return
    found.splice(0, found.length, ...mergeGateways([...found, { ...g, urls }]))
  }
  const port = defaultPort ?? portFromUrl(lastUrl, 8790)
  const ips = lanIps ?? listLanIPv4()
  const finish = async ({ probe = false } = {}) => {
    if (probe && found.length) {
      const probed = await filterReachableUrls(found, { fetchFn, timeoutMs: Math.min(timeoutMs, 400) })
      found.splice(0, found.length, ...probed)
    }
    const gateways = found.map((g) => ({ ...g, urls: orderGatewayUrls(g.urls, { lastUrl, lanIps: ips }) }))
    return {
      gateways,
      picked: pickGatewayUrl({ found: gateways, lastUrl, lanIps: ips }) || '',
    }
  }

  // 先探本机 Windows 服务 / 开发网关；通了就不用扫局域网
  if (httpProbe) {
    await httpDiscover({
      targets: localProbeTargets(port),
      fetchFn,
      addGw,
      timeoutMs: Math.min(timeoutMs, 400),
    })
    if (found.length) return finish()
  }

  if (udp) {
    try {
      await udpDiscover({ udpPort, timeoutMs, addGw })
    } catch {
      /* 本机 UDP 不可用时走 HTTP */
    }
    if (found.length) return finish({ probe: httpProbe })
  }

  if (httpProbe) {
    const targets = [
      ...httpProbeTargets({
        lastUrl,
        defaultPort: port,
        hostname,
        lanIps: ips,
        scanSubnet: scanSubnet && found.length === 0,
      }).filter((u) => !isLoopbackHost(new URL(u).hostname)),
      ...extraHttpTargets,
    ]
    await httpDiscover({ targets, fetchFn, addGw, timeoutMs: Math.min(timeoutMs, 400) })
  }

  return finish({ probe: httpProbe && found.length > 0 })
}
