import path from 'node:path'

/** 公司盘分区根路径（相对镜像根）。 */
export function zoneRoot(zone, username) {
  const me = String(username ?? '').trim()
  if (!me) throw new Error('未登录公司网关')
  if (zone === 'personal') return `_office/${me}/_memory`
  if (zone === 'shared') return '_shared/_memory'
  if (zone === 'handbook') return '_shared/handbook'
  if (zone === 'skills') return '_shared/skills'
  throw new Error(`未知 zone ${zone}`)
}

export function assertInside(root, rel) {
  const rootRes = path.resolve(root)
  const full = path.resolve(root, rel)
  if (full !== rootRes && !full.startsWith(rootRes + path.sep)) throw new Error('路径越界')
  return full
}

/** Agent 用桌面同一套相对路径读本机镜像：_shared / _office / projects */
export function isCompanyDriveRel(relPath) {
  const n = String(relPath ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
  if (n === 'README.md' || n === '_shared' || n === '_office' || n === 'projects') return true
  return n.startsWith('_shared/') || n.startsWith('_office/') || n.startsWith('projects/')
}
