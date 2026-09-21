/**
 * Small markdown → HTML renderer for the chat transcript.
 * Escapes HTML first; supports headings, lists, tables, fenced code, emphasis, links, images,
 * and clickable workspace file paths (`src/foo.js` or `src/foo.js:12`).
 */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

const FILE_REF = /(?:^|[^A-Za-z0-9_./-])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][\w.-]*)(?::(\d+))?/g

function fileRefHtml(relPath, line) {
  const safe = escapeHtml(relPath)
  const lineAttr = line ? ` data-line="${escapeHtml(line)}"` : ''
  const label = line ? `${safe}:${escapeHtml(line)}` : safe
  return `<button type="button" class="file-ref" data-path="${safe}"${lineAttr} title="打开工作区文件">${label}</button>`
}

function linkifyFiles(html) {
  return html.replace(FILE_REF, (full, p, line) => {
    const prefix = full.slice(0, full.length - p.length - (line ? line.length + 1 : 0))
    return `${prefix}${fileRefHtml(p, line)}`
  })
}

function inline(s) {
  let t = escapeHtml(s)
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) => `<img alt="${alt}" src="${url}">`)
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, label, url) => `<a href="${url}" rel="noreferrer">${label}</a>`)
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
  t = linkifyFiles(t)
  return t
}

function isTableSep(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function splitRow(line) {
  const t = String(line ?? '').trim()
  const inner = t.replace(/^\|/, '').replace(/\|$/, '')
  return inner.split('|').map((c) => c.trim())
}

function renderTable(headerLine, rows) {
  const heads = splitRow(headerLine)
  const thead = `<thead><tr>${heads.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead>`
  const tbody = `<tbody>${rows
    .map((row) => {
      const cells = splitRow(row)
      while (cells.length < heads.length) cells.push('')
      return `<tr>${cells.slice(0, heads.length).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`
    })
    .join('')}</tbody>`
  return `<div class="md-table"><table>${thead}${tbody}</table></div>`
}

export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0
  let inFence = false
  let fenceLang = ''
  let fence = []
  let list = null
  let ordered = null

  const flushList = () => {
    if (list) {
      out.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`)
      list = null
    }
    if (ordered) {
      out.push(`<ol>${ordered.map((item) => `<li>${inline(item)}</li>`).join('')}</ol>`)
      ordered = null
    }
  }

  while (i < lines.length) {
    const line = lines[i]
    const fenceMark = /^```([\w-]*)\s*$/.exec(line)
    if (fenceMark) {
      if (inFence) {
        const code = escapeHtml(fence.join('\n'))
        const lang = fenceLang ? ` class="language-${escapeHtml(fenceLang)}"` : ''
        out.push(
          `<div class="code-block"><button type="button" class="copy-code" title="复制代码">复制</button><pre><code${lang}>${code}</code></pre></div>`,
        )
        inFence = false
        fence = []
        fenceLang = ''
      } else {
        flushList()
        inFence = true
        fenceLang = fenceMark[1]
      }
      i += 1
      continue
    }
    if (inFence) {
      fence.push(line)
      i += 1
      continue
    }
    if (i + 1 < lines.length && /\|/.test(line) && isTableSep(lines[i + 1])) {
      flushList()
      const header = line
      i += 2
      const rows = []
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== '') {
        rows.push(lines[i])
        i += 1
      }
      out.push(renderTable(header, rows))
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      flushList()
      const n = heading[1].length
      out.push(`<h${n}>${inline(heading[2])}</h${n}>`)
      i += 1
      continue
    }
    const ol = /^\d+\.\s+(.+)$/.exec(line)
    if (ol) {
      if (list) flushList()
      ordered = ordered ?? []
      ordered.push(ol[1])
      i += 1
      continue
    }
    const li = /^[-*]\s+(.+)$/.exec(line)
    if (li) {
      if (ordered) flushList()
      list = list ?? []
      list.push(li[1])
      i += 1
      continue
    }
    if (line.trim() === '') {
      flushList()
      i += 1
      continue
    }
    flushList()
    out.push(`<p>${inline(line)}</p>`)
    i += 1
  }
  flushList()
  if (inFence) {
    out.push(`<div class="code-block"><button type="button" class="copy-code" title="复制代码">复制</button><pre><code>${escapeHtml(fence.join('\n'))}</code></pre></div>`)
  }
  return out.join('\n')
}
