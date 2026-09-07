/**
 * 任务卡上的 sessionId 可能来自别的设备或已经删掉的窗口。
 * 内核 sessions.open() 对未知 id 同步抛错；丢在 React effect 里会把 root 槽打成白屏。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { safeOpenSession, sessionKnown } from '../../plugins/desk-ui/src/client/safe-open-session.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function ctxWith(byId, open = () => {}) {
  return {
    sessions: {
      list: { getSnapshot: () => ({ byId, ids: Object.keys(byId), current: undefined }) },
      open,
    },
  }
}

test('sessionKnown：本机列表里有的才算已知', () => {
  const ctx = ctxWith({ 'session-live': { displayTitle: 'ok' } })
  assert.equal(sessionKnown(ctx, 'session-live'), true)
  assert.equal(sessionKnown(ctx, 'session-gone'), false)
  assert.equal(sessionKnown(ctx, ''), false)
  assert.equal(sessionKnown({}, 'session-live'), false)
})

test('safeOpenSession：未知会话不调用 open，也不抛', () => {
  let called = 0
  const ctx = ctxWith({}, () => {
    called += 1
    throw new Error('sessions.select: unknown session session-gone')
  })
  assert.equal(safeOpenSession(ctx, 'session-gone', { requireKnown: true }), false)
  assert.equal(called, 0)
})

test('safeOpenSession：open 同步抛错时吞掉，返回 false', () => {
  const ctx = ctxWith({ 'session-x': {} }, () => {
    throw new Error('sessions.select: unknown session session-x')
  })
  assert.equal(safeOpenSession(ctx, 'session-x'), false)
})

test('safeOpenSession：已知会话会 open 并返回 true', () => {
  const opened = []
  const ctx = ctxWith({ 'session-live': {} }, (id) => opened.push(id))
  assert.equal(safeOpenSession(ctx, 'session-live'), true)
  assert.deepEqual(opened, ['session-live'])
})

test('TaskChatColumn 自动打开进程走 safeOpenSession，避免 unknown session 白屏', () => {
  const src = fs.readFileSync(path.join(repo, 'plugins/desk-ui/src/client/tasks.jsx'), 'utf8')
  assert.match(src, /import \{[^}]*safeOpenSession[^}]*\} from '\.\/safe-open-session\.js'/)
  assert.match(src, /autoOpened[\s\S]*safeOpenSession\(ctx, last\.sessionId/)
  assert.doesNotMatch(src, /if \(last && last\.sessionId !== current\) ctx\.sessions\.open\(last\.sessionId\)/)
})
