/**
 * Mixed 面板纯状态：选哪条 run 操作、恢复 busy key、重跑幂等键、轮询档。
 * 与 React/fetch 解耦，便于单测覆盖「点了没反应」类逻辑洞。
 */
export const MIXED_ACTIVE = new Set(['queued', 'planning', 'executing', 'waiting_input', 'reviewing', 'repairing', 'finalizing', 'cancelling'])
export const MIXED_TERMINAL = new Set(['succeeded', 'cancelled'])
export const MIXED_RECOVERABLE = new Set(['blocked', 'interrupted'])

/**
 * 终态/可恢复横幅要操作的那条 run：当前可恢复详情优先于过期 last，避免点继续打到 null 或旧 run。
 * @param {{ last?: object|null, terminalRun?: object|null, liveRun?: object|null }} p
 */
export function pickActionRun({ last = null, terminalRun = null, liveRun = null } = {}) {
  if (liveRun) return { kind: 'live', run: liveRun }
  if (terminalRun && MIXED_RECOVERABLE.has(terminalRun.status)) return { kind: 'recoverable', run: terminalRun }
  if (last && MIXED_RECOVERABLE.has(last.status) && (!terminalRun || last.runId === terminalRun.runId)) {
    return { kind: 'recoverable', run: last }
  }
  const banner = terminalRun ?? last
  return banner ? { kind: 'terminal', run: banner } : { kind: 'none', run: null }
}

export function resumeBusyKey(choice) {
  if (choice === 'retry') return 'resume-retry'
  if (choice === 'continue') return 'resume-continue'
  if (choice === 'answer') return 'resume-answer'
  return 'resume'
}

/** 面板「继续/重试」请求体：必须打展示中的 run，缺 runId 直接失败（不能静默空点）。 */
export function buildResumeRequest(choice, target) {
  if (!target?.runId) throw new Error('没有可恢复的运行')
  const body = { choice }
  if (target.revision != null) body.expectedRevision = target.revision
  return { runId: target.runId, body }
}

export function newRerunRequestId(now = Date.now(), random = Math.random) {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (typeof uuid === 'string' && uuid) return uuid
  return `rr-${now}-${random().toString(36).slice(2, 10)}`
}

export function shouldPollFast(activeRun, runDetail) {
  if (activeRun && MIXED_ACTIVE.has(activeRun.status)) return true
  if (runDetail?.pendingResume) return true
  return false
}

export function shouldRefreshLastRun(activeRun) {
  return !activeRun || !MIXED_ACTIVE.has(activeRun.status)
}

/**
 * 终态横幅用的最后一轮审核结论：列表摘要带 lastReview，详情带 reviewRounds。
 */
export function lastReviewOf(run) {
  if (!run) return null
  const direct = run.lastReview
  if (direct && (direct.verdict || direct.summary || (direct.findings ?? []).length || (direct.criteria ?? []).length)) {
    return direct
  }
  const rounds = run.reviewRounds ?? []
  const last = [...rounds].reverse().find((r) => r?.result)
  if (!last?.result) return null
  return {
    verdict: last.result.verdict,
    summary: last.result.summary,
    round: rounds.length,
    criteria: last.result.criteria ?? [],
    findings: last.result.findings ?? [],
  }
}
