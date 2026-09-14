/**
 * Mixed 终态横幅「关闭」：按会话记住 runId，换会话再点回来（或刷新）不再弹出同一条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  DISMISS_KEY,
  dismissRunId,
  isRunDismissed,
  loadDismissedRuns,
  writeDismissedRuns,
} from '../../plugins/desk-ui/src/client/mixed-dismiss.js'

function memoryStorage(initial = {}) {
  const data = { ...initial }
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v)
    },
    dump: () => ({ ...data }),
  }
}

test('关闭某条 run 后，同一会话同一 run 视为已关闭；新 run 仍显示', () => {
  let map = {}
  assert.equal(isRunDismissed(map, 'sess-1', 'run-old'), false)
  map = dismissRunId(map, 'sess-1', 'run-old')
  assert.equal(isRunDismissed(map, 'sess-1', 'run-old'), true)
  assert.equal(isRunDismissed(map, 'sess-1', 'run-new'), false)
  assert.equal(isRunDismissed(map, 'sess-2', 'run-old'), false)
})

test('运行面板关闭走持久化，不再用组件内 useState', () => {
  const src = fs.readFileSync(new URL('../../plugins/desk-ui/src/client/mixed-run-panel.jsx', import.meta.url), 'utf8')
  assert.match(src, /dismissMixedRun\(sessionId, b\.runId\)/)
  assert.match(src, /isRunDismissed\(dismissedRuns/)
  assert.equal(src.includes('setDismissed'), false)
})

test('落盘后再读：换会话回来仍记住关闭；坏 JSON 当空', () => {
  const storage = memoryStorage()
  writeDismissedRuns({ 'sess-1': 'run-ok' }, storage)
  assert.equal(storage.dump()[DISMISS_KEY].includes('run-ok'), true)
  const loaded = loadDismissedRuns(storage)
  assert.deepEqual(loaded, { 'sess-1': 'run-ok' })
  assert.equal(isRunDismissed(loaded, 'sess-1', 'run-ok'), true)

  storage.setItem(DISMISS_KEY, '{not json')
  assert.deepEqual(loadDismissedRuns(storage), {})
})
