import path from 'node:path'

export function zoneRoot(zone, username) {
  if (zone === 'personal') return `_office/${username}/_memory`
  if (zone === 'shared') return '_shared/_memory'
  if (zone === 'handbook') return '_shared/handbook'
  throw new Error(`未知公司盘分区：${zone}`)
}

export function assertInside(root, rel) {
  const full = path.resolve(root, rel)
  if (full !== root && !full.startsWith(path.resolve(root) + path.sep)) throw new Error(`路径越出镜像根目录：${rel}`)
  return full
}
