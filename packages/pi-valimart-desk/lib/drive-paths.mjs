import path from 'node:path'

/** 公司盘分区根路径（相对镜像根）。 */
export function zoneRoot(zone, username) {
  const me = String(username ?? '').trim()
  if (!me) throw new Error('未登录公司网关')
  if (zone === 'personal') return `_office/${me}/_memory`
  if (zone === 'shared') return '_shared/_memory'
  if (zone === 'handbook') return '_shared/handbook'
  throw new Error(`未知 zone ${zone}`)
}

export function assertInside(root, rel) {
  const rootRes = path.resolve(root)
  const full = path.resolve(root, rel)
  if (full !== rootRes && !full.startsWith(rootRes + path.sep)) throw new Error('路径越界')
  return full
}
