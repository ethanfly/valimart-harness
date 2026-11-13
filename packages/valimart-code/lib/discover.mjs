/**
 * 找公司网关：本机 / 记下的地址走 HTTP /health，同时发一轮 UDP hello（协议见 scripts/lib/lan-protocol.mjs，与桌面、pi、Claude 插件相同）。
 * 网关常在另一个网段，广播到不了；所以把本机 pi / Claude 插件 / 桌面客户端记下的网关地址也探一遍（只读地址，不碰它们的令牌）。
 */
import dgram from 'node:dgram'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LAN_MULTICAST,
  LAN_UDP_PORT,
  decodeLanMessage,
  encodeLanMessage,
  mergeGateways,
  normalizeUrl,
  parseHealthHello,
} from './lan-protocol.mjs'
import { loadState } from './state.mjs'

export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8790'

export function knownGatewayUrls({ home = os.homedir(), env = process.env } = {}) {
  const files = [
    path.join(env.PI_CODING_AGENT_DIR || env.PI_AGENT_DIR || path.join(home, '.pi', 'agent'), 'valimart-desk.json'),
    path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'valimart-desk.json'),
    path.join(env.DSH_HOME || path.join(home, '.dsh'), 'desk', 'desk-state.json'),
  ]
  const urls = []
  for (const file of files) {
    try {
      const url = normalizeUrl(JSON.parse(fs.readFileSync(file, 'utf8')).gatewayUrl)
      if (url && !urls.includes(url)) urls.push(url)
    } catch {
      /* 没装那个客户端 */
    }
  }
  return urls
}

async function probeHealth(url, timeoutMs) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    const hello = parseHealthHello(await res.json(), url)
    if (!hello) return null
    // 只列探通的那个地址：/health 里的 publicUrl 可能是网关自己填的、本机到不了的地址
    return { name: hello.name, instanceId: hello.instanceId, needsSetup: hello.needsSetup, urls: [hello.url], source: 'http' }
  } catch {
    return null
  }
}

async function udpDiscover(timeoutMs) {
  const found = []
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  try {
    await new Promise((resolve, reject) => {
      sock.once('error', reject)
      sock.bind(0, () => resolve())
    })
  } catch {
    try {
      sock.close()
    } catch {
      /* ignore */
    }
    return found
  }
  sock.on('error', () => {})
  sock.on('message', (buf) => {
    const m = decodeLanMessage(buf)
    if (m?.type !== 'here') return
    found.push({
      name: m.name ?? '',
      instanceId: m.instanceId,
      needsSetup: !!m.needsSetup,
      urls: [...(Array.isArray(m.urls) ? m.urls : []), m.publicUrl].filter(Boolean),
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
    const hello = encodeLanMessage({ type: 'hello' })
    for (const host of ['127.0.0.1', '255.255.255.255', LAN_MULTICAST]) {
      try {
        sock.send(hello, LAN_UDP_PORT, host)
      } catch {
        /* ignore */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, timeoutMs))
  } finally {
    try {
      sock.close()
    } catch {
      /* ignore */
    }
  }
  return found
}

/** 发现失败（无网卡 / 权限）不挡登录：返回空列表，调用方退回手填。 */
export async function discoverGateways({ timeoutMs = 900, extraUrls = [] } = {}) {
  try {
    const targets = [...new Set([loadState().gatewayUrl, ...extraUrls, ...knownGatewayUrls(), DEFAULT_GATEWAY_URL].map(normalizeUrl).filter(Boolean))]
    const [http, udp] = await Promise.all([Promise.all(targets.map((url) => probeHealth(url, timeoutMs + 600))), udpDiscover(timeoutMs)])
    return mergeGateways([...http.filter(Boolean), ...udp])
  } catch {
    return []
  }
}
