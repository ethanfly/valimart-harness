/**
 * Mixed 混合模式 · 客户端轮询 store（计划 §7.1：活动 1s / 空闲 5s / 页面隐藏停 / 聚焦立即同步 /
 * 失败退避至 15s / revision 防旧覆盖；首版无 SSE）。
 *
 * 模块级单例轮询循环：chip 与运行面板各自挂载时 watch(sessionId)，卸载时 unwatch；
 * 有会话处于活动 run → 1s 档，全部静止 → 5s 档，文档隐藏 → 停表（可见/聚焦立即补一次）。
 */
import { createStore, useStoreValue } from './store.js'
import { api } from './api.js'

export const MIXED_ACTIVE = new Set(['queued', 'planning', 'executing', 'waiting_input', 'reviewing', 'repairing', 'finalizing', 'cancelling'])
export const MIXED_TERMINAL = new Set(['succeeded', 'cancelled'])

export const mixedStore = createStore({
  /** sessionId → {mode, activeRun, canToggle, configured, loadedAt, error} */
  sessions: {},
  /** runId → run 详情（完整记录，含 tasks/attempts/reviewRounds/evidence/events） */
  runs: {},
  /** sessionId → 最近一条 run 摘要（无活动 run 时面板展示最新结果/重跑入口） */
  lastRuns: {},
  watching: [],
  polling: 'stopped', // stopped | idle | active
  backoffMs: 0,
  error: null,
})

export function useMixedState(selector) {
  return useStoreValue(mixedStore, selector)
}

const watchSet = new Set()
let timer = null
let inflight = false

function schedule() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (watchSet.size === 0 || document.hidden) {
    mixedStore.set({ polling: 'stopped' })
    return
  }
  const s = mixedStore.get()
  const anyActive = [...watchSet].some((sid) => {
    const info = s.sessions[sid]
    return info?.activeRun && MIXED_ACTIVE.has(info.activeRun.status)
  })
  const interval = anyActive ? 1000 : 5000
  mixedStore.set({ polling: anyActive ? 'active' : 'idle' })
  timer = setTimeout(tick, interval)
}

async function fetchSession(sid) {
  const info = await api.mixed.session(sid)
  const s = mixedStore.get()
  const prev = s.sessions[sid]
  // revision 防旧覆盖：并发旧 GET（含尚未落盘的 mode:null）不得盖掉刚 POST 成功的本地状态
  const prevRev = prev?.mode?.revision
  const incomingRev = info?.mode?.revision
  const stale = prevRev != null && (incomingRev == null || incomingRev < prevRev)
  const next = {
    ...info,
    loadedAt: Date.now(),
    error: null,
  }
  mixedStore.set((st) => ({
    ...st,
    sessions: { ...st.sessions, [sid]: stale ? st.sessions[sid] : next },
    lastRuns: { ...st.lastRuns, [sid]: st.lastRuns[sid] ?? null },
  }))
  // 非终态 run（活动 + blocked/interrupted 可恢复态）→ 拉详情；revision 相同且终态则跳过
  if (info.activeRun && !MIXED_TERMINAL.has(info.activeRun.status)) {
    const detail = await api.mixed.run(info.activeRun.runId)
    mixedStore.set((st) => {
      const cur = st.runs[info.activeRun.runId]
      if (cur && cur.revision > detail.revision) return st // 防旧覆盖
      return { ...st, runs: { ...st.runs, [info.activeRun.runId]: detail } }
    })
  }
  // 无活动 run → 补齐最近一条（供结果横幅/重跑）
  if (!info.activeRun) {
    const s2 = mixedStore.get()
    if (!s2.lastRuns[sid]) {
      const r = await api.mixed.runs(sid)
      mixedStore.set((st) => ({ ...st, lastRuns: { ...st.lastRuns, [sid]: r.items?.[0] ?? null } }))
    }
  }
}

async function tick() {
  if (inflight) return
  if (watchSet.size === 0) return
  inflight = true
  let failed = 0
  try {
    for (const sid of [...watchSet]) {
      try {
        await fetchSession(sid)
      } catch (err) {
        failed += 1
        mixedStore.set((st) => ({
          ...st,
          error: err.message,
          sessions: { ...st.sessions, [sid]: { ...(st.sessions[sid] ?? {}), error: err.message, loadedAt: Date.now() } },
        }))
      }
    }
  } finally {
    inflight = false
    // 失败退避（×1.5 至 15s）；成功清零
    const s = mixedStore.get()
    mixedStore.set({ backoffMs: failed ? Math.min(15000, Math.max(s.backoffMs, 500) * 1.5) : 0 })
    schedule()
  }
}

async function immediate() {
  schedule()
  if (watchSet.size) await tick()
}

export function watchMixedSession(sessionId) {
  if (!sessionId || watchSet.has(sessionId)) return () => {}
  watchSet.add(sessionId)
  mixedStore.set({ watching: [...watchSet] })
  immediate()
  return () => unwatchMixedSession(sessionId)
}

export function unwatchMixedSession(sessionId) {
  if (!watchSet.delete(sessionId)) return
  mixedStore.set({ watching: [...watchSet] })
  schedule()
}

/** 把会话 Mixed 快照立刻写入 store（POST 成功后用，避免等 5s 空闲轮询才亮芯片）。 */
export function applyMixedSession(sessionId, patch) {
  if (!sessionId || !patch) return
  mixedStore.set((st) => {
    const prev = st.sessions[sessionId] ?? {}
    return {
      ...st,
      sessions: {
        ...st.sessions,
        [sessionId]: {
          ...prev,
          ...patch,
          mode: patch.mode != null ? { ...(prev.mode ?? {}), ...patch.mode } : prev.mode,
          loadedAt: Date.now(),
          error: patch.error ?? null,
        },
      },
    }
  })
}

/** 设置保存等外部事件后立刻拉一轮（不等 5s 空闲周期），让芯片的 configured 等状态即时更新。 */
export function refreshMixedSessions() {
  if (watchSet.size) immediate()
}

let started = false
export function startMixedPolling() {
  if (started) return () => {}
  started = true
  const onVis = () => {
    if (document.hidden) schedule()
    else immediate()
  }
  document.addEventListener('visibilitychange', onVis)
  window.addEventListener('focus', immediate)
  return () => {
    started = false
    document.removeEventListener('visibilitychange', onVis)
    window.removeEventListener('focus', immediate)
    if (timer) clearTimeout(timer)
    timer = null
  }
}
