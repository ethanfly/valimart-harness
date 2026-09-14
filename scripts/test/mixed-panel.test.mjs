/**
 * Mixed 面板状态：错误后点继续/重试必须打到展示中的 run，busy key 对齐，重跑带幂等键。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  MIXED_RECOVERABLE,
  pickActionRun,
  resumeBusyKey,
  newRerunRequestId,
  buildResumeRequest,
  shouldPollFast,
  shouldRefreshLastRun,
  lastReviewOf,
} from '../../plugins/desk-ui/src/client/mixed-panel-state.js'

test('pickActionRun：当前 blocked 详情优先于过期 last，避免继续打到 null/旧 run', () => {
  const last = { runId: 'run-old', status: 'succeeded', revision: 3 }
  const terminalRun = { runId: 'run-fail', status: 'blocked', revision: 8, error: { detail: 'planning max_tokens' } }
  const picked = pickActionRun({ last, terminalRun, liveRun: null })
  assert.equal(picked.kind, 'recoverable')
  assert.equal(picked.run.runId, 'run-fail')
})

test('pickActionRun：只有 last 是 blocked（详情还没拉到）时，继续必须打 last，不能打 null', () => {
  const last = { runId: 'run-fail', status: 'blocked', revision: 2 }
  const picked = pickActionRun({ last, terminalRun: null, liveRun: null })
  assert.equal(picked.run.runId, 'run-fail')
  assert.ok(MIXED_RECOVERABLE.has(picked.run.status))
})

test('resume busy key 与按钮 disabled 对齐；重跑幂等键非空', () => {
  assert.equal(resumeBusyKey('continue'), 'resume-continue')
  assert.equal(resumeBusyKey('retry'), 'resume-retry')
  assert.equal(resumeBusyKey('answer'), 'resume-answer')
  const id = newRerunRequestId(1, () => 0.5)
  assert.ok(typeof id === 'string' && id.length > 4)
  const req = buildResumeRequest('retry', { runId: 'run-fail', revision: 8 })
  assert.deepEqual(req, { runId: 'run-fail', body: { choice: 'retry', expectedRevision: 8 } })
  assert.throws(() => buildResumeRequest('continue', null), /没有可恢复的运行/)
})

test('pendingResume 或活动阶段走快轮询；无活动时刷新 last，避免横幅停在旧成功', () => {
  assert.equal(shouldPollFast({ status: 'blocked' }, { pendingResume: { kind: 'retry' } }), true)
  assert.equal(shouldPollFast({ status: 'blocked' }, {}), false)
  assert.equal(shouldPollFast({ status: 'planning' }, {}), true)
  assert.equal(shouldRefreshLastRun({ status: 'blocked' }), true)
  assert.equal(shouldRefreshLastRun({ status: 'planning' }), false)
})

test('lastReviewOf：终态横幅优先用 lastReview，否则回退 reviewRounds 最后一轮有结论的 result', () => {
  const findings = [{ findingId: 'f1', severity: 'blocking', expected: '绿', actual: '红', repairInstruction: '改测试' }]
  assert.equal(lastReviewOf(null), null)
  assert.equal(lastReviewOf({}), null)
  assert.deepEqual(
    lastReviewOf({ lastReview: { verdict: 'changes_requested', summary: '未过', round: 3, criteria: [], findings } }),
    { verdict: 'changes_requested', summary: '未过', round: 3, criteria: [], findings },
  )
  const fromRounds = lastReviewOf({
    reviewRounds: [
      { result: null },
      { result: { verdict: 'changes_requested', summary: '第二轮', criteria: [{ acceptanceId: 'a1', status: 'fail', explanation: '仍失败' }], findings } },
    ],
  })
  assert.equal(fromRounds.verdict, 'changes_requested')
  assert.equal(fromRounds.summary, '第二轮')
  assert.equal(fromRounds.round, 2)
  assert.equal(fromRounds.findings[0].repairInstruction, '改测试')
})

test('运行面板：终态横幅必须画出审核未通过的详细原因（摘要/验收/findings）', () => {
  const src = fs.readFileSync(new URL('../../plugins/desk-ui/src/client/mixed-run-panel.jsx', import.meta.url), 'utf8')
  assert.match(src, /lastReviewOf/)
  assert.match(src, /ReviewReasons/)
  assert.match(src, /repairInstruction/)
  assert.match(src, /bannerRun/)
})

test('运行面板：恢复打展示 run、busy key 对齐、重跑带 rerunRequestId、pendingResume 可见', () => {
  const src = fs.readFileSync(new URL('../../plugins/desk-ui/src/client/mixed-run-panel.jsx', import.meta.url), 'utf8')
  assert.match(src, /pickActionRun/)
  assert.match(src, /resumeBusyKey/)
  assert.match(src, /newRerunRequestId/)
  assert.match(src, /buildResumeRequest/)
  assert.match(src, /pendingResume/)
  assert.match(src, /refreshMixedSessions/)
  assert.doesNotMatch(src, /terminalRun\.runId/)
  assert.doesNotMatch(src, /act\('resume'/)
  assert.doesNotMatch(src, /api\.mixed\.rerun\(runId\)/)
})
