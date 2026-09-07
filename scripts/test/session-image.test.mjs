import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readSessionImage, serveSessionImage } from '../../plugins/desk-host/lib/session-image.js'
import { imageMarkdown, sessionImageUrl } from '../../plugins/desk-ui/src/client/image-markdown.js'

const opts = { sessionId: 'session-1', origin: 'http://127.0.0.1:19800' }

test('本地图片转换保留代码块、普通链接、引用图片、列表和标题', () => {
  const input = '# 图片\n\n- ![结果](<图 表(1).png>)\n\n![引用][shot]\n\n[shot]: ./test.png\n\n`![示例](local.png)`\n\n```md\n![示例](local.png)\n```\n\n[文件](local.png)'
  const out = imageMarkdown(input, opts)
  assert.match(out, /^# 图片\n\n- \[!\[结果\]/)
  assert.match(out, /sessions\/session-1\/image\?path=/)
  assert.match(out, /path=.%2Ftest.png/)
  assert.ok(out.includes('`![示例](local.png)`'))
  assert.ok(out.includes('```md\n![示例](local.png)\n```'))
  assert.ok(out.includes('[文件](local.png)'))
  assert.equal(imageMarkdown('![未完成](', opts), '![未完成](')
})

test('不同会话路径独立；Windows、file 地址和公网图片分别处理', () => {
  for (const source of ['E:/work/a.png', 'E:\\work\\a.png', '/work/a.png', './a.png', 'file:///E:/work/a.png']) {
    const url = new URL(sessionImageUrl(source, opts.sessionId, opts.origin))
    assert.equal(url.searchParams.get('path'), source)
    assert.match(url.pathname, /session-1/)
  }
  assert.notEqual(sessionImageUrl('a.png', 'one', opts.origin), sessionImageUrl('a.png', 'two', opts.origin))
  assert.equal(sessionImageUrl('https://example.com/a.png', 'one', opts.origin), 'https://example.com/a.png')
  for (const source of ['javascript:alert(1)', 'data:text/html,foo', '//evil/a.png']) assert.equal(sessionImageUrl(source, 'one', opts.origin), null)
  assert.equal(new URL(sessionImageUrl('\\\\server\\share\\a.png', 'one', opts.origin)).searchParams.get('path'), '\\\\server\\share\\a.png')
  const source = sessionImageUrl('a.png', opts.sessionId, opts.origin)
  assert.match(imageMarkdown('![结果](a.png)', { ...opts, failed: new Set([source]) }), /图片加载失败/)
  assert.match(imageMarkdown('![结果](a.png)', { ...opts, revision: 1 }), /retry=1/)
})

test('生成回复中的文件名、链接和标注路径自动展示，重复引用只展示一次', () => {
  const reply = '已生成，清新写实风：长发白裙、自然微笑、花园暖阳。\n\n图片文件：`beauty-portrait-20260907.png`\n\n想换成古风、御姐风或动漫风，也可以告诉我。'
  const out = imageMarkdown(reply, opts)
  assert.ok(out.startsWith(reply))
  assert.match(out, /\[!\[beauty-portrait-20260907.png\]/)
  assert.match(out, /path=beauty-portrait-20260907.png/)
  for (const input of ['[下载图片](<图 表(1).png>)', '[下载][file]\n\n[file]: image.png', '`C:\\work\\image.png`', '图片文件：beauty-portrait-20260907.png']) {
    assert.match(imageMarkdown(input, opts), /\[!\[/)
  }
  assert.equal((imageMarkdown('`a.png` [文件](./a.png) ![预览](a.png)', opts).match(/!\[/g) ?? []).length, 1)
  assert.equal((imageMarkdown('`a.png` [文件](./a.png)', opts).match(/!\[/g) ?? []).length, 1)
  for (const input of ['```sh\ncat example.png\n```', '`![示例](local.png)`', '支持 png 格式，例如 foo.png', '[网页](https://example.com/page)', '`name = foo.png`']) assert.equal(imageMarkdown(input, opts), input)
  assert.match(imageMarkdown('`a.png`', { ...opts, failed: new Set([sessionImageUrl('a.png', opts.sessionId, opts.origin)]) }), /图片加载失败/)
})

test('会话图片接口读取真实字节，拒绝越界、符号链接、伪图片、超限及未登录请求', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-image-'))
  t.after(async () => { await fs.rm(tmp, { recursive: true, force: true }) })
  const cwd = path.join(tmp, 'workspace')
  await fs.mkdir(cwd)
  const session = { header: { cwd } }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>'
  const file = path.join(cwd, '图 表(1).svg')
  await fs.writeFile(file, svg)
  await fs.writeFile(path.join(tmp, 'outside.svg'), svg)
  for (const source of [file, pathToFileURL(file).href, '图 表(1).svg', encodeURIComponent('图 表(1).svg')]) {
    const result = await readSessionImage(session, source)
    assert.equal(result.contentType, 'image/svg+xml')
    assert.equal(result.bytes.toString(), svg)
  }
  await assert.rejects(readSessionImage(session, '../outside.svg'), { status: 403 })
  await fs.symlink(tmp, path.join(cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(readSessionImage(session, 'link/outside.svg'), { status: 403 })
  await fs.writeFile(path.join(cwd, 'fake.png'), 'private text')
  await assert.rejects(readSessionImage(session, 'fake.png'), { status: 415 })
  await assert.rejects(readSessionImage(session, 'missing.png'), { status: 404 })
  await assert.rejects(readSessionImage(null, file), { status: 404 })
  await assert.rejects(readSessionImage(session, 'https://example.com/a.png'), { status: 400 })
  const large = await fs.open(path.join(cwd, 'large.png'), 'w')
  await large.truncate(32 * 1024 * 1024 + 1)
  await large.close()
  await assert.rejects(readSessionImage(session, 'large.png'), { status: 413 })
  const request = { headers: { 'sec-fetch-site': 'same-origin' } }
  const config = { loggedIn: true, session, source: file }
  await assert.rejects(serveSessionImage(request, {}, { ...config, loggedIn: false }), { status: 401 })
  await assert.rejects(serveSessionImage({ headers: { 'sec-fetch-site': 'cross-site' } }, {}, config), { status: 403 })
  let headers, content
  await serveSessionImage(request, { writeHead: (status, h) => { assert.equal(status, 200); headers = h }, end: (b) => { content = b } }, config)
  assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.equal(headers['cache-control'], 'no-store')
  assert.match(headers['content-security-policy'], /sandbox/)
  assert.equal(content.toString(), svg)
  await serveSessionImage(request, { writeHead: (status, h) => { assert.equal(status, 200); headers = h }, end: (b) => { content = b } }, { ...config, info: true })
  assert.equal(JSON.parse(content).file, await fs.realpath(file))
  assert.match(headers['content-type'], /application\/json/)
  await assert.rejects(serveSessionImage(request, {}, { ...config, info: true, source: '../outside.svg' }), { status: 403 })
  await assert.rejects(serveSessionImage(request, {}, { ...config, info: true, loggedIn: false }), { status: 401 })
})
