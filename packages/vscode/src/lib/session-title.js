/**
 * 会话自动标题：跟参考工作台一样，用首条用户消息生成单行标题；
 * 去 Markdown、压空白、超长截断。手动重命名后不要覆盖。
 */
export const DEFAULT_SESSION_TITLE = '新会话'
export const DEFAULT_TITLE_MAX = 28

export function autoSessionTitle(text, { max = DEFAULT_TITLE_MAX } = {}) {
  let s = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return DEFAULT_SESSION_TITLE
  if (s.length > max) s = `${s.slice(0, max).trimEnd()}…`
  return s
}

export function shouldAutoTitle(chat) {
  if (!chat) return false
  if (chat.titleLocked) return false
  const title = String(chat.title ?? '').trim()
  return !title || title === DEFAULT_SESSION_TITLE
}
