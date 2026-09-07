/**
 * 网关 UDP 信标：回答客户端 hello，只广播公司名与可达 URL。
 */
import dgram from 'node:dgram'
import os from 'node:os'
import { LAN_UDP_PORT, LAN_MULTICAST, encodeLanMessage, decodeLanMessage, listLanIPv4, advertisedUrls } from '../../scripts/lib/lan-protocol.mjs'

export function shouldStartLanBeacon(cfg) {
  if (cfg.lanDiscover === false) return false
  if (cfg.lanDiscover === true) return true
  if (process.env.NODE_TEST_CONTEXT) return false
  return true
}

export function createLanBeacon({
  httpPort,
  publicUrl,
  companyName,
  needsSetup,
  instanceId,
  udpPort = LAN_UDP_PORT,
  hostname = os.hostname(),
  log = console.log,
}) {
  let socket = null

  const payload = () =>
    encodeLanMessage({
      type: 'here',
      name: typeof companyName === 'function' ? companyName() : companyName,
      needsSetup: typeof needsSetup === 'function' ? !!needsSetup() : !!needsSetup,
      instanceId,
      port: httpPort,
      publicUrl,
      urls: advertisedUrls({ httpPort, publicUrl, hostname, lanIps: listLanIPv4() }),
    })

  const start = () =>
    new Promise((resolve) => {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      socket.on('message', (msg, rinfo) => {
        const m = decodeLanMessage(msg)
        if (m?.type !== 'hello') return
        try {
          socket.send(payload(), rinfo.port, rinfo.address)
        } catch {
          /* 对端已关 */
        }
      })
      socket.once('error', (err) => {
        log(`[gateway] 局域网发现未启动：${err.message}`)
        socket = null
        resolve(null)
      })
      socket.bind(udpPort, () => {
        try { socket.setBroadcast(true) } catch { /* 忽略 */ }
        try { socket.addMembership(LAN_MULTICAST) } catch { /* 组播可选 */ }
        log(`[gateway] 局域网发现 UDP ${udpPort}`)
        resolve(socket)
      })
    })

  const close = () =>
    new Promise((resolve) => {
      if (!socket) return resolve()
      const s = socket
      socket = null
      s.close(() => resolve())
    })

  return { start, close }
}
