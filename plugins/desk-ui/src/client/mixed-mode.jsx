/**
 * 输入框工具行「Mixed」芯片（conversation.input.left，order 12）：
 * Mixed 开关 + 三模型摘要 + Plan 互斥提示。
 *
 * - 启用/关闭走 POST /sessions/:id/mixed（revision 栅栏；运行中 canToggle=false → 先停止）；
 * - Plan 模式激活时拒绝启用（互斥，计划 T08②）：官方 PlanChip 只在 plan mode 激活时渲染，
 *   按稳定选择器（模块类名 + aria/title 文案）DOM 探测，双信号兜底；
 * - 未配置三模型 → 提示去「设置 → Mixed」；
 * - 挂载/启用时向宿主 ping attach（POST /sessions/:id/mixed/attach）：会话 agent 在线即挂桥。
 */
import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { deskStore, toast, useStoreValue } from './store.js'
import { applyMixedSession, MIXED_ACTIVE, useMixedState, watchMixedSession } from './mixed-store.js'

const PLAN_CHIP_SELECTOR = 'button[class*="rS3zOq_chip"], button[title*="/plan off"], button[aria-label*="plan mode 已开启"], button[aria-label*="Plan mode on"]'

/** Plan 模式是否激活（官方 PlanChip 仅激活时渲染；DOM 探测，MutationObserver 跟踪）。 */
function usePlanModeActive() {
  const [active, setActive] = useState(() => !!document.querySelector(PLAN_CHIP_SELECTOR))
  useEffect(() => {
    const sync = () => {
      const next = !!document.querySelector(PLAN_CHIP_SELECTOR)
      setActive((prev) => (prev === next ? prev : next))
    }
    sync()
    const mo = new MutationObserver(sync)
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'title', 'aria-label'] })
    return () => mo.disconnect()
  }, [])
  return active
}

export function makeMixedChip() {
  return function MixedChip({ sessionId }) {
    const loggedIn = useStoreValue(deskStore, (s) => !!s.desk?.loggedIn)
    const info = useMixedState((s) => (sessionId ? s.sessions[sessionId] : undefined))
    const planActive = usePlanModeActive()
    const [summary, setSummary] = useState(null) // {planner:'x/y', ...}
    const [busy, setBusy] = useState(false)
    const [pendingEnabled, setPendingEnabled] = useState(null) // 点击瞬间的乐观开关，避免等 toast / 5s 轮询
    const summaryRef = useRef(0)

    const enabled = pendingEnabled != null ? pendingEnabled : !!info?.mode?.enabled
    const activeRun = info?.activeRun && MIXED_ACTIVE.has(info.activeRun.status) ? info.activeRun : null
    const locked = activeRun != null || info?.canToggle === false

    // 三模型摘要（标题提示；60s 缓存）
    useEffect(() => {
      if (!loggedIn) return
      if (Date.now() - summaryRef.current > 60_000) {
        summaryRef.current = Date.now()
        api.mixed.config().then((r) => {
          if (r?.preferences) setSummary({ planner: r.preferences.planner, executor: r.preferences.executor, reviewer: r.preferences.reviewer })
        }).catch(() => {})
      }
    }, [loggedIn, info?.mode?.revision, enabled])

    // 挂载/启用时 ping attach（宿主按「启用 + agent 在线」挂桥）
    useEffect(() => {
      if (!sessionId || !enabled) return
      api.mixed.attach(sessionId).catch(() => {})
    }, [sessionId, enabled])

    // 挂载即 watch（会话存在就轮询：空闲 5s / 活动 1s；chip 卸载时停）
    useEffect(() => {
      if (!sessionId) return
      return watchMixedSession(sessionId)
    }, [sessionId])

    useEffect(() => {
      setPendingEnabled(null)
    }, [sessionId])

    if (!sessionId) return null

    const summaryText = summary
      ? `规划 ${summary.planner.catalogProvider}/${summary.planner.modelId} · 执行 ${summary.executor.catalogProvider}/${summary.executor.modelId} · 审核 ${summary.reviewer.catalogProvider}/${summary.reviewer.modelId}`
      : '未配置三模型（设置 → Mixed）'

    const toggle = async () => {
      if (busy || !sessionId) return
      // Plan 互斥以点击瞬间的 DOM 为准（fail-closed）：observer 状态要等下一次 commit 刷新事件闭包，
      // 「刚打开 Plan 立即点 Mixed」的快点击可能落在旧闭包上，直接查 DOM 堵住该竞态
      const planNow = planActive || !!document.querySelector(PLAN_CHIP_SELECTOR)
      if (!enabled && planNow) {
        toast('该会话 Plan 模式已开启：Mixed 与 Plan 互斥，先点掉输入框里的 Plan 标签再启用 Mixed', 'error')
        return
      }
      if (!enabled && info?.canToggle === false) {
        toast('当前有 Mixed 运行中：先停止运行再切换', 'error')
        return
      }
      if (!enabled) {
        // 配置以实时为准：刚在「设置 → Mixed」保存时，会话轮询可能还没跟上（5s 空闲档）
        let configured = !!info?.configured
        if (!configured) {
          try {
            const cfg = await api.mixed.config()
            configured = !!(cfg?.preferences?.planner && cfg?.preferences?.executor && cfg?.preferences?.reviewer)
          } catch { /* 保持缓存判断 */ }
        }
        if (!configured) {
          toast('Mixed 还没配置三个角色的模型：打开「设置 → Mixed」完成配置', 'error')
          return
        }
      }
      const next = !enabled
      setPendingEnabled(next)
      setBusy(true)
      try {
        const body = { enabled: next }
        if (info?.mode?.revision != null) body.expectedRevision = info.mode.revision
        const r = await api.mixed.setSession(sessionId, body)
        if (r?.mode) applyMixedSession(sessionId, { mode: r.mode })
        setPendingEnabled(null)
        if (r.attached && !r.attached.attached) {
          const why = r.attached.reason === 'agent_not_live' ? '会话尚未上线，agent 就绪后自动挂载'
            : r.attached.reason === 'runtime_unavailable' ? '本机版本未启用 Mixed 运行引擎'
            : `桥接未挂载（${r.attached.reason ?? 'unknown'}）`
          toast(`Mixed 已${next ? '启用' : '关闭'}；${why}`, 'info')
        } else {
          toast(next ? 'Mixed 已启用：下一条消息按 规划→实施→审核 走' : 'Mixed 已关闭：回到普通模式', 'success')
        }
      } catch (err) {
        setPendingEnabled(null)
        toast(err.code === 'config_revision_conflict' ? '会话模式版本冲突：已刷新，请重试' : err.message, 'error')
      } finally {
        setBusy(false)
      }
    }

    return (
      <button
        type="button"
        className={`dk-composer-chip dk-mixed-chip${enabled ? ' on' : ''}${locked ? ' locked' : ''}`}
        title={enabled ? `Mixed 已启用（下一条消息起生效）\n${summaryText}\n点击关闭` : `启用 Mixed 混合模式\n${summaryText}`}
        aria-label="Mixed 混合模式"
        disabled={busy}
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
      >
        <span className="dk-composer-chip-icon" aria-hidden>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="5" cy="4.5" r="1.8" />
            <circle cx="11" cy="8" r="1.8" />
            <circle cx="5" cy="11.5" r="1.8" />
            <path d="M6.7 5.3 9.2 7M9.2 9l-2.5 1.7" />
          </svg>
        </span>
        <span className="dk-composer-chip-label">Mixed</span>
        {activeRun && <span className={`dk-mixed-dot st-${activeRun.status}`} title={`运行中：${activeRun.status}`} />}
      </button>
    )
  }
}
