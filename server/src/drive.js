/**
 * 公司盘（Company Drive）：
 *   _shared/_memory/<层>/…   共享经验（全员只读；管理员/总监可写；05-logs 全员可追加）
 *   _shared/handbook/…       岗位手册（全员只读；管理员可写）
 *   _shared/skills/…         公司技能（SKILL.md；全员只读；管理员可写）
 *   _office/<账号>/_memory/… 个人记忆（一人一座，跟人走；仅本人读写，管理员可读）
 *   projects/inbox/<任务ID>/… 任务交付物（任务相关人可读；提交人可写）
 *
 * 所有路径均为相对公司盘根目录的 POSIX 风格路径，按用户做隔离校验。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { HttpError } from './http.js'

const BUNDLED_SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'company-briefing', 'SKILL.md')

export const MEMORY_LAYERS = [
  { dir: '01-projects', label: '项目' },
  { dir: '02-methods', label: '方法' },
  { dir: '03-evidence', label: '证据' },
  { dir: '04-reviews', label: '复盘' },
  { dir: '05-logs', label: '日志（追加）' },
  { dir: '90-system', label: '系统/规定（追加）' },
]

export function normalizeRel(p) {
  if (typeof p !== 'string') throw new HttpError(400, '路径必须是字符串', 'bad_path')
  const cleaned = p.replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = []
  for (const seg of cleaned.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') throw new HttpError(400, '路径不允许包含 ..', 'bad_path')
    if (/[<>:"|?*\u0000-\u001f]/.test(seg)) throw new HttpError(400, `路径包含非法字符: ${seg}`, 'bad_path')
    parts.push(seg)
  }
  return parts.join('/')
}

export class Drive {
  /**
   * @param {string} root 公司盘根目录
   * @param {(taskId: string) => any} taskLookup 用于 inbox 权限判断
   */
  constructor(root, taskLookup) {
    this.root = root
    this.taskLookup = taskLookup
    fs.mkdirSync(root, { recursive: true })
  }

  abs(rel) {
    const n = normalizeRel(rel)
    const full = path.resolve(this.root, n)
    if (!full.startsWith(path.resolve(this.root))) throw new HttpError(400, '路径越界', 'bad_path')
    return full
  }

  /**
   * 建空目录结构。`seedSamples: true` 才写入岗位手册 / 示例技能（开发机）；
   * 安装版空库只留目录，不出现假内容。
   */
  ensureLayout({ seedSamples = false } = {}) {
    for (const layer of MEMORY_LAYERS) fs.mkdirSync(path.join(this.root, '_shared', '_memory', layer.dir), { recursive: true })
    fs.mkdirSync(path.join(this.root, '_shared', 'handbook'), { recursive: true })
    fs.mkdirSync(path.join(this.root, '_shared', 'skills'), { recursive: true })
    fs.mkdirSync(path.join(this.root, 'projects', 'inbox'), { recursive: true })
    const readme = path.join(this.root, '_shared', '_memory', 'README.md')
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(
        readme,
        [
          '# 共享经验（_shared/_memory）',
          '',
          '全员只读。按层放入项目、方法、证据、复盘与日志。',
          '',
          '| 层 | 用途 |',
          '| --- | --- |',
          ...MEMORY_LAYERS.map((l) => `| \`${l.dir}\` | ${l.label} |`),
          '',
        ].join('\n'),
      )
    }
    if (!seedSamples) return
    fs.mkdirSync(path.join(this.root, '_shared', 'skills', 'company-briefing'), { recursive: true })
    const handbook = path.join(this.root, '_shared', 'handbook', '00-岗位手册-总则.md')
    if (!fs.existsSync(handbook)) {
      fs.writeFileSync(
        handbook,
        [
          '# 岗位手册 / 公司技能手册（总则）',
          '',
          '1. 地图上的 how 已经是结论：有就按那条做，没有就说明没有，不要自己发明流程。',
          '2. 交付以任务卡为准：产物放进 `projects/inbox/<任务ID>/`，口头完成不算完成。',
          '3. 复盘写进 `_shared/_memory/04-reviews/`，个人经验写进自己的 `_office/<账号>/_memory/`。',
          '',
        ].join('\n'),
      )
    }
    const skill = path.join(this.root, '_shared', 'skills', 'company-briefing', 'SKILL.md')
    if (!fs.existsSync(skill)) {
      if (fs.existsSync(BUNDLED_SKILL)) fs.copyFileSync(BUNDLED_SKILL, skill)
      else {
        fs.writeFileSync(
          skill,
          ['---', 'name: company-briefing', 'description: 公司交付工作台怎么用。', '---', '', '# 公司交付简报', '', '以任务卡为准，产物进 inbox，四格验收。', ''].join('\n'),
        )
      }
    }
  }

  ensureOffice(username) {
    for (const layer of MEMORY_LAYERS) fs.mkdirSync(path.join(this.root, '_office', username, '_memory', layer.dir), { recursive: true })
  }

  ensureInbox(taskId) {
    fs.mkdirSync(path.join(this.root, 'projects', 'inbox', taskId), { recursive: true })
  }

  zoneOf(rel) {
    const parts = normalizeRel(rel).split('/')
    if (parts[0] === '_shared') {
      if (parts[1] === 'handbook') return { zone: 'handbook', parts }
      if (parts[1] === 'skills') return { zone: 'skills', parts }
      return { zone: 'shared', parts }
    }
    if (parts[0] === '_office') return { zone: 'personal', owner: parts[1], parts }
    if (parts[0] === 'projects' && parts[1] === 'inbox') return { zone: 'inbox', taskId: parts[2], parts }
    return { zone: 'other', parts }
  }

  canRead(user, rel) {
    const z = this.zoneOf(rel)
    if (z.zone === 'shared' || z.zone === 'handbook' || z.zone === 'skills') return true
    if (z.zone === 'personal') return user.role === 'admin' || z.owner === user.username || z.owner === undefined
    if (z.zone === 'inbox') {
      if (user.role === 'admin' || user.role === 'director') return true
      if (!z.taskId) return true // 列 inbox 根：后续按任务过滤
      const t = this.taskLookup?.(z.taskId)
      if (!t) return false
      return [t.assigneeId, t.assignerId, t.reviewerId, t.finalReviewerId].includes(user.id)
    }
    return user.role === 'admin'
  }

  /** @returns {'full'|'append'|false} */
  canWrite(user, rel) {
    const z = this.zoneOf(rel)
    if (z.zone === 'handbook' || z.zone === 'skills') return user.role === 'admin' ? 'full' : false
    if (z.zone === 'shared') {
      if (user.role === 'admin' || user.role === 'director') return 'full'
      return z.parts[2] === '05-logs' ? 'append' : false
    }
    if (z.zone === 'personal') return z.owner === user.username || user.role === 'admin' ? 'full' : false
    if (z.zone === 'inbox') {
      if (!z.taskId) return false
      if (user.role === 'admin') return 'full'
      const t = this.taskLookup?.(z.taskId)
      if (!t) return false
      return t.assigneeId === user.id || t.assignerId === user.id ? 'full' : false
    }
    return false
  }

  stat(rel) {
    const full = this.abs(rel)
    try {
      const st = fs.statSync(full)
      return { exists: true, isDir: st.isDirectory(), size: st.size, mtime: st.mtime.toISOString() }
    } catch (err) {
      if (err.code === 'ENOENT') return { exists: false }
      throw err
    }
  }

  list(rel = '') {
    const full = this.abs(rel)
    if (!fs.existsSync(full)) return []
    return fs
      .readdirSync(full, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.'))
      .map((d) => {
        const st = fs.statSync(path.join(full, d.name))
        return { name: d.name, path: normalizeRel(`${rel}/${d.name}`), isDir: d.isDirectory(), size: d.isDirectory() ? 0 : st.size, mtime: st.mtime.toISOString() }
      })
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh-Hans-CN') : a.isDir ? -1 : 1))
  }

  read(rel) {
    return fs.readFileSync(this.abs(rel))
  }

  write(rel, data, { append = false } = {}) {
    const full = this.abs(rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    if (append) fs.appendFileSync(full, data)
    else fs.writeFileSync(full, data)
    const st = fs.statSync(full)
    return { path: normalizeRel(rel), size: st.size, mtime: st.mtime.toISOString() }
  }

  remove(rel) {
    const full = this.abs(rel)
    fs.rmSync(full, { recursive: true, force: true })
  }

  /** 递归枚举用户可读的全部文件（用于客户端本机同步）。 */
  snapshot(user, roots = ['_shared', `_office/${user.username}`, 'projects/inbox']) {
    const files = []
    const walk = (rel) => {
      const full = this.abs(rel)
      if (!fs.existsSync(full)) return
      for (const d of fs.readdirSync(full, { withFileTypes: true })) {
        if (d.name.startsWith('.')) continue
        const childRel = normalizeRel(`${rel}/${d.name}`)
        if (d.isDirectory()) {
          if (!this.canRead(user, childRel)) continue
          walk(childRel)
        } else {
          if (!this.canRead(user, childRel)) continue
          const st = fs.statSync(path.join(full, d.name))
          if (st.size > 20 * 1024 * 1024) continue
          const buf = fs.readFileSync(path.join(full, d.name))
          files.push({ path: childRel, size: st.size, mtime: st.mtime.toISOString(), sha256: crypto.createHash('sha256').update(buf).digest('hex') })
        }
      }
    }
    for (const r of roots) walk(r)
    return files
  }
}
