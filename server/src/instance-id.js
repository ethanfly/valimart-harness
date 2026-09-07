/**
 * 网关稳定实例 id：给局域网发现按「一台网关」去重，不随网卡 IP 变化。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export function loadInstanceId(dataDir) {
  const file = path.join(dataDir, 'instance-id')
  try {
    const id = fs.readFileSync(file, 'utf8').trim()
    if (id.length >= 8) return id
  } catch {
    /* 首次启动 */
  }
  const id = crypto.randomUUID()
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(file, `${id}\n`, 'utf8')
  return id
}
