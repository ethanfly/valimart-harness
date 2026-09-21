/**
 * @ 提及：把用户在工作区里的文件「引用」进这一轮对话。
 *
 * 只做纯函数：从文本里抽出 @path、按工作区读取并内联、拼成给模型的上下文块。
 * 读文件复用 workspace-fs 的 resolveSafe，绝不越出工作区根目录。
 */
import fs from 'node:fs'
import { resolveSafe } from './workspace-fs.js'

/** 一次最多内联多少个 @文件；超出的只把路径告诉模型，让它自己 read_file。 */
export const MAX_MENTIONS = 8
/** 单文件内联上限（字符）。 */
export const MENTION_FILE_CHARS = 24_000
/** 本轮所有 @文件 内联总量上限（字符）。 */
export const MENTION_TOTAL_CHARS = 96_000

const TRAILING_PUNCT = /[.,;:!?、。）)】」』》"'`]+$/
/** @ 前面允许出现什么：行首或空白/中文标点，用来排除 email@host 这种。 */
const ALLOWED_BEFORE = /(^|[\s（(【「，。；：！？、,;:])$/

/**
 * 抽出 @ 提及。返回 [{ path, raw, start, end }]，按出现顺序去重，最多 MAX_MENTIONS 个。
 * 支持 `@src/lib/a.js`、`@./a.js`、`@media/`；不匹配邮箱、不匹配裸 `@`。
 */
export function extractMentions(text) {
  const raw = String(text ?? '')
  const out = []
  const seen = new Set()
  const re = /@(\S*)/g
  let m
  while ((m = re.exec(raw))) {
    const before = raw.slice(0, m.index)
    if (before && !ALLOWED_BEFORE.test(before)) continue // 邮箱、变量名里的 @
    const token = (m[1] ?? '').replace(TRAILING_PUNCT, '')
    if (!token) continue
    const path = token.replaceAll('\\', '/').replace(/^\.\//, './')
    if (!path || path === '/') continue
    if (seen.has(path)) continue
    seen.add(path)
    if (out.length >= MAX_MENTIONS) continue
    out.push({ path, raw: `@${token}`, start: m.index, end: m.index + 1 + token.length })
  }
  return out
}

/** 只保留看起来像文件/目录的提及（用于「这条消息引用了什么」的展示）。 */
export function mentionPaths(text) {
  return extractMentions(text).map((m) => m.path)
}

function looksBinary(contents) {
  return contents.includes('\u0000') || /\uFFFD/.test(contents.slice(0, 1024))
}

/**
 * 读取 @ 提及指向的工作区文件。永不抛错：读不到就进 missing，让模型知道路径自己去查。
 * @returns {{ attachments: Array<{path, contents, truncated, bytes}>, missing: Array<{path, reason}>, chars: number }}
 */
export function resolveMentions({ workspaceRoot, text, mentions } = {}) {
  const list = mentions ?? extractMentions(text)
  const attachments = []
  const missing = []
  let chars = 0
  if (!workspaceRoot) {
    return { attachments, missing: list.map((m) => ({ path: m.path, reason: '没有打开工作区' })), chars: 0 }
  }
  for (const mention of list) {
    try {
      const abs = resolveSafe(workspaceRoot, mention.path)
      if (!fs.existsSync(abs)) {
        missing.push({ path: mention.path, reason: '工作区里没有这个路径' })
        continue
      }
      const stat = fs.statSync(abs)
      if (!stat.isFile()) {
        missing.push({ path: mention.path, reason: '是目录，不是文件（可以让 Agent 用 list_dir 看里面）' })
        continue
      }
      const raw = fs.readFileSync(abs, 'utf8')
      if (looksBinary(raw)) {
        missing.push({ path: mention.path, reason: '二进制文件，未内联' })
        continue
      }
      const room = Math.max(0, MENTION_TOTAL_CHARS - chars)
      const budget = Math.min(MENTION_FILE_CHARS, room)
      if (budget <= 0) {
        missing.push({ path: mention.path, reason: '本轮 @ 内联额度已用满' })
        continue
      }
      const truncated = raw.length > budget
      const contents = truncated ? raw.slice(0, budget) : raw
      chars += contents.length
      attachments.push({ path: mention.path, contents, truncated, bytes: stat.size, totalChars: raw.length })
    } catch (err) {
      missing.push({ path: mention.path, reason: String(err?.message ?? err).slice(0, 120) })
    }
  }
  return { attachments, missing, chars }
}

const fence = (contents) => {
  // 文件里本身有 ``` 时把围栏加长，避免提前闭合。
  const longest = /`{3,}/g.exec(contents)?.[0]?.length ?? 2
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}file\n${contents}\n${ticks}`
}

/** 拼成追加到用户消息后面的上下文块；没有内容时返回空串。 */
export function formatMentionBlock({ attachments = [], missing = [] } = {}) {
  if (!attachments.length && !missing.length) return ''
  const parts = []
  if (attachments.length) {
    parts.push(
      `【@ 引用文件】用户在本条消息里用 @ 引用了 ${attachments.length} 个工作区文件，内容已随消息提供，不要再对这些路径调用 read_file：`,
    )
    for (const a of attachments) {
      const note = a.truncated
        ? `已截断，仅内联前 ${a.contents.length} / ${a.totalChars} 字符，需要后半部分请带 offset 再读`
        : `${a.contents.length} 字符`
      parts.push(`\n@${a.path} （${note}）\n${fence(a.contents)}`)
    }
  }
  if (missing.length) {
    parts.push(
      `\n【未能内联】${missing.map((m) => `@${m.path}（${m.reason}）`).join('；')}。如确有必要，请用 list_dir / read_file 自行确认路径。`,
    )
  }
  return parts.join('\n')
}
