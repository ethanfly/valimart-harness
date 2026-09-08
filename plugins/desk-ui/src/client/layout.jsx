/**
 * DeskFrame：THE DIVA 的三栏外壳（替代 ui-layout 的 AppFrame）。
 *  - 会话模式：侧栏 | 对话 | 详情
 *  - 任务模式：侧栏 | 任务卡 | 任务进程（对话）
 * 同时承担 ui-layout 的两项职责：ctx.layout 服务（toggleSidebar/openDetails/closeDetails + 任务模式动作）与主题呈现器。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createStore, useStoreValue, deskStore } from './store.js'
import { TaskPanel, TaskChatColumn } from './tasks.jsx'
import { LoginOverlay, Toast } from './login.jsx'
import { DeskTitlebar, useDeskElectron } from './titlebar.jsx'

const SIDEBAR_AUTO_COLLAPSE = 900
const RAIL = 56
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)))

export const layoutStore = createStore({
  sidebar: 280,
  details: 0,
  narrow: false,
  narrowExpanded: false,
  mode: 'chat', // chat | task
  taskChat: 520, // 任务模式下右侧“任务进程”列宽
  taskChatOpen: true,
})

export const layoutActions = {
  setSidebar: (px) => layoutStore.set({ sidebar: clamp(px, 264, 420) }),
  setDetails: (px) => layoutStore.set({ details: clamp(px, 300, 520) }),
  setTaskChat: (px) => layoutStore.set({ taskChat: clamp(px, 380, 760) }),
  toggleSidebar: () =>
    layoutStore.set((s) => (s.narrow ? { ...s, narrowExpanded: !s.narrowExpanded } : { ...s, sidebar: s.sidebar === 0 ? 280 : 0 })),
  setNarrow: (narrow) => layoutStore.set((s) => (s.narrow === narrow ? s : { ...s, narrow, narrowExpanded: false })),
  openDetails: () => layoutStore.set((s) => (s.details === 0 ? { ...s, details: 360 } : s)),
  closeDetails: () => layoutStore.set({ details: 0 }),
  setMode: (mode) => layoutStore.set((s) => (s.mode === mode ? s : { ...s, mode })),
  toggleTaskChat: () => layoutStore.set((s) => ({ ...s, taskChatOpen: !s.taskChatOpen })),
  openTaskChat: () => layoutStore.set((s) => (s.taskChatOpen ? s : { ...s, taskChatOpen: true })),
}

/** ctx.layout 服务面（与 ui-layout 的 LayoutController 兼容，并扩展任务模式）。 */
export class DeskLayoutController {
  toggleSidebar() {
    layoutActions.toggleSidebar()
  }
  openDetails() {
    layoutActions.openDetails()
  }
  closeDetails() {
    layoutActions.closeDetails()
  }
  setMode(mode) {
    layoutActions.setMode(mode)
  }
  getMode() {
    return layoutStore.get().mode
  }
  openTask(taskId) {
    deskStore.set({ selectedTaskId: taskId })
    layoutActions.setMode('task')
  }
  toggleTaskChat() {
    layoutActions.toggleTaskChat()
  }
}

/** 主题呈现器：把 ctx.theme 快照投到 document 上（移植自 ui-layout）。 */
export class ThemePresenter {
  appliedTokens = []
  constructor() {
    this.meta = document.createElement('meta')
    this.meta.name = 'theme-color'
  }
  apply(snapshot) {
    const scheme = snapshot.active.colorScheme
    document.documentElement.style.colorScheme = scheme
    const body = document.body
    if (scheme === 'dark') body.setAttribute('data-ds-dark-theme', '')
    else body.removeAttribute('data-ds-dark-theme')
    for (const name of this.appliedTokens) body.style.removeProperty(name)
    this.appliedTokens = []
    for (const [name, value] of Object.entries(snapshot.active.tokens)) {
      body.style.setProperty(name, value)
      this.appliedTokens.push(name)
    }
    this.meta.content = getComputedStyle(body).backgroundColor
    if (!this.meta.isConnected) document.head.append(this.meta)
    window.deskShell?.setBackground?.(this.meta.content)
  }
  dispose() {
    document.documentElement.style.removeProperty('color-scheme')
    document.body.removeAttribute('data-ds-dark-theme')
    for (const name of this.appliedTokens) document.body.style.removeProperty(name)
    this.appliedTokens = []
    this.meta.remove()
  }
}

function Resizer({ onDrag, onStart, onEnd, invert = false }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  return (
    <div
      className={`dk-resizer${dragging ? ' dragging' : ''}`}
      onPointerDown={(e) => {
        origin.current = e.clientX
        setDragging(true)
        onStart?.()
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!dragging) return
        const dx = e.clientX - origin.current
        onDrag(invert ? -dx : dx)
      }}
      onPointerUp={(e) => {
        if (!dragging) return
        setDragging(false)
        onEnd?.()
        e.currentTarget.releasePointerCapture(e.pointerId)
      }}
    />
  )
}

/**
 * @param props.renderSlot 渲染器给的子槽渲染函数（只能渲染本条目声明的子槽）
 * @param props.useSessions 会话列表 hook
 */
export function DeskFrame({ renderSlot, useSessions, ctx }) {
  const panels = useStoreValue(layoutStore)
  const desk = useStoreValue(deskStore, (s) => s.desk)
  const phase = useStoreValue(deskStore, (s) => s.phase)
  const selectedTaskId = useStoreValue(deskStore, (s) => s.selectedTaskId)
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })
  const frameRef = useRef(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const lastSession = useRef(detailsSession)

  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) layoutActions.closeDetails()
    lastSession.current = detailsSession
  }, [detailsSession])

  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    let raf = null
    const ob = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const w = el.getBoundingClientRect().width
        if (w > 0) setViewport(w)
      })
    })
    ob.observe(el)
    return () => {
      ob.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  useEffect(() => layoutActions.setNarrow(narrow), [narrow])

  const sidebarCollapsed = narrow ? !panels.narrowExpanded : panels.sidebar === 0
  const sidebarWidth = narrow ? RAIL : sidebarCollapsed ? RAIL : panels.sidebar
  const taskMode = panels.mode === 'task'
  const showDetails = !taskMode && detailsSession !== undefined && panels.details > 0
  const detailsWidth = showDetails ? Math.min(panels.details, Math.max(300, viewport - sidebarWidth - 640)) : 0
  const showTaskChat = taskMode && panels.taskChatOpen
  const taskChatWidth = showTaskChat ? Math.min(panels.taskChat, Math.max(360, viewport - sidebarWidth - 420)) : 0

  const sidebarBase = useRef(0)
  const detailsBase = useRef(0)
  const chatBase = useRef(0)
  const onSidebarDrag = useCallback((dx) => layoutActions.setSidebar(sidebarBase.current + dx), [])
  const onDetailsDrag = useCallback((dx) => layoutActions.setDetails(detailsBase.current + dx), [])
  const onChatDrag = useCallback((dx) => layoutActions.setTaskChat(chatBase.current + dx), [])

  const conversation = renderSlot('conversation', {})
  const electron = useDeskElectron()

  return (
    <div ref={frameRef} className="dk-frame" data-dsh-frame data-mode={panels.mode} data-sidebar-collapsed={sidebarCollapsed || undefined} data-electron={electron || undefined}>
      {electron && createPortal(<DeskTitlebar sidebarWidth={sidebarWidth} />, document.body)}
      {narrow && panels.narrowExpanded && <div className="dk-mask" onClick={() => layoutActions.toggleSidebar()} />}
      <div className={`dk-col-sidebar${narrow && panels.narrowExpanded ? ' dk-drawer' : ''}`} style={{ width: narrow && panels.narrowExpanded ? 280 : sidebarWidth }}>
        {renderSlot('sidebar', { collapsed: narrow ? !panels.narrowExpanded : sidebarCollapsed, width: narrow && panels.narrowExpanded ? 280 : sidebarWidth })}
      </div>
      {!sidebarCollapsed && !narrow && <Resizer onStart={() => (sidebarBase.current = panels.sidebar)} onDrag={onSidebarDrag} />}

      {taskMode ? (
        <>
          <div className="dk-col-main">
            <TaskPanel ctx={ctx} taskId={selectedTaskId} useSessions={useSessions} chatOpen={showTaskChat} />
          </div>
          {showTaskChat && <Resizer invert onStart={() => (chatBase.current = panels.taskChat)} onDrag={onChatDrag} />}
          {showTaskChat && (
            <div className="dk-col-right" style={{ width: taskChatWidth }}>
              <TaskChatColumn ctx={ctx} taskId={selectedTaskId} useSessions={useSessions}>
                {conversation}
              </TaskChatColumn>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="dk-col-main">
            <div className="dk-slot-fill">{conversation}</div>
          </div>
          {showDetails && <Resizer invert onStart={() => (detailsBase.current = panels.details)} onDrag={onDetailsDrag} />}
          {detailsSession !== undefined && (
            <div className="dk-col-right" style={{ width: detailsWidth, display: showDetails ? undefined : 'none' }}>
              <div className="dk-slot-fill">{renderSlot('details', {})}</div>
            </div>
          )}
        </>
      )}

      <div data-shell-overlay style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 1000 }}>
        {renderSlot('shell.overlay', {})}
      </div>
      {/* 未登录，或本机网关令牌已被吊销 / 失效（needsRelogin）→ 立刻回到登录遮罩，不让人对着「API key is invalid」发懵 */}
      {phase !== 'loading' && (!desk?.loggedIn || desk?.needsRelogin) && <LoginOverlay />}
      <Toast />
    </div>
  )
}
