/**
 * 轻量行级差异：给改动卡片算 +N/−M。
 * 不做完整 LCS（大文件会吃内存），只裁掉首尾相同行，把中间算作「改动的行」——
 * 单处编辑完全准确，多处编辑给的是近似值，用于展示足够。
 */

export const MAX_DIFF_CHARS = 512 * 1024

export function splitLines(text) {
  const s = String(text ?? '')
  if (!s) return []
  const body = s.endsWith('\n') ? s.slice(0, -1) : s
  return body.split('\n')
}

export function diffStat(before, after) {
  const a = splitLines(before)
  const b = splitLines(after)
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++
  return {
    added: b.length - prefix - suffix,
    removed: a.length - prefix - suffix,
    unchanged: prefix + suffix,
  }
}

/** 摘要给 webview 用：不带正文，只带计数与标记。 */
export function summarizeChange({ path: relPath, before = '', after = '', created = false } = {}) {
  const tooLarge = String(before).length > MAX_DIFF_CHARS || String(after).length > MAX_DIFF_CHARS
  const { added, removed } = diffStat(before, after)
  return {
    path: relPath,
    created: !!created,
    added,
    removed,
    tooLarge,
    hasDiff: !tooLarge && String(before) !== String(after),
  }
}

/** 同一会话里对同一文件多次写入：保留最早的 before 和最新的 after。 */
export class FileChangeLog {
  constructor({ maxChars = MAX_DIFF_CHARS } = {}) {
    this.maxChars = maxChars
    this.map = new Map()
  }

  #key(sessionId, relPath) {
    return `${sessionId ?? ''}\u0000${relPath}`
  }

  record(sessionId, change) {
    const relPath = change?.path
    if (!relPath) return null
    const key = this.#key(sessionId, relPath)
    const prev = this.map.get(key)
    const entry = {
      path: relPath,
      abs: change.abs ?? prev?.abs ?? null,
      before: prev ? prev.before : String(change.before ?? ''),
      after: String(change.after ?? ''),
      created: prev ? prev.created : !!change.created,
      at: new Date().toISOString(),
      sessionId: sessionId ?? null,
    }
    this.map.set(key, entry)
    return entry
  }

  get(sessionId, relPath) {
    return this.map.get(this.#key(sessionId, relPath)) ?? null
  }

  list(sessionId, paths) {
    const wanted = paths ? new Set(paths) : null
    const out = []
    for (const entry of this.map.values()) {
      if (entry.sessionId !== (sessionId ?? null)) continue
      if (wanted && !wanted.has(entry.path)) continue
      out.push(entry)
    }
    return out
  }

  /** 供 webview 显示的摘要（无正文）。 */
  summaries(sessionId, paths) {
    return this.list(sessionId, paths).map((e) => summarizeChange(e))
  }

  clear(sessionId) {
    for (const [key, entry] of this.map) {
      if (entry.sessionId === (sessionId ?? null)) this.map.delete(key)
    }
  }
}
