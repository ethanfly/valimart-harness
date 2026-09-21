/**
 * Build /v1/chat/completions bodies: multimodal user content + 思考强度.
 */
import { buildChatMessages } from './editor-context.js'

export function buildUserContent({ text, images = [] } = {}) {
  const t = String(text ?? '')
  const imgs = Array.isArray(images) ? images.filter((x) => x && (x.dataUrl || x.url)) : []
  if (!imgs.length) return t
  return [
    { type: 'text', text: t },
    ...imgs.map((img) => ({
      type: 'image_url',
      image_url: { url: img.dataUrl || img.url },
    })),
  ]
}

export function applyChatOptions(body, { model, effort } = {}) {
  const out = { ...body }
  if (model) out.model = model
  if (effort != null && String(effort).length > 0) {
    out.reasoning_effort = effort
    out.effort = effort
    out.thinking = effort === 'off' || effort === 'none' ? { type: 'disabled' } : { type: 'enabled' }
  }
  return out
}

export function buildTurnPayload({ userPrompt, editorContext, images = [], history = [] } = {}) {
  const textOnly = buildChatMessages({ userPrompt, editorContext, history: [] })
  const text = textOnly[textOnly.length - 1]?.content ?? String(userPrompt ?? '')
  const content = buildUserContent({ text, images })
  return {
    text,
    content,
    messages: [...history, { role: 'user', content }],
  }
}

/**
 * 往 user content（string 或多模态数组）里追加一段本轮专用上下文。
 * 只用于「这一轮」—— transcript 仍保存不带附加段的 apiContent，
 * 否则 @ 内联的文件内容会在后续每一轮被反复重放。
 */
export function appendContextToContent(content, extra) {
  const text = String(extra ?? '')
  if (!text.trim()) return content
  if (typeof content === 'string') return `${content}\n\n${text}`
  if (!Array.isArray(content)) return text
  const idx = content.findIndex((p) => typeof p === 'object' && p?.type === 'text')
  if (idx < 0) return [{ type: 'text', text }, ...content]
  return content.map((p, i) => (i === idx ? { ...p, text: `${p.text ?? ''}\n\n${text}` } : p))
}

export function extractMessageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((p) => (typeof p === 'string' ? p : p?.text ?? p?.image_url?.url ?? ''))
    .join('\n')
}
