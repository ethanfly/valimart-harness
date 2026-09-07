/**
 * 打开本机内核里还活着的会话。
 * 任务卡上的 sessionId 可能来自别的设备或已经删掉的窗口；内核 sessions.open()
 * 对未知 id 是同步抛错。丢在 React effect 里会被 root 槽的 ErrorBoundary 吃掉，整窗白屏。
 */

export function sessionKnown(ctx, sessionId) {
  if (!sessionId || !ctx?.sessions) return false
  const snap = ctx.sessions.list?.getSnapshot?.()
  if (!snap) return null
  if (snap.byId && Object.prototype.hasOwnProperty.call(snap.byId, sessionId)) return snap.byId[sessionId] != null
  if (Array.isArray(snap.ids)) return snap.ids.includes(sessionId)
  return false
}

export function safeOpenSession(ctx, sessionId, { requireKnown = false } = {}) {
  if (!sessionId || !ctx?.sessions?.open) return false
  if (requireKnown && sessionKnown(ctx, sessionId) === false) return false
  try {
    ctx.sessions.open(sessionId)
    return true
  } catch {
    return false
  }
}
