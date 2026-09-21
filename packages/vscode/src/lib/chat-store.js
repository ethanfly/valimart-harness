/**
 * 会话历史落在扩展 globalStorage，跟登录令牌分开。
 * 按公司账号分桶：换电脑还能跟着账号走不了（本机存储），但同一台机重启、重登都能切回来。
 * 图片 dataUrl 太大，只留元数据。
 */
import fs from 'node:fs'
import path from 'node:path'
import { renderMarkdown } from './markdown.js'
import { DEFAULT_SESSION_TITLE } from './session-title.js'

export const MAX_SAVED_CHATS = 40
export const MAX_SAVED_MESSAGES = 200
export const MAX_SAVED_CONTENT = 100_000

function atomicWrite(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2))
  try {
    fs.renameSync(tmp, file)
  } catch {
    fs.copyFileSync(tmp, file)
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

function capText(value) {
  const s = String(value ?? '')
  if (s.length <= MAX_SAVED_CONTENT) return s
  return `${s.slice(0, MAX_SAVED_CONTENT)}\n…已截断 ${s.length - MAX_SAVED_CONTENT} 字符`
}

export function serializeMessage(m) {
  if (!m || typeof m !== 'object') return null
  const images = Array.isArray(m.images)
    ? m.images.map((img) => ({
        name: img?.name ?? '',
        mime: img?.mime ?? '',
        omitted: true,
      }))
    : undefined
  const out = {
    role: m.role,
    content: capText(m.content ?? m.message ?? ''),
    error: m.error || undefined,
    context: m.context || undefined,
    mentions: Array.isArray(m.mentions) && m.mentions.length ? m.mentions : undefined,
    files: Array.isArray(m.files) && m.files.length ? m.files : undefined,
    applied: Array.isArray(m.applied) && m.applied.length ? m.applied : undefined,
    tools: Array.isArray(m.tools) && m.tools.length ? m.tools : undefined,
    model: m.model || undefined,
    effort: m.effort || undefined,
    stopReason: m.stopReason || undefined,
    reasoning: m.reasoning ? capText(m.reasoning) : undefined,
  }
  if (m.apiContent != null && m.apiContent !== m.content) {
    out.apiContent = typeof m.apiContent === 'string' ? capText(m.apiContent) : m.apiContent
  }
  if (images?.length) out.images = images
  return out
}

export function reviveMessage(m) {
  if (!m || typeof m !== 'object') return null
  const content = String(m.content ?? '')
  return {
    ...m,
    content,
    html: m.html || (content ? renderMarkdown(content) : ''),
  }
}

export function serializeChat(chat) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : []
  const kept = messages.slice(-MAX_SAVED_MESSAGES).map(serializeMessage).filter(Boolean)
  return {
    id: chat.id,
    title: chat.title || DEFAULT_SESSION_TITLE,
    titleLocked: !!chat.titleLocked,
    createdAt: chat.createdAt ?? new Date().toISOString(),
    updatedAt: chat.updatedAt ?? chat.createdAt ?? new Date().toISOString(),
    messages: kept,
  }
}

export function reviveChat(chat) {
  if (!chat?.id) return null
  return {
    id: chat.id,
    title: chat.title || DEFAULT_SESSION_TITLE,
    titleLocked: !!chat.titleLocked,
    createdAt: chat.createdAt ?? new Date().toISOString(),
    updatedAt: chat.updatedAt ?? chat.createdAt ?? new Date().toISOString(),
    messages: (chat.messages ?? []).map(reviveMessage).filter(Boolean),
  }
}

export class ChatStore {
  constructor(stateDir) {
    this.dir = stateDir
    this.file = path.join(stateDir, 'chats.json')
  }

  #readAll() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return { byUser: {} }
    }
  }

  load(username) {
    const key = String(username ?? '').trim()
    if (!key) return { currentId: null, chats: [] }
    const raw = this.#readAll()
    const bucket = raw.byUser?.[key] ?? raw
    const chats = (bucket.chats ?? []).map(reviveChat).filter(Boolean).slice(-MAX_SAVED_CHATS)
    return {
      currentId: bucket.currentId ?? chats[0]?.id ?? null,
      chats,
    }
  }

  save(username, { currentId, chats } = {}) {
    const key = String(username ?? '').trim()
    if (!key) return
    const all = this.#readAll()
    all.byUser = all.byUser ?? {}
    const list = (chats ?? []).map(serializeChat).filter((c) => c?.id).slice(-MAX_SAVED_CHATS)
    all.byUser[key] = {
      currentId: currentId ?? list[0]?.id ?? null,
      chats: list,
      savedAt: new Date().toISOString(),
    }
    delete all.chats
    delete all.currentId
    atomicWrite(this.file, all)
  }
}
