/**
 * 局域网网关发现 —— 与桌面客户端（company-desk `scripts/lib/lan-protocol.mjs` +
 * `plugins/desk-host/lib/lan-discover.js`）共用同一套协议，保证两边找到的是同一批网关。
 *
 * 协议：UDP 18790 发 `{product:'valimart-harness', proto:1, type:'hello'}`，
 * 网关回 `type:'here'`（公司名 + 可达 URL + instanceId）；UDP 不可用时回退 HTTP
 * `GET {url}/health`（同样返回 product/name/publicUrl/instanceId）。
 *
 * 协议里**不含账号、令牌或密钥**，只广播公司名与 URL；这里也只读未鉴权的 /health。
 */
import dgram from 'node:dgram'
import os from 'node:os'

export const LAN_PRODUCT = 'valimart-harness'
export const LAN_PROTO = 1
export const LAN_UDP_PORT = 18790
export const LAN_MULTICAST = '239.255.87.90'
export const DEFAULT_GATEWAY_PORT = 8790

export function encodeLanMessage(obj) {
  return Buffer.from(JSON.stringify({ product: LAN_PRODUCT, proto: LAN_PROTO, ...obj }))
}

export function decodeLanMessage(buf) {
  try {
    const o = JSON.parse(Buffer.from(buf).toString('utf8'))
    if (o?.product !== LAN_PRODUCT || o.proto !== LAN_PROTO) return null
    if (o.type !== 'hello' && o.type !== 'here') return null
    return o
  } catch {
    return null
  }
}

export function isLoopbackHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h === '::'
}

export function isPrivateIPv4(ip) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(ip ?? ''))
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

export function listLanIPv4(nics = os.networkInterfaces()) {
  const out = []
  for (const list of Object.values(nics ?? {})) {
    for (const n of list ?? []) {
      const v4 = n.family === 4 || n.family === 'IPv4'
      if (!v4 || n.internal) continue
      if (String(n.address).startsWith('169.254.')) continue
      out.push(n.address)
    }
  }
  return [...new Set(out)]
}

export function normalizeUrl(u) {
  if (!u) return ''
  try {
    const x = new URL(u)
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return ''
    return x.origin
  } catch {
    return ''
  }
}

export function portFromUrl(u, fallback = DEFAULT_GATEWAY_PORT) {
  try {
    const p = Number(new URL(u).port)
    return p > 0 ? p : fallback
  } catch {
    return fallback
  }
}

export function parseHealthHello(json, originUrl) {
  if (!json || json.ok !== true || json.product !== LAN_PRODUCT) return null
  const url = normalizeUrl(originUrl)
  if (!url) return null
  const out = {
    url,
    name: json.name ?? json.companyName ?? '',
    needsSetup: !!json.needsSetup,
    publicUrl: json.publicUrl ?? url,
    source: 'http',
  }
  if (json.instanceId) out.instanceId = String(json.instanceId)
  return out
}

export function sameLanSubnet(url, lanIps) {
  try {
    const host = new URL(url).hostname
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
    if (!m) return false
    const prefix = `${m[1]}.${m[2]}.${m[3]}.`
    return (lanIps ?? []).some((ip) => String(ip).startsWith(prefix))
  } catch {
    return false
  }
}

export function gatewayIdentity(g) {
  const id = String(g?.instanceId ?? '').trim()
  if (id) return `id:${id}`
  const urls = (g?.urls ?? (g?.url ? [g.url] : [])).map(normalizeUrl).filter(Boolean)
  const name = String(g?.name ?? '').trim()
  const port = urls[0] ? portFromUrl(urls[0], DEFAULT_GATEWAY_PORT) : DEFAULT_GATEWAY_PORT
  if (name) return `name:${name}|${port}`
  return urls.slice().sort().join('|')
}

export function mergeGateways(list) {
  const byKey = new Map()
  for (const g of list ?? []) {
    const urls = (g.urls ?? (g.url ? [g.url] : [])).map(normalizeUrl).filter(Boolean)
    if (!urls.length) continue
    const key = gatewayIdentity({ ...g, urls })
    const cur = byKey.get(key)
    if (!cur) {
      byKey.set(key, { ...g, urls: [...new Set(urls)] })
      continue
    }
    for (const u of urls) if (!cur.urls.includes(u)) cur.urls.push(u)
    if (!cur.instanceId && g.instanceId) cur.instanceId = g.instanceId
    if (!cur.name && g.name) cur.name = g.name
    if (!cur.publicUrl && g.publicUrl) cur.publicUrl = g.publicUrl
  }
  return [...byKey.values()]
}

/** 本机优先 → 上次用过 → 同网段（私网地址优先，避开 198.18/198.19 这类虚拟网卡段）→ 其余。 */
export function pickBestUrl(urls, { lastUrl, lanIps } = {}) {
  const unique = []
  for (const u of urls ?? []) {
    const n = normalizeUrl(u)
    if (n && !unique.includes(n)) unique.push(n)
  }
  const last = normalizeUrl(lastUrl)
  const local = unique.find((u) => isLoopbackHost(new URL(u).hostname))
  if (local) return local
  if (last && unique.includes(last)) return last
  const same = unique.filter((u) => sameLanSubnet(u, lanIps))
  const samePrivate = same.find((u) => isPrivateIPv4(new URL(u).hostname))
  if (samePrivate) return samePrivate
  if (same.length) return same[0]
  const anyPrivate = unique.find((u) => isPrivateIPv4(new URL(u).hostname))
  if (anyPrivate) return anyPrivate
  return unique[0] || last || ''
}

export function pickGatewayUrl({ found, lastUrl, lanIps } = {}) {
  const unique = []
  for (const g of found ?? []) {
    for (const u of g.urls ?? (g.url ? [g.url] : [])) {
      const n = normalizeUrl(u)
      if (n && !unique.includes(n)) unique.push(n)
    }
  }
  return pickBestUrl(unique, { lastUrl, lanIps })
}

export function httpProbeTargets({ lastUrl, defaultPort = DEFAULT_GATEWAY_PORT, hostname, lanIps, scanSubnet = false } = {}) {
  const out = []
  const add = (u) => {
    const n = normalizeUrl(u)
    if (n && !out.includes(n)) out.push(n)
  }
  add(lastUrl)
  add(`http://127.0.0.1:${defaultPort}`)
  add(`http://localhost:${defaultPort}`)
  if (hostname) add(`http://${String(hostname).trim()}:${defaultPort}`)
  for (const ip of lanIps ?? []) {
    add(`http://${ip}:${defaultPort}`)
    if (!scanSubnet || !isPrivateIPv4(ip)) continue
    const parts = String(ip).split('.')
    const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`
    for (let i = 1; i <= 254; i++) add(`http://${prefix}.${i}:${defaultPort}`)
  }
  return out
}

async function fetchHealth(url, { fetchFn, timeoutMs }) {
  const healthUrl = `${String(url).replace(/\/+$/, '')}/health`
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => ac?.abort(), timeoutMs)
  try {
    const res = await fetchFn(healthUrl, ac ? { signal: ac.signal } : {})
    if (!res?.ok) return null
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

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
    try { sock.setBroadcast(true) } catch { /* 某些网卡不允许广播 */ }
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
        const json = await fetchHealth(url, { fetchFn, timeoutMs })
        const g = parseHealthHello(json, url)
        if (g) addGw({ ...g, urls: [g.url], instanceId: g.instanceId })
      } catch {
        /* 这个地址上没有网关 */
      }
    }
  }
  const n = Math.min(concurrency, Math.max(targets.length, 0))
  if (!n) return
  await Promise.all(Array.from({ length: n }, () => worker()))
}

/** 只留下从本机真的连得通的广告地址。 */
async function filterReachableUrls(gateways, { fetchFn, timeoutMs }) {
  const next = []
  for (const g of gateways) {
    const ok = []
    await Promise.all((g.urls ?? []).map(async (url) => {
      try {
        const json = await fetchHealth(url, { fetchFn, timeoutMs })
        const parsed = parseHealthHello(json, url)
        if (!parsed) return
        if (g.instanceId && parsed.instanceId && parsed.instanceId !== g.instanceId) return
        ok.push(url)
      } catch {
        /* 广告地址从本机走不通 */
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

/**
 * 找网关：先探本机（Windows 服务 / 开发网关）→ 再 UDP 广播/组播 → 最后 HTTP /24 扫描。
 * 任何一步找到就停，避免无谓的整段扫描。
 */
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
  const port = defaultPort ?? portFromUrl(lastUrl, DEFAULT_GATEWAY_PORT)
  const ips = lanIps ?? listLanIPv4()
  const finish = async ({ probe = false } = {}) => {
    if (probe && found.length) {
      const probed = await filterReachableUrls(found, { fetchFn, timeoutMs: Math.min(timeoutMs, 400) })
      found.splice(0, found.length, ...probed)
    }
    const gateways = found.map((g) => ({ ...g, urls: orderGatewayUrls(g.urls, { lastUrl, lanIps: ips }) }))
    // 只有真的应答过的地址才算 picked：找不到就返回空串，别把没应答的 lastUrl 当成结果。
    const reachable = gateways.flatMap((g) => g.urls ?? [])
    return {
      gateways,
      picked: reachable.length ? pickBestUrl(reachable, { lastUrl, lanIps: ips }) || '' : '',
      lanIps: ips,
    }
  }

  if (httpProbe) {
    await httpDiscover({
      targets: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
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

/**
 * 带 TTL 缓存与「同一时刻只跑一次」的发现器。
 * 侧边栏反复开合、状态推送都不该重新扫一遍局域网。
 */
export class GatewayFinder {
  constructor({ discover = discoverGateways, ttlMs = 30_000, now = () => Date.now() } = {}) {
    this.discover = discover
    this.ttlMs = ttlMs
    this.now = now
    this.cache = null
    this.inflight = null
  }

  async find({ lastUrl, force = false, ...rest } = {}) {
    if (!force && this.cache && this.now() - this.cache.at < this.ttlMs) return { ...this.cache.result, cached: true }
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      try {
        const result = await this.discover({ lastUrl, ...rest })
        this.cache = { at: this.now(), result }
        return { ...result, cached: false }
      } finally {
        this.inflight = null
      }
    })()
    return this.inflight
  }
}
