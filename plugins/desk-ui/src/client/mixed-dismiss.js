/**
 * Mixed 终态横幅「关闭」记忆：按会话记住最后关掉的 runId。
 * 组件卸载（换会话再点回来）或刷新后仍不弹同一条；新 run 的 id 不同，会再出现。
 */
export const DISMISS_KEY = 'dk-mixed-dismissed-runs'

export function loadDismissedRuns(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem?.(DISMISS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    for (const [sessionId, runId] of Object.entries(parsed)) {
      if (typeof sessionId === 'string' && sessionId && typeof runId === 'string' && runId) out[sessionId] = runId
    }
    return out
  } catch {
    return {}
  }
}

export function writeDismissedRuns(map, storage = globalThis.localStorage) {
  try {
    storage?.setItem?.(DISMISS_KEY, JSON.stringify(map ?? {}))
  } catch {
    /* 隐私模式 / 配额满：调用方仍可把 map 留在内存 */
  }
}

export function dismissRunId(map, sessionId, runId) {
  if (!sessionId || !runId) return map
  if (map?.[sessionId] === runId) return map
  return { ...map, [sessionId]: runId }
}

export function isRunDismissed(map, sessionId, runId) {
  return !!sessionId && !!runId && map?.[sessionId] === runId
}
