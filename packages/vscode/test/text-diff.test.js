import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { diffStat, summarizeChange, splitLines, FileChangeLog, MAX_DIFF_CHARS } from '../src/lib/text-diff.js'
import { createWorkspaceTools, applyWrite, applyPatch } from '../src/lib/workspace-fs.js'

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vh-diff-'))
}

test('diffStat：单处编辑精确，纯新增/纯删除也对', () => {
  assert.deepEqual(diffStat('a\nb\nc\n', 'a\nB\nc\n'), { added: 1, removed: 1, unchanged: 2 })
  assert.deepEqual(diffStat('', 'x\ny\n'), { added: 2, removed: 0, unchanged: 0 })
  assert.deepEqual(diffStat('x\ny\n', ''), { added: 0, removed: 2, unchanged: 0 })
  assert.deepEqual(diffStat('same\n', 'same\n'), { added: 0, removed: 0, unchanged: 1 })
  assert.deepEqual(diffStat('a\nb\nc\n', 'a\nb\nc\nd\n'), { added: 1, removed: 0, unchanged: 3 })
  assert.deepEqual(splitLines('a\nb'), ['a', 'b'])
  assert.deepEqual(splitLines(''), [])
  assert.deepEqual(splitLines('a\n'), ['a'])
})

test('summarizeChange：新建/过大/无改动分别标出来', () => {
  const created = summarizeChange({ path: 'new.js', before: '', after: 'l1\nl2\n', created: true })
  assert.deepEqual(created, { path: 'new.js', created: true, added: 2, removed: 0, tooLarge: false, hasDiff: true })

  const same = summarizeChange({ path: 'same.js', before: 'x\n', after: 'x\n' })
  assert.equal(same.hasDiff, false)
  assert.equal(same.added, 0)

  const big = summarizeChange({ path: 'big.js', before: 'x'.repeat(MAX_DIFF_CHARS + 1), after: 'y' })
  assert.equal(big.tooLarge, true)
  assert.equal(big.hasDiff, false, '过大就不给 diff，只让打开文件')
})

test('FileChangeLog：同文件多次写入保留最早 before + 最新 after，按会话隔离', () => {
  const log = new FileChangeLog()
  log.record('chat-1', { path: 'a.js', abs: 'X:/a.js', before: 'v0\n', after: 'v1\n', created: false })
  log.record('chat-1', { path: 'a.js', abs: 'X:/a.js', before: 'v1\n', after: 'v2\n', created: false })
  log.record('chat-1', { path: 'b.js', abs: 'X:/b.js', before: '', after: 'new\n', created: true })
  log.record('chat-2', { path: 'a.js', abs: 'X:/a.js', before: 'other\n', after: 'other2\n', created: false })

  const a = log.get('chat-1', 'a.js')
  assert.equal(a.before, 'v0\n', '最早的内容')
  assert.equal(a.after, 'v2\n', '最新的内容')
  assert.equal(a.created, false)

  assert.deepEqual(log.list('chat-1').map((e) => e.path).sort(), ['a.js', 'b.js'])
  const summaries = log.summaries('chat-1')
  assert.deepEqual(
    { added: summaries.find((s) => s.path === 'a.js').added, removed: summaries.find((s) => s.path === 'a.js').removed },
    { added: 1, removed: 1 },
    'v0 → v2 是改了一行',
  )
  assert.equal(summaries.find((s) => s.path === 'b.js').created, true)
  assert.deepEqual(log.summaries('chat-1', ['b.js']).map((s) => s.path), ['b.js'])
  assert.equal(log.get('chat-2', 'a.js').before, 'other\n', '不同会话互不干扰')
  assert.equal(log.get('chat-1', 'missing.js'), null)

  log.clear('chat-1')
  assert.equal(log.list('chat-1').length, 0)
  assert.equal(log.list('chat-2').length, 1)
})

test('工具写入时回调 before/after，但结果里不带正文（不进模型上下文）', () => {
  const root = tempRoot()
  const seen = []
  const tools = createWorkspaceTools({ workspaceRoot: root, onFileChange: (c) => seen.push(c) })
  try {
    const created = tools.execute('write_file', { path: 'src/new.js', contents: 'one\ntwo\n' })
    assert.equal(created.path, 'src/new.js')
    assert.deepEqual(Object.keys(created).sort(), ['abs', 'bytes', 'path'], '工具结果不含正文')
    assert.equal(seen[0].created, true)
    assert.equal(seen[0].before, '')
    assert.equal(seen[0].after, 'one\ntwo\n')

    tools.execute('apply_patch', { path: 'src/new.js', oldText: 'two', newText: 'TWO\nthree' })
    assert.equal(seen[1].before, 'one\ntwo\n')
    assert.equal(seen[1].after, 'one\nTWO\nthree\n')
    assert.equal(seen[1].created, false)
    assert.equal(fs.readFileSync(path.join(root, 'src/new.js'), 'utf8'), 'one\nTWO\nthree\n')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('直接调用 applyWrite/applyPatch 也回调；补丁不匹配时不回调', () => {
  const root = tempRoot()
  const seen = []
  const onChange = (c) => seen.push(c)
  try {
    applyWrite(root, 'a.txt', 'hello\n', onChange)
    assert.equal(seen.length, 1)
    assert.throws(() => applyPatch(root, 'a.txt', 'not-there', 'x', onChange), /未匹配/)
    assert.equal(seen.length, 1, '失败不改文件也不记录改动')
    applyPatch(root, 'a.txt', 'hello', 'bye', onChange)
    assert.equal(seen[1].after, 'bye\n')
    // 不传回调也不该报错（老调用方式保持可用）
    assert.equal(applyWrite(root, 'b.txt', 'x').path, 'b.txt')
    assert.equal(applyPatch(root, 'b.txt', 'x', 'y').replaced, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
