import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from '../src/lib/markdown.js'

test('markdown renderer emits structure not the raw source', () => {
  const src = `# heading

- item one

\`\`\`js
const x = 1
\`\`\`

See **bold** and [link](https://example.com/path)`
  const html = renderMarkdown(src)
  assert.notEqual(html, src)
  assert.match(html, /<h1>/)
  assert.match(html, /<ul>/)
  assert.match(html, /<pre>/)
  assert.match(html, /<strong>/)
  assert.match(html, /<a href="https:\/\/example.com\/path"/)
  assert.ok(!html.includes('# heading\n'))
})

test('markdown 渲染表格、有序列表、代码复制按钮和工作区文件引用', () => {
  const html = renderMarkdown(`| a | b |
| --- | --- |
| 1 | 2 |

1. first

See src/lib/session.js:12 and keep going.

\`\`\`js
const x = 1
\`\`\`
`)
  assert.match(html, /<table>/)
  assert.match(html, /<th>/)
  assert.match(html, /<ol>/)
  assert.match(html, /class="copy-code"/)
  assert.match(html, /class="file-ref"/)
  assert.match(html, /data-path="src\/lib\/session.js"/)
  assert.match(html, /data-line="12"/)
})
