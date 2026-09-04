/**
 * 知识检索（企业知识库的第四层通道）：开工前问「公司里有没有人做过」。
 *
 * 检索范围 = 该用户可读的公司盘文本（岗位手册 / 共享经验 / 自己的个人记忆 / 与自己有关的任务格子）
 *           + 任务卡本身（标题 / 任务内容 / 提交内容 / 工作日志 / 交付物名）。
 * 只返回「谁、什么时候、在哪、一小段上下文」，不拷贝任何会话；要细节就去问那张任务卡旁边的进程。
 */
import fs from 'node:fs'
import path from 'node:path'
import { MEMORY_LAYERS, normalizeRel } from './drive.js'
import { TASK_STATUS } from './tasks.js'

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.yml', '.yaml', '.csv', '.tsv', '.html', '.htm', '.xml', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.ps1', '.sql', '.ini', '.toml', '.log'])
const MAX_FILE = 2 * 1024 * 1024
const SNIPPET = 90

export const KNOWLEDGE_KIND_LABELS = {
  handbook: '岗位手册',
  shared: '共享经验',
  personal: '个人记忆',
  deliverable: '交付物',
  task: '任务卡',
}

function tokensOf(q) {
  const raw = String(q ?? '')
    .trim()
    .split(/[\s,，、;；]+/u)
    .map((t) => t.trim())
    .filter(Boolean)
  // 去重、保留原顺序；最多 8 个词
  return [...new Set(raw)].slice(0, 8)
}

function countOccurrences(hay, needle) {
  if (!needle) return 0
  let n = 0
  let i = 0
  for (;;) {
    i = hay.indexOf(needle, i)
    if (i < 0) return n
    n++
    i += needle.length
  }
}

function snippetOf(text, terms) {
  const lower = text.toLowerCase()
  let at = -1
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase())
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) at = 0 // 只命中标题/文件名：给正文开头
  if (!text.trim()) return ''
  const start = Math.max(0, at - SNIPPET / 2)
  const end = Math.min(text.length, at + SNIPPET)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

/** 命中的词数 ×100 + 正文出现次数（上限 50）+ 标题/文件名命中加权（标题命中也算命中）。 */
function scoreOf(text, title, terms) {
  const lower = text.toLowerCase()
  const lowerTitle = String(title ?? '').toLowerCase()
  let matched = 0
  let occurrences = 0
  let titleHits = 0
  for (const t of terms) {
    const lt = t.toLowerCase()
    const c = countOccurrences(lower, lt)
    const inTitle = lowerTitle.includes(lt)
    if (c > 0 || inTitle) matched++
    occurrences += c
    if (inTitle) titleHits++
  }
  if (matched === 0) return 0
  return matched * 100 + Math.min(occurrences, 50) + titleHits * 30
}

export class Knowledge {
  constructor({ drive, tasks, db }) {
    this.drive = drive
    this.tasks = tasks
    this.db = db
  }

  userName(id) {
    const u = id ? this.db.getUser(id) : undefined
    return u ? u.displayName || u.username : null
  }

  userNameByUsername(username) {
    const u = username ? this.db.getUserByName(username) : undefined
    return u ? u.displayName || u.username : username ?? null
  }

  /** 该用户可检索的公司盘根：手册 + 共享 + 自己的椅子 + 与自己有关的任务格子。 */
  rootsFor(user) {
    const my = this.tasks.visibleTo(user).map((t) => `projects/inbox/${t.id}`)
    return ['_shared/handbook', '_shared/_memory', `_office/${user.username}/_memory`, ...my]
  }

  *walkTextFiles(user, roots) {
    for (const root of roots) {
      const full = (() => {
        try {
          return this.drive.abs(root)
        } catch {
          return null
        }
      })()
      if (!full || !fs.existsSync(full)) continue
      const stack = [root]
      while (stack.length) {
        const rel = stack.pop()
        const dir = this.drive.abs(rel)
        let entries
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const d of entries) {
          if (d.name.startsWith('.')) continue
          const childRel = normalizeRel(`${rel}/${d.name}`)
          if (!this.drive.canRead(user, childRel)) continue
          if (d.isDirectory()) {
            stack.push(childRel)
            continue
          }
          if (!TEXT_EXT.has(path.extname(d.name).toLowerCase())) continue
          const abs = path.join(dir, d.name)
          let st
          try {
            st = fs.statSync(abs)
          } catch {
            continue
          }
          if (st.size > MAX_FILE) continue
          yield { rel: childRel, abs, mtime: st.mtime.toISOString(), size: st.size, name: d.name }
        }
      }
    }
  }

  describeFile(rel) {
    const z = this.drive.zoneOf(rel)
    if (z.zone === 'handbook') return { kind: 'handbook', who: '公司手册', taskId: null }
    if (z.zone === 'shared') {
      const layer = MEMORY_LAYERS.find((l) => l.dir === z.parts[2])
      return { kind: 'shared', who: '公司共享', layer: layer?.label ?? null, taskId: null }
    }
    if (z.zone === 'personal') return { kind: 'personal', who: this.userNameByUsername(z.owner), taskId: null }
    if (z.zone === 'inbox') {
      const t = z.taskId ? this.tasks.get(z.taskId) : undefined
      return { kind: 'deliverable', who: t ? this.userName(t.assigneeId) : null, taskId: z.taskId ?? null, taskTitle: t?.title ?? null }
    }
    return { kind: 'other', who: null, taskId: null }
  }

  /**
   * @param {object} user
   * @param {string} q
   * @param {{ limit?: number, kinds?: string[] }} [opts]
   */
  search(user, q, { limit = 20, kinds } = {}) {
    const terms = tokensOf(q)
    if (terms.length === 0) return { query: String(q ?? ''), terms, hits: [], scanned: { files: 0, tasks: 0 } }
    const want = (k) => !Array.isArray(kinds) || kinds.length === 0 || kinds.includes(k)
    const hits = []
    let scannedFiles = 0

    // 1) 公司盘文本
    for (const f of this.walkTextFiles(user, this.rootsFor(user))) {
      // 任务格子里的任务卡副本不重复算（任务卡走第 2 步）
      if (/^projects\/inbox\/[^/]+\/_(task-card\.(md|json)|worklog\.md)$/.test(f.rel)) continue
      const meta = this.describeFile(f.rel)
      if (!want(meta.kind)) continue
      let text
      try {
        text = fs.readFileSync(f.abs, 'utf8')
      } catch {
        continue
      }
      scannedFiles++
      const score = scoreOf(text, f.name, terms)
      if (score === 0) continue
      hits.push({
        kind: meta.kind,
        kindLabel: KNOWLEDGE_KIND_LABELS[meta.kind] ?? meta.kind,
        title: f.name,
        path: f.rel,
        who: meta.who,
        when: f.mtime,
        layer: meta.layer ?? null,
        taskId: meta.taskId,
        taskTitle: meta.taskTitle ?? null,
        snippet: snippetOf(text, terms),
        score,
      })
    }

    // 2) 任务卡：谁做过、做到哪一步、过没过
    const visible = this.tasks.visibleTo(user)
    for (const t of visible) {
      if (!want('task')) break
      const parts = [t.title, t.content, t.submission, t.project, ...t.log.map((l) => l.text), ...t.deliverables.map((d) => d.name)]
      const text = parts.filter(Boolean).join('\n')
      const score = scoreOf(text, t.title, terms)
      if (score === 0) continue
      hits.push({
        kind: 'task',
        kindLabel: KNOWLEDGE_KIND_LABELS.task,
        title: t.title,
        path: `projects/inbox/${t.id}/`,
        who: this.userName(t.assigneeId),
        assigner: this.userName(t.assignerId),
        when: t.updatedAt,
        status: t.status,
        statusLabel: TASK_STATUS[t.status] ?? t.status,
        taskId: t.id,
        deliverables: t.deliverables.map((d) => d.name),
        sessions: t.sessions.length,
        snippet: snippetOf(text, terms),
        score,
      })
    }

    hits.sort((a, b) => b.score - a.score || Date.parse(b.when) - Date.parse(a.when))
    return { query: String(q), terms, hits: hits.slice(0, Math.max(1, Math.min(100, limit))), scanned: { files: scannedFiles, tasks: visible.length } }
  }

  /** 知识 / 工具合集：手册与共享经验的目录清单（管理页与 Agent 都用）。 */
  collections(user) {
    const listFiles = (root) => [...this.walkTextFiles(user, [root])].map((f) => ({ name: f.name, path: f.rel, size: f.size, mtime: f.mtime })).sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'))
    const shared = {}
    for (const layer of MEMORY_LAYERS) shared[layer.dir] = { label: layer.label, files: listFiles(`_shared/_memory/${layer.dir}`) }
    return {
      handbook: listFiles('_shared/handbook'),
      shared,
      personal: listFiles(`_office/${user.username}/_memory`),
    }
  }
}
