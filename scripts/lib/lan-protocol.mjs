/**
 * 局域网发现协议（网关 UDP 信标 ↔ 客户端探测）共用：编码、本机网卡、广告 URL、挑选默认地址。
 * 不携带账号 / 令牌 / 密钥，只广播公司名与可达 URL。
 */
import os from 'node:os'

export const LAN_PRODUCT = 'valimart-harness'
export const LAN_PROTO = 1
export const LAN_UDP_PORT = 18790
export const LAN_MULTICAST = '239.255.87.90'

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
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip)
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

export function advertisedUrls({ httpPort, publicUrl, hostname, lanIps }) {
  const urls = []
  const add = (u) => {
    const n = normalizeUrl(u)
    if (!n || urls.includes(n)) return
    try {
      const host = new URL(n).hostname
      if (host === '0.0.0.0' || host === '::') return
      urls.push(n)
    } catch {
      /* skip */
    }
  }
  for (const ip of lanIps ?? []) add(`http://${ip}:${httpPort}`)
  const host = String(hostname ?? '').trim().toLowerCase()
  if (host && !isLoopbackHost(host)) add(`http://${host}:${httpPort}`)
  const pub = normalizeUrl(publicUrl)
  if (pub) {
    const ph = new URL(pub).hostname
    if (!isLoopbackHost(ph) && ph !== '0.0.0.0') add(pub)
  }
  if (urls.length === 0) add(`http://127.0.0.1:${httpPort}`)
  return urls
}

export function pickGatewayUrl({ found, lastUrl } = {}) {
  const last = normalizeUrl(lastUrl)
  const unique = []
  for (const g of found ?? []) {
    for (const u of g.urls ?? (g.url ? [g.url] : [])) {
      const n = normalizeUrl(u)
      if (n && !unique.includes(n)) unique.push(n)
    }
  }
  if (last && unique.includes(last)) {
    const lastLoop = isLoopbackHost(new URL(last).hostname)
    const hasLan = unique.some((u) => !isLoopbackHost(new URL(u).hostname))
    if (!(lastLoop && hasLan)) return last
  }
  return unique.find((u) => !isLoopbackHost(new URL(u).hostname)) || unique[0] || last || ''
}

export function httpProbeTargets({ lastUrl, defaultPort = 8790, hostname, lanIps, scanSubnet = false } = {}) {
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
    const parts = ip.split('.')
    const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`
    for (let i = 1; i <= 254; i++) add(`http://${prefix}.${i}:${defaultPort}`)
  }
  return out
}

export function parseHealthHello(json, originUrl) {
  if (!json || json.ok !== true || json.product !== LAN_PRODUCT) return null
  const url = normalizeUrl(originUrl)
  if (!url) return null
  return {
    url,
    name: json.name ?? json.companyName ?? '',
    needsSetup: !!json.needsSetup,
    publicUrl: json.publicUrl ?? url,
    source: 'http',
  }
}

export function portFromUrl(u, fallback = 8790) {
  try {
    const p = Number(new URL(u).port)
    return p > 0 ? p : fallback
  } catch {
    return fallback
  }
}
