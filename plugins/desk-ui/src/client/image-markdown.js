import { fromMarkdown } from 'mdast-util-from-markdown'

const escapeAlt = (text) => String(text).replace(/[\\[\]!*<>`]/g, '\\$&').replace(/[\r\n]/g, ' ')

export function sessionImageUrl(source, sessionId, origin) {
  if (/^https?:\/\//i.test(source)) return source
  // Windows drive letters are paths; other non-file protocols remain unsupported.
  if (/^[a-z][a-z\d+.-]*:/i.test(source) && !/^(?:file:|[a-z]:[\\/])/i.test(source)) return null
  if (!sessionId || !source || source.startsWith('//')) return null
  const url = new URL(`/desk/api/sessions/${encodeURIComponent(sessionId)}/image`, origin)
  url.searchParams.set('path', source)
  return url.href
}

const imageFile = /\.(?:png|jpe?g|gif|webp|bmp|avif|svg)(?:[?#].*)?$/i
const imageKey = (source) => {
  try { source = decodeURIComponent(source) } catch {}
  return source.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Embed local images and preview image file references in prose, never fenced code. */
export function imageMarkdownParts(text, { sessionId, origin, failed = new Set(), revision = 0 }) {
  const tree = fromMarkdown(text)
  const definitions = new Map()
  const edits = []
  const embedded = new Set()
  const references = new Map()
  function reference(source) {
    if (source && imageFile.test(source) && !/[\r\n<>`]/.test(source) && sessionImageUrl(source, sessionId, origin)) {
      references.set(imageKey(source), source)
    }
  }
  function renderImage(source, description, inLink = false) {
    let url = sessionImageUrl(source, sessionId, origin)
    if (!url) return null
    if (revision && !/^https?:\/\//i.test(source)) url += `&retry=${revision}`
    const alt = escapeAlt(description || '图片')
    const safeUrl = url.replace(/[<>\s]/g, (c) => encodeURIComponent(c))
    const image = `![${alt}](<${safeUrl}>)`
    return failed.has(url) ? `**图片加载失败：${alt}**` : inLink ? image : `[${image}](<${safeUrl}>)`
  }
  function definitionsIn(node) {
    if (node.type === 'definition' && !definitions.has(node.identifier.toUpperCase())) definitions.set(node.identifier.toUpperCase(), node.url)
    for (const child of node.children ?? []) definitionsIn(child)
  }
  definitionsIn(tree)
  function visit(node, inLink = false) {
    if (node.type === 'image' || node.type === 'imageReference') {
      const source = node.type === 'image' ? node.url : definitions.get(node.identifier.toUpperCase())
      if (source === undefined) return
      const value = renderImage(source, node.alt, inLink)
      if (!value) return
      embedded.add(imageKey(source))
      edits.push({ start: node.position.start.offset, end: node.position.end.offset,
        value })
    } else if (node.type === 'link' || node.type === 'linkReference') {
      reference(node.type === 'link' ? node.url : definitions.get(node.identifier.toUpperCase()))
    } else if (node.type === 'inlineCode' && !inLink) {
      // Exact file/path references only, not inline Markdown examples or shell commands.
      if (!/[!\[\]=;|]/.test(node.value)) reference(node.value)
    } else if (node.type === 'text' && !inLink) {
      // Unformatted filenames need an explicit delivery label to avoid matching examples in prose.
      for (const match of node.value.matchAll(/(?:图片文件|图片路径|生成图片|图片|文件路径)\s*[:：]\s*([^\r\n]+?\.(?:png|jpe?g|gif|webp|bmp|avif|svg))(?=$|\s|[，。；])/gi)) reference(match[1].trim())
    }
    for (const child of node.children ?? []) visit(child, inLink || node.type === 'link' || node.type === 'linkReference')
  }
  visit(tree)
  let result = text
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.value + result.slice(edit.end)
  const previews = []
  for (const [key, source] of references) {
    if (!embedded.has(key)) previews.push(renderImage(source, source.split(/[\\/]/).pop()))
  }
  return { text: result, previews: previews.join('\n\n') }
}

export function imageMarkdown(text, options) {
  const parts = imageMarkdownParts(text, options)
  return parts.text + (parts.previews ? `\n\n${parts.previews}` : '')
}
