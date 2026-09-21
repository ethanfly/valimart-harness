/**
 * 工作区文件索引：给 @ 补全面板用。
 * 扫描一次缓存住（TTL），查询是纯函数，方便单测。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 这些目录几乎没人想 @，扫进来只会让面板变慢变吵。 */
export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'out', 'dist', 'build', 'coverage',
  '.vscode-test', '.next', '.nuxt', '.turbo', '.cache', '__pycache__', '.dsh', '.omc',
])

export const SCAN_DEFAULTS = { maxFiles: 20_000, maxDepth: 8 }

/** 深度优先列出工作区相对路径（POSIX 分隔），带 mtime 用于「最近改动的文件」排序。 */
export function scanWorkspace(workspaceRoot, { maxFiles = SCAN_DEFAULTS.maxFiles, maxDepth = SCAN_DEFAULTS.maxDepth } = {}) {
  const root = path.resolve(workspaceRoot)
  const files = []
  const walk = (dir, rel, depth) => {
    if (files.length >= maxFiles || depth > maxDepth) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 权限/竞态：跳过，不让面板报错
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return
      if (entry.name.startsWith('.') && entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      let mtimeMs = 0
      try {
        mtimeMs = fs.statSync(path.join(dir, entry.name)).mtimeMs
      } catch {
        /* 拿不到时间就不参与「最近」排序 */
      }
      files.push({ path: relPath, mtimeMs })
    }
  }
  walk(root, '', 1)
  return files
}

function subsequence(needle, haystack) {
  let i = 0
  for (const ch of haystack) {
    if (ch === needle[i]) i++
    if (i === needle.length) return true
  }
  return needle.length === 0
}

/**
 * 排序打分：文件名前缀 > 文件名包含 > 路径包含 > 段前缀 > 稀疏子序列。
 * 命中越靠文件名、路径越短、层级越浅、改得越近，排得越前。
 */
export function scorePath(entry, query) {
  const p = entry.path
  const base = p.slice(p.lastIndexOf('/') + 1).toLowerCase()
  const lower = p.toLowerCase()
  const q = query.toLowerCase()
  let score = 0
  if (base === q) score = 1000
  else if (base.startsWith(q)) score = 700
  else if (base.includes(q)) score = 500
  else if (lower.includes(q)) score = 300
  else if (q.includes('/') ? lower.includes(q) : subsequence(q, lower)) score = 120
  else return 0
  if (score) {
    // `@slash` 该把 slash.js 排在 slash.test.js 前面：去掉扩展名后完全同名要给大加分。
    if (base.replace(/\.[^.]+$/, '') === q) score += 250
    score -= Math.min(80, p.length / 4) // 短路径优先
    score -= (p.split('/').length - 1) * 8 // 浅层优先
    if (base.startsWith(q) || base === q) score += 40
  }
  return score
}

/** 纯函数查询：query 为空时按 mtime 返回最近改动的文件。 */
export function searchWorkspacePaths(entries, query, { limit = 24 } = {}) {
  const q = String(query ?? '').trim().replace(/^\/+/, '')
  if (!q) {
    return [...entries]
      .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0) || a.path.localeCompare(b.path))
      .slice(0, limit)
      .map((e) => e.path)
  }
  return entries
    .map((e) => ({ path: e.path, score: scorePath(e, q) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((e) => e.path)
}

/** 带 TTL 缓存的索引；工作区根目录变化或 force 时重扫。 */
export class WorkspaceIndex {
  constructor({ getWorkspaceRoot, ttlMs = 15_000, scan = scanWorkspace } = {}) {
    this.getWorkspaceRoot = getWorkspaceRoot
    this.ttlMs = ttlMs
    this.scan = scan
    this.root = null
    this.at = 0
    this.entries = []
  }

  refresh() {
    const root = this.getWorkspaceRoot?.() ?? null
    this.entries = root ? this.scan(root) : []
    this.root = root
    this.at = Date.now()
    return this.entries
  }

  ensure({ force = false } = {}) {
    const root = this.getWorkspaceRoot?.() ?? null
    if (!root) return (this.entries = [])
    if (force || root !== this.root || Date.now() - this.at > this.ttlMs) this.refresh()
    return this.entries
  }

  /** @ 面板用：返回 { paths, root } —— root 为空时前端提示「先打开工作区」。 */
  search(query, { limit = 24, force = false } = {}) {
    const entries = this.ensure({ force })
    return { paths: searchWorkspacePaths(entries, query, { limit }), root: this.root }
  }
}
