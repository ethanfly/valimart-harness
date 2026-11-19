/** 局域网找公司网关：UDP hello + 本机 /health，协议与桌面 / pi / Claude 插件相同。 */
import dgram from 'node:dgram'
import { normalizeGatewayUrl } from './gateway.mjs'

const LAN_UDP_PORT = 18790
const LAN_MULTICAST = '239.255.87.90'

function addGw(list, gw) {
  const urls = [...(gw.urls ?? []), gw.publicUrl].map(normalizeGatewayUrl).filter(Boolean)
  if (!urls.length) return
  const key = gw.instanceId || urls[0]
  const existing = list.find((x) => x.instanceId === key || x.urls[0] === urls[0])
  if (existing) { for (const url of urls) if (!existing.urls.includes(url)) existing.urls.push(url); return }
  list.push({ name: gw.name || 'valimart harness', instanceId: gw.instanceId || key, needsSetup: !!gw.needsSetup, urls, source: gw.source })
}

async function probeLocal(list) {
  for (const url of ['http://127.0.0.1:8790', 'http://localhost:8790']) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(800) })
      if (!res.ok) continue
      const body = await res.json().catch(() => ({}))
      addGw(list, { name: body.company || body.name || '本机网关', instanceId: body.instanceId || `local:${url}`, urls: [url], source: 'local' })
    } catch { /* 没开着 */ }
  }
}

async function udpDiscover(list, timeoutMs) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const hello = Buffer.from(JSON.stringify({ product: 'valimart-harness', proto: 1, type: 'hello' }))
  try { await new Promise((resolve, reject) => { sock.once('error', reject); sock.bind(0, resolve) }) } catch { return }
  sock.on('error', () => {})
  sock.on('message', (msg) => {
    try {
      const gw = JSON.parse(msg.toString('utf8'))
      if (gw?.product === 'valimart-harness' && gw.proto === 1 && gw.type === 'here') addGw(list, gw)
    } catch { /* 非 valimart 包 */ }
  })
  try {
    sock.setBroadcast(true)
    sock.addMembership(LAN_MULTICAST)
    for (const host of ['127.0.0.1', '255.255.255.255', LAN_MULTICAST]) sock.send(hello, LAN_UDP_PORT, host, () => {})
    await new Promise((resolve) => setTimeout(resolve, timeoutMs))
  } finally { sock.close() }
}

export async function discoverGateways({ timeoutMs = 900 } = {}) {
  const list = []
  await Promise.all([probeLocal(list), udpDiscover(list, timeoutMs)])
  return list
}

export function gatewayChoices(list) {
  return list.flatMap((gw) => gw.urls.map((url) => ({ url, label: `${gw.name}  ${url}${gw.source === 'local' ? '  （本机）' : ''}` })))
}
