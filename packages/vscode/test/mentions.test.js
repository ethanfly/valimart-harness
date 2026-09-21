import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  extractMentions,
  mentionPaths,
  resolveMentions,
  formatMentionBlock,
  MAX_MENTIONS,
  MENTION_FILE_CHARS,
} from '../src/lib/mentions.js'
import { searchWorkspacePaths, scorePath, scanWorkspace, WorkspaceIndex } from '../src/lib/workspace-index.js'

function tempWorkspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-mention-'))
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, contents, 'utf8')
  }
  return root
}

test('@ 提及：只认独立 @路径，不碰邮箱和裸 @', () => {
  assert.deepEqual(mentionPaths('@src/lib/slash.js 讲一下这个文件'), ['src/lib/slash.js'])
  assert.deepEqual(mentionPaths('看下 @media/chat.css 和 @package.json 的关系'), ['media/chat.css', 'package.json'])
  assert.deepEqual(mentionPaths('联系 ethan@example.com 谢谢'), [], '邮箱不是提及')
  assert.deepEqual(mentionPaths('user@host.com 和 a@b.c'), [])
  assert.deepEqual(mentionPaths('@'), [], '光一个 @ 不算')
  assert.deepEqual(mentionPaths('把 @a.md. 改一下'), ['a.md'], '结尾句号要剥掉')
  assert.deepEqual(mentionPaths('（@a.md）'), ['a.md'], '中文括号不算路径的一部分')
  assert.deepEqual(mentionPaths('@a.js @a.js @a.js'), ['a.js'], '去重')
  assert.deepEqual(mentionPaths('@a\\b.js'), ['a/b.js'], '反斜杠归一化')
  assert.equal(extractMentions(Array.from({ length: 12 }, (_, i) => `@f${i}.js`).join(' ')).length, MAX_MENTIONS)
})

test('@ 提及：读取工作区文件，读不到只记原因，不抛错', () => {
  const root = tempWorkspace({
    'src/a.js': 'const a = 1\n'.repeat(5),
    'big.js': 'x'.repeat(MENTION_FILE_CHARS + 500),
    'bin.dat': 'ok\u0000binary',
  })
  try {
    const ok = resolveMentions({ workspaceRoot: root, text: '@src/a.js 讲讲' })
    assert.equal(ok.attachments.length, 1)
    assert.equal(ok.attachments[0].path, 'src/a.js')
    assert.equal(ok.attachments[0].truncated, false)
    assert.match(ok.attachments[0].contents, /const a = 1/)

    const big = resolveMentions({ workspaceRoot: root, text: '@big.js' })
    assert.equal(big.attachments[0].contents.length, MENTION_FILE_CHARS, '超长文件按上限截断')
    assert.equal(big.attachments[0].truncated, true)
    assert.ok(big.attachments[0].totalChars > MENTION_FILE_CHARS)

    const bad = resolveMentions({ workspaceRoot: root, text: '@nope/missing.js @src 和 @bin.dat' })
    assert.equal(bad.attachments.length, 0)
    assert.equal(bad.missing.length, 3)
    assert.match(bad.missing[0].reason, /工作区里没有/)
    assert.match(bad.missing[1].reason, /目录/)
    assert.match(bad.missing[2].reason, /二进制/)

    const escaped = resolveMentions({ workspaceRoot: root, text: '@../outside.js' })
    assert.equal(escaped.attachments.length, 0, '越出工作区的路径绝不读取')
    assert.equal(escaped.missing.length, 1)

    const noRoot = resolveMentions({ workspaceRoot: null, text: '@a.js' })
    assert.match(noRoot.missing[0].reason, /工作区/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('@ 提及：内联块写清「已提供、别重复读、哪里被截断」', () => {
  const block = formatMentionBlock({
    attachments: [
      { path: 'src/a.js', contents: 'const a = 1', truncated: false, totalChars: 13 },
      { path: 'src/b.js', contents: '```js\ncode\n```', truncated: true, totalChars: 99_000 },
    ],
    missing: [{ path: 'src/gone.js', reason: '文件不存在' }],
  })
  assert.match(block, /用户在本条消息里用 @ 引用了 2 个工作区文件/)
  assert.match(block, /不要再对这些路径调用 read_file/)
  assert.match(block, /@src\/a\.js/)
  assert.match(block, /已截断，仅内联前/)
  assert.match(block, /^````file$/m, '文件自带 ``` 时围栏要加长')
  assert.match(block, /未能内联.*@src\/gone\.js（文件不存在）/)
  assert.equal(formatMentionBlock({}), '')
})

test('@ 面板排序：文件名前缀优先、浅层优先、空查询给最近改动', () => {
  const entries = [
    { path: 'src/lib/slash.js', mtimeMs: 1 },
    { path: 'src/lib/slash-command-helper.js', mtimeMs: 2 },
    { path: 'node_modules/deep/slash.js', mtimeMs: 3 },
    { path: 'test/slash.test.js', mtimeMs: 4 },
    { path: 'README.md', mtimeMs: 5 },
  ]
  const slashHits = searchWorkspacePaths(entries, 'slash')
  assert.equal(slashHits[0], 'src/lib/slash.js', '去扩展名后完全同名的排最前')
  // 纯函数只负责排序；node_modules 之类在扫描阶段就被剔掉了（见下一个用例）。
  assert.deepEqual(new Set(slashHits), new Set(['src/lib/slash.js', 'test/slash.test.js', 'src/lib/slash-command-helper.js', 'node_modules/deep/slash.js']))
  assert.ok(slashHits.indexOf('src/lib/slash.js') < slashHits.indexOf('node_modules/deep/slash.js'))
  const libHits = searchWorkspacePaths(entries, 'lib/s')
  assert.deepEqual(libHits, ['src/lib/slash.js', 'src/lib/slash-command-helper.js'])
  assert.deepEqual(searchWorkspacePaths(entries, 'readme'), ['README.md'], '大小写无关')
  assert.deepEqual(searchWorkspacePaths(entries, 'zzz-nothing'), [])
  assert.deepEqual(searchWorkspacePaths(entries, '', { limit: 3 }), ['README.md', 'test/slash.test.js', 'node_modules/deep/slash.js'], '空查询按 mtime 倒序')
  assert.equal(searchWorkspacePaths(entries, 'slash', { limit: 1 }).length, 1)
  assert.ok(scorePath({ path: 'src/a.js' }, 'a.js') > scorePath({ path: 'x/y/z/a.js' }, 'a.js'), '浅层加分')
  assert.equal(scorePath({ path: 'src/a.js' }, 'qqq'), 0)
})

test('@ 面板索引：扫描跳过依赖目录，TTL 内复用缓存', () => {
  const root = tempWorkspace({
    'src/app.js': '1',
    'media/chat.css': '2',
    'node_modules/pkg/index.js': '3',
    'out/extension.js': '4',
    '.git/config': '5',
  })
  try {
    const paths = scanWorkspace(root).map((e) => e.path)
    assert.ok(paths.includes('src/app.js'))
    assert.ok(paths.includes('media/chat.css'))
    assert.ok(!paths.some((p) => p.startsWith('node_modules/')), '依赖目录不进面板')
    assert.ok(!paths.some((p) => p.startsWith('out/')))
    assert.ok(!paths.some((p) => p.startsWith('.git/')))

    let scans = 0
    const index = new WorkspaceIndex({
      getWorkspaceRoot: () => root,
      scan: (r) => {
        scans++
        return scanWorkspace(r)
      },
    })
    assert.ok(index.search('chat').paths.length >= 1)
    index.search('app')
    assert.equal(scans, 1, 'TTL 内不重扫')
    index.search('app', { force: true })
    assert.equal(scans, 2)
    assert.deepEqual(index.search('anything').paths, [], '没有工作区时不报错')
    const empty = new WorkspaceIndex({ getWorkspaceRoot: () => null })
    assert.deepEqual(empty.search('x'), { paths: [], root: null })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
