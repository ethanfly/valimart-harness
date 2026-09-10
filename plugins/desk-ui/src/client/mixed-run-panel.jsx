/**
 * Mixed 运行面板（conversation.input.dock，order 10，队列上方）：
 * 阶段/任务/实际模型、审核发现、证据、取消与恢复、运行中补充输入排队提示、最近运行结果与重跑。
 *
 * - 活动 run：1s 轮询（mixed-store）；自动展开，静止后收起为横幅；
 * - 刷新页面不取消运行（§5.3）：重新打开会话后由轮询接管同一 run；
 * - 运行中用户新消息 → 宿主排队为下一轮需求（面板显示 queuedInputs 计数）；
 * - 证据查看走 GET /mixed/runs/:id/evidence/:evidenceId（record 内容；非 record → 明确提示）。
 */
import { useEffect, useState } from 'react'
import { api, fmtTime } from './api.js'
import { toast } from './store.js'
import { MIXED_ACTIVE, useMixedState, watchMixedSession } from './mixed-store.js'

export const STATUS_LABEL = {
  queued: '排队中', planning: '规划中', executing: '实施中', waiting_input: '等待补充',
  reviewing: '审核中', repairing: '返修中', finalizing: '收尾中', succeeded: '已交付',
  blocked: '受阻', cancelling: '停止中', cancelled: '已停止', interrupted: '已中断',
}
const TASK_LABEL = {
  pending: '未开始', ready: '就绪', running: '执行中', executed: '已执行', failed: '失败',
  blocked: '受阻', cancelled: '已取消', interrupted: '中断', accepted: '已验收',
  changes_requested: '待返修', stale: '已过期',
}
const STAGE_LABEL = { planning: '规划', execution: '实施', verification: '验证', review: '审核', repair: '返修', summary: '汇总' }
const FLOW = ['planning', 'executing', 'reviewing']

function WaitingAnswers({ run, busy, onSubmit }) {
  const pending = (run.pendingQuestions ?? []).filter((q) => !(typeof q.answer === 'string' && q.answer.trim() !== ''))
  const [draft, setDraft] = useState(() => Object.fromEntries(pending.map((q) => [q.questionId, ''])))
  if (!pending.length) {
    return (
      <div className="dk-mixed-section">
        <div className="k">等待补充输入</div>
        <div className="dk-muted dk-xs">问题已提交，正在重新规划…</div>
      </div>
    )
  }
  const ready = pending.every((q) => (draft[q.questionId] ?? '').trim())
  return (
    <div className="dk-mixed-section">
      <div className="k">等待补充输入</div>
      <div className="dk-muted dk-xs">规划缺关键需求。按问题 id 回答后继续；只由当前账号消费。</div>
      {pending.map((q) => (
        <label key={q.questionId} className="dk-mixed-q">
          <span className="dk-mixed-qid">{q.questionId}</span>
          <span className="dk-mixed-qtext">{q.text}</span>
          <textarea
            rows={2}
            value={draft[q.questionId] ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, [q.questionId]: e.target.value }))}
            placeholder="在此回答"
          />
        </label>
      ))}
      <button
        type="button"
        className="dk-btn sm"
        disabled={!ready || busy === 'resume-answer'}
        onClick={() => onSubmit(pending.map((q) => ({ questionId: q.questionId, answer: (draft[q.questionId] ?? '').trim() })))}
      >
        提交并继续
      </button>
    </div>
  )
}

function fmtTok(n) {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

/**
 * T10 用量块（已知 tokens、覆盖度、价格估值——不承诺固定降本比例）：
 * - usage 为 null/空 → 不显示（归属未启用或网关不可达，绝不显示 ¥0 冒充未知）；
 * - 缺 usage 的请求如实计入 unknownRequests（「未关联/无用量」可见）；
 * - 无价目模型的价格未知（priceUnknownRequests）→ 费用只统计已知价部分并提示。
 */
function UsageBlock({ usage }) {
  if (!usage || !usage.totals || usage.totals.requests === 0) return null
  const t = usage.totals
  const known = usage.totals.requests - (usage.unknownRequests ?? 0)
  const costKnown = usage.priceUnknownRequests === 0
  return (
    <div className="dk-mixed-section dk-mixed-usage">
      <div className="k">
        用量 · 关联 {t.requests} 请求 / {usage.attempts?.length ?? 0} attempts
        {usage.unknownRequests > 0 && <span className="dk-mixed-usage-unknown">（{usage.unknownRequests} 条无用量）</span>}
      </div>
      <div className="dk-mixed-usage-row">
        <span className="dk-muted dk-xs">已知 tokens</span>
        <span>输入 {fmtTok(t.promptTokens)} · 输出 {fmtTok(t.completionTokens)}{t.cachedTokens > 0 ? ` · 缓存 ${fmtTok(t.cachedTokens)}` : ''}</span>
      </div>
      <div className="dk-mixed-usage-row">
        <span className="dk-muted dk-xs">费用（本地价目估算）</span>
        <span>
          {t.costCny != null ? `¥${t.costCny}` : '未知'}
          {!costKnown && <span className="dk-muted dk-xs">（{usage.priceUnknownRequests} 条无价目，未计入）</span>}
          {known < t.requests && <span className="dk-muted dk-xs">（仅计 {known} 条已知用量）</span>}
        </span>
      </div>
      {Object.entries(usage.byStage ?? {}).length > 1 && (
        <div className="dk-muted dk-xs">
          {Object.entries(usage.byStage ?? {})
            .map(([s, v]) => `${STAGE_LABEL[s] ?? s} ${v.requests} 请求${v.costCny > 0 ? ` ¥${v.costCny}` : ''}`)
            .join(' · ')}
        </div>
      )}
    </div>
  )
}

/**
 * 存储降级横幅：写链挂起/写失败时 run 的 blocked 收敛无法落盘（真内核 v9/v10/v11 复现），
 * 磁盘状态可能滞后——UI 必须独立于 run 记录显示降级事实（storage 来自宿主直读，不经过写链）。
 */
function StorageBanner({ storage }) {
  if (!storage) return null
  if (storage.healthy && !storage.degradation) return null
  const reason = storage.degradation?.reason ?? storage.writeLocked?.reason ?? 'unknown'
  const when = storage.degradation?.at
  return (
    <div className="dk-mixed-storage-warn" role="alert">
      <span>⚠ 存储写入异常（{reason}）{when ? `· ${fmtTime(when)}` : ''}</span>
      <span className="dk-muted dk-xs">运行状态可能滞后，数据保留；重启宿主后恢复（可继续/重试该运行）</span>
    </div>
  )
}

function stageOf(status) {
  if (status === 'repairing') return 'repairing'
  return FLOW.includes(status) ? status : status
}

function StageBar({ status }) {
  const cur = stageOf(status)
  const order = [...FLOW, 'repairing']
  const idx = order.indexOf(cur)
  if (idx < 0) {
    return (
      <div className="dk-mixed-stages">
        {FLOW.map((s) => (
          <span key={s} className={`dk-mixed-stage${status === 'queued' ? '' : ''}`}>{s === 'planning' ? '规划' : s === 'executing' ? '实施' : '审核'}</span>
        ))}
        <span className="dk-muted dk-xs">{STATUS_LABEL[status] ?? status}</span>
      </div>
    )
  }
  return (
    <div className="dk-mixed-stages">
      {order.map((s, i) => (
        <span key={s} className={`dk-mixed-stage${i < idx ? ' done' : i === idx ? ' now' : ''}`}>
          {s === 'planning' ? '规划' : s === 'executing' ? '实施' : s === 'reviewing' ? '审核' : '返修'}
        </span>
      ))}
      {cur === 'repairing' && <span className="dk-muted dk-xs">（审核发现问题，返修后再审）</span>}
    </div>
  )
}

function ModelTag({ m }) {
  if (!m) return <span className="dk-muted dk-xs">—</span>
  return <span className="dk-mixed-model" title={`${m.catalogProvider}/${m.modelId}`}>{m.catalogProvider}:{m.modelId}</span>
}

function EvidenceList({ run, onShow }) {
  const items = run?.evidence ?? []
  if (!items.length) return <div className="dk-muted dk-xs">暂无证据（实施阶段会落盘产物/验证记录）</div>
  return (
    <div className="dk-mixed-evidence">
      {items.map((e) => (
        <div key={e.evidenceId} className="dk-mixed-evrow">
          <span className={`dk-badge dk-mixed-evtype t-${e.type}`}>{e.type}</span>
          <span className="dk-muted dk-xs">{e.producer}{e.invalidated ? ' · 已作废' : ''}{e.truncated ? ' · 截断' : ''}{e.size != null ? ` · ${e.size}B` : ''}</span>
          <button type="button" className="dk-btn ghost sm" onClick={() => onShow(e)}>查看</button>
        </div>
      ))}
    </div>
  )
}

export function makeMixedRunPanel() {
  return function MixedRunPanel({ sessionId }) {
    const info = useMixedState((s) => (sessionId ? s.sessions[sessionId] : undefined))
    const activeRunId = info?.activeRun?.runId ?? null
    const runDetail = useMixedState((s) => (activeRunId ? s.runs[activeRunId] : undefined))
    const last = useMixedState((s) => (sessionId ? s.lastRuns[sessionId] : undefined))
    const [collapsed, setCollapsed] = useState(false)
    const [busy, setBusy] = useState(null)
    const [evView, setEvView] = useState(null)
    const [dismissed, setDismissed] = useState(null)

    // 有活动 run → 轮询（chip 也在 watch，Set 幂等）
    useEffect(() => {
      if (!sessionId || !activeRunId) return
      return watchMixedSession(sessionId)
    }, [sessionId, activeRunId])

    // 活动 run 自动展开；进入终态收起
    useEffect(() => {
      if (!runDetail) return
      if (MIXED_ACTIVE.has(runDetail.status)) setCollapsed(false)
      else setCollapsed(true)
    }, [runDetail?.status])

    // 新 run 开始 → 重置横幅收起状态
    useEffect(() => {
      if (activeRunId) setDismissed(null)
    }, [activeRunId])

    if (!sessionId || !info) return null
    const liveRun = runDetail && MIXED_ACTIVE.has(runDetail.status) ? runDetail : null
    // 终态横幅数据：优先最近一条列表摘要（有重跑入口），回退到已缓存的终态详情
    const terminalRun = runDetail && !MIXED_ACTIVE.has(runDetail.status) ? runDetail : null
    const bannerRun = last ?? terminalRun
    if (!liveRun && !bannerRun) return null

    const act = async (kind, fn) => {
      setBusy(kind)
      try {
        await fn()
      } catch (err) {
        toast(err.message, 'error')
      } finally {
        setBusy(null)
      }
    }
    const cancel = () => act('cancel', async () => {
      await api.mixed.cancel(liveRun.runId)
      toast('已受理停止：意图已落盘，正在收敛（受理≠停止）', 'info')
    })
    const resume = (choice) => act('resume', async () => {
      const body = { choice }
      if (terminalRun?.revision != null) body.expectedRevision = terminalRun.revision
      const r = await api.mixed.resume(terminalRun.runId, body)
      toast(
        r?.resume?.started
          ? `恢复已开始（${choice === 'retry' ? '重试该阶段' : '继续运行'}）：在会话内执行`
          : `恢复请求已受理（${choice === 'retry' ? '重试该阶段' : '继续运行'}）：${r?.resume?.reason ?? '会话打开后自动继续'}`,
        'info',
      )
    })
    const rerun = (runId) => act('rerun', async () => {
      await api.mixed.rerun(runId)
      toast('重跑已排队：沿用原目标与验收快照（工作区已有产物视为输入）', 'info')
    })
    const showEvidence = async (e) => {
      try {
        const r = await api.mixed.evidence(liveRun.runId, e.evidenceId)
        setEvView({ title: `${e.type} · ${e.producer}`, content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content, null, 2) })
      } catch (err) {
        setEvView({ title: `${e.type} · ${e.producer}`, error: err.message, content: null })
      }
    }

    // ---------- 终态横幅（无活动 run：最近一条或刚结束的详情） ----------
    if (!liveRun) {
      const b = bannerRun
      if (dismissed === b.runId) return null
      const ok = b.status === 'succeeded'
      const stopped = b.status === 'cancelled'
      const failed = b.status === 'blocked' || b.status === 'interrupted'
      const errorText = b.error?.detail || (b.error?.code ? b.error.code : null)
      return (
        <div className={`dk-mixed-panel terminal ${ok ? 'ok' : stopped ? 'muted' : 'err'}`}>
          <div className="dk-mixed-bar">
            <span className={`dk-mixed-status s-${b.status}`}>{STATUS_LABEL[b.status] ?? b.status}</span>
            <span className="dk-mixed-goal" title={b.goal}>{b.goal}</span>
            <span className="dk-muted dk-xs">{fmtTime(b.updatedAt)}</span>
            <span className="dk-mixed-bar-actions">
              {failed && <button type="button" className="dk-btn sm" disabled={busy == 'rerun'} onClick={() => rerun(b.runId)}>重跑</button>}
              {/* T09「核查后继续」：blocked/interrupted 一律给恢复入口（有错误说明也照给——
                  错误只是原因；不可自动恢复时服务端回明确原因，改走重跑） */}
              {(b.status === 'blocked' || b.status === 'interrupted') && (
                <>
                  <button type="button" className="dk-btn sm" disabled={busy == 'resume-continue'} onClick={() => resume('continue')}>继续</button>
                  <button type="button" className="dk-btn sm" disabled={busy == 'resume-retry'} onClick={() => resume('retry')}>重试</button>
                </>
              )}
              <button type="button" className="dk-btn ghost sm" onClick={() => setDismissed(b.runId)}>关闭</button>
            </span>
          </div>
          <div className="dk-mixed-detail">
            <StorageBanner storage={b.storage ?? info.storage} />
            {errorText && <div className="dk-mixed-err">错误：{errorText}</div>}
            <UsageBlock usage={b.usage} />
            {(b.tasks ?? []).map((t) => (
              <div key={t.taskId} className="dk-mixed-task">
                <span className={`dk-mixed-tstate t-${t.status}`}>{TASK_LABEL[t.status] ?? t.status}</span>
                <span>{t.title}</span>
              </div>
            ))}
          </div>
        </div>
      )
    }

    const run = liveRun

    // ---------- 活动 run 面板 ----------
    const plan = (run.planVersions ?? []).at(-1)
    const lastRound = (run.reviewRounds ?? []).at(-1)
    const queued = run.queuedInputs ?? []

    return (
      <div className={`dk-mixed-panel active${collapsed ? ' collapsed' : ''}`}>
        <div className="dk-mixed-bar" onClick={() => setCollapsed((c) => !c)}>
          <span className={`dk-mixed-status s-${run.status}`}>{STATUS_LABEL[run.status] ?? run.status}</span>
          <span className="dk-mixed-goal" title={run.goal}>{run.goal}</span>
          <span className="dk-muted dk-xs">rev {run.revision}</span>
          <span className="dk-mixed-bar-actions" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="dk-btn danger sm" disabled={busy == 'cancel' || run.status === 'cancelling'} onClick={cancel}>
              {run.status === 'cancelling' ? '停止中…' : '停止'}
            </button>
            <span className={`dk-mixed-caret${collapsed ? '' : ' open'}`} aria-hidden>▾</span>
          </span>
        </div>

        {!collapsed && (
          <div className="dk-mixed-body">
            <StageBar status={run.status} />
            <StorageBanner storage={run.storage ?? info.storage} />

            {run.models && (
              <div className="dk-mixed-models">
                <span className="k">模型</span>
                <ModelTag m={run.models.planner} /> <ModelTag m={run.models.executor} /> <ModelTag m={run.models.reviewer} />
                <span className="dk-muted dk-xs">规划 / 执行 / 审核（创建时快照）</span>
              </div>
            )}

            <UsageBlock usage={run.usage} />

            {run.error && <div className="dk-mixed-err">错误：{run.error.detail || run.error.code}</div>}

            {queued.length > 0 && (
              <div className="dk-mixed-queued">
                运行中你补充了 {queued.length} 条需求，已排队为下一轮（不会修改当前目标）。要按新需求重开：停止后用「重跑」。
              </div>
            )}

            {plan && (
              <div className="dk-mixed-section">
                <div className="k">计划 v{plan.version} · 验收 {plan.acceptance?.length ?? 0} 项 · 任务 {(run.tasks ?? []).length} 个</div>
                {(plan.openQuestions ?? []).length > 0 && (
                  <div className="dk-muted dk-xs">待解问题：{plan.openQuestions.join('；')}</div>
                )}
                <div className="dk-mixed-tasks">
                  {(run.tasks ?? []).map((t) => {
                    const attempts = (run.attempts ?? []).filter((a) => a.taskId === t.taskId)
                    const lastAttempt = attempts.at(-1)
                    return (
                      <div key={t.taskId} className={`dk-mixed-task${t.parentTaskId ? ' sub' : ''}`}>
                        <span className={`dk-mixed-tstate t-${t.status}`}>{TASK_LABEL[t.status] ?? t.status}</span>
                        <span className="dk-mixed-task-title" title={t.goal}>{t.title}</span>
                        {lastAttempt?.model && <ModelTag m={lastAttempt.model} />}
                        {t.blockedReason && <span className="dk-mixed-blocked" title={t.blockedReason}>{t.blockedReason.slice(0, 60)}</span>}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {lastRound && lastRound.result && (
              <div className="dk-mixed-section">
                <div className="k">
                  审核第 {run.reviewRounds.length} 轮 · <span className={`dk-mixed-verdict v-${lastRound.result.verdict}`}>{lastRound.result.verdict}</span>
                  <ModelTag m={run.models?.reviewer} />
                </div>
                <div className="dk-muted dk-xs" style={{ margin: '2px 0 6px' }}>{lastRound.result.summary}</div>
                {(lastRound.result.criteria ?? []).map((c) => (
                  <div key={c.acceptanceId} className="dk-mixed-criterion">
                    <span className={`dk-mixed-tstate ${c.status === 'pass' ? 't-accepted' : c.status === 'fail' ? 't-failed' : 't-pending'}`}>
                      {c.status === 'pass' ? '通过' : c.status === 'fail' ? '不通过' : '未验证'}
                    </span>
                    <span className="dk-muted dk-xs">{c.acceptanceId}</span>
                    <span className="dk-xs" title={c.explanation}>{(c.explanation ?? '').slice(0, 80)}</span>
                  </div>
                ))}
                {(lastRound.result.findings ?? []).map((f) => (
                  <div key={f.findingId} className={`dk-mixed-finding${f.severity === 'blocking' ? ' blocking' : ''}`}>
                    <span className="k">{f.severity === 'blocking' ? '阻塞' : '提示'}</span>
                    <div>
                      <div>{f.description}</div>
                      <div className="dk-muted dk-xs">期望：{f.expected}　实际：{f.actual}</div>
                      {f.repairInstruction && <div className="dk-mixed-repair">返修指令：{f.repairInstruction}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="dk-mixed-section">
              <div className="k">证据（{run.evidence?.length ?? 0}）</div>
              <EvidenceList run={run} onShow={showEvidence} />
            </div>

            {run.status === 'waiting_input' && (
              <WaitingAnswers
                run={run}
                busy={busy}
                onSubmit={(answers) => act('resume-answer', async () => {
                  const r = await api.mixed.resume(run.runId, {
                    answers,
                    expectedRevision: run.revision,
                  })
                  toast(
                    r?.resume?.started
                      ? '补充已提交，正在按你的回答重新规划'
                      : `补充已受理：${r?.resume?.reason ?? '会话打开后自动继续'}`,
                    'info',
                  )
                })}
              />
            )}

            {evView && (
              <div className="dk-mixed-section dk-mixed-evview">
                <div className="dk-row between">
                  <span className="k">证据内容 · {evView.title}</span>
                  <button type="button" className="dk-btn ghost sm" onClick={() => setEvView(null)}>关闭</button>
                </div>
                {evView.error && <div className="dk-mixed-err">{evView.error}</div>}
                {evView.content != null && <pre className="dk-mixed-evtext">{evView.content}</pre>}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }
}
