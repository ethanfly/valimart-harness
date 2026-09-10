/**
 * DeskFrame：THE DIVA 的三栏外壳（替代 ui-layout 的 AppFrame）。
 *  - 会话模式：侧栏 | main（对话或全局面板） | rightbar
 *  - 任务模式：侧栏 | 任务卡 | 任务进程（对话）
 * 0.1.5 起官方根槽从 conversation/details 改成 keyed `main` + `rightbar`；
 * ctx.layout 对齐 toggleSidebar / selectPanel / beginNavigation / openRightbar / closeRightbar。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createStore, useStoreValue, deskStore } from './store.js'
import { TaskPanel, TaskChatColumn } from './tasks.jsx'
import { LoginOverlay, Toast } from './login.jsx'
import { DeskTitlebar, useDeskElectron } from './titlebar.jsx'

const SIDEBAR_AUTO_COLLAPSE = 900
const RAIL = 56
const RIGHTBAR_DEFAULT_RATIO = 0.45
const CONTENT_FONT_SIZE_VARIABLE = '--dsh-content-font-size'
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)))

export const layoutStore = createStore({
  sidebar: 280,
  details: 0,
  narrow: false,
  narrowExpanded: false,
  mode: 'chat', // chat | task
  taskChat: 520, // 任务模式下右侧“任务进程”列宽
  taskChatOpen: true,
  activePanelId: null,
  rightbar: null,
  rightbarShown: false,
  rightbarTrack: false,
  rightbarFullscreen: false,
})

export const layoutActions = {
  setSidebar: (px) => layoutStore.set({ sidebar: clamp(px, 264, 420) }),
  setDetails: (px) => layoutStore.set({ details: clamp(px, 300, 520) }),
  setTaskChat: (px) => layoutStore.set({ taskChat: clamp(px, 380, 760) }),
  toggleSidebar: () =>
    layoutStore.set((s) => (s.narrow ? { ...s, narrowExpanded: !s.narrowExpanded } : { ...s, sidebar: s.sidebar === 0 ? 280 : 0 })),
  setNarrow: (narrow) => layoutStore.set((s) => (s.narrow === narrow ? s : { ...s, narrow, narrowExpanded: false })),
  selectPanel: (panelId) => layoutStore.set({ activePanelId: panelId }),
  retainMainPanels: (ids) =>
    layoutStore.set((s) => (s.activePanelId !== null && !ids.includes(s.activePanelId) ? { ...s, activePanelId: null } : s)),
  setRightbar: (px, viewport = typeof window === 'undefined' ? 1280 : window.innerWidth) =>
    layoutStore.set({ rightbar: clamp(px, 300, Math.max(300, Math.round(viewport * 0.55))) }),
  openRightbar: (track, fullscreen) =>
    layoutStore.set((s) => ({
      ...s,
      rightbar: s.rightbar ?? Math.max(300, Math.round((typeof window === 'undefined' ? 1280 : window.innerWidth) * RIGHTBAR_DEFAULT_RATIO)),
      rightbarShown: true,
      rightbarTrack: track,
      rightbarFullscreen: fullscreen,
      narrowExpanded: !s.rightbarShown && s.narrow ? false : s.narrowExpanded,
    })),
  closeRightbar: () => layoutStore.set({ rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false }),
  openDetails: () => layoutActions.openRightbar(true, false),
  closeDetails: () => layoutActions.closeRightbar(),
  setMode: (mode) => layoutStore.set((s) => (s.mode === mode ? s : { ...s, mode })),
  toggleTaskChat: () => layoutStore.set((s) => ({ ...s, taskChatOpen: !s.taskChatOpen })),
  openTaskChat: () => layoutStore.set((s) => (s.taskChatOpen ? s : { ...s, taskChatOpen: true })),
}

/** ctx.layout 服务面（对齐 0.1.5 ui-layout 的 LayoutController，并扩展任务模式）。 */
export class DeskLayoutController {
  navigation = new AbortController()
  constructor({ hasMainPanel } = {}) {
    this.hasMainPanel = hasMainPanel ?? (() => true)
  }
  selectPanel(panelId) {
    if (panelId !== null && !this.hasMainPanel(panelId)) throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
    this.navigation.abort()
    layoutActions.selectPanel(panelId)
  }
  beginNavigation() {
    this.navigation.abort()
    this.navigation = new AbortController()
    return this.navigation.signal
  }
  dispose() {
    this.navigation.abort()
  }
  toggleSidebar() {
    layoutActions.toggleSidebar()
  }
  openRightbar(track, fullscreen) {
    layoutActions.openRightbar(track, fullscreen)
  }
  closeRightbar() {
    layoutActions.closeRightbar()
  }
  openDetails() {
    this.openRightbar(true, false)
  }
  closeDetails() {
    this.closeRightbar()
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
    if (snapshot.fontSize != null) body.style.setProperty(CONTENT_FONT_SIZE_VARIABLE, `${snapshot.fontSize}px`)
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
    document.body.style.removeProperty(CONTENT_FONT_SIZE_VARIABLE)
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
  const frameRef = useRef(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)

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
  const rightbarPref = panels.rightbar ?? Math.max(300, Math.round(viewport * RIGHTBAR_DEFAULT_RATIO))
  const rightbarTrack = !taskMode && panels.rightbarShown && panels.rightbarTrack
  const rightbarWidth = rightbarTrack ? Math.min(rightbarPref, Math.max(300, viewport - sidebarWidth - 480)) : 0
  const showTaskChat = taskMode && panels.taskChatOpen
  const taskChatWidth = showTaskChat ? Math.min(panels.taskChat, Math.max(360, viewport - sidebarWidth - 420)) : 0

  const sidebarBase = useRef(0)
  const rightbarBase = useRef(0)
  const chatBase = useRef(0)
  const onSidebarDrag = useCallback((dx) => layoutActions.setSidebar(sidebarBase.current + dx), [])
  const onRightbarDrag = useCallback((dx) => layoutActions.setRightbar(rightbarBase.current + dx, viewport), [viewport])
  const onChatDrag = useCallback((dx) => layoutActions.setTaskChat(chatBase.current + dx), [])

  const mainPanel = renderSlot('main', {}, { entryKey: taskMode ? 'conversation' : panels.activePanelId ?? 'conversation' })
  const electron = useDeskElectron()

  return (
    <div
      ref={frameRef}
      className="dk-frame"
      data-dsh-frame
      data-mode={panels.mode}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-rightbar-collapsed={!rightbarTrack || undefined}
      data-rightbar-fullscreen={panels.rightbarFullscreen || undefined}
      data-electron={electron || undefined}
    >
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
                {mainPanel}
              </TaskChatColumn>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="dk-col-main">
            <div className="dk-slot-fill" data-dsh-center-col>{mainPanel}</div>
          </div>
          {rightbarTrack && !panels.rightbarFullscreen && <Resizer invert onStart={() => (rightbarBase.current = rightbarPref)} onDrag={onRightbarDrag} />}
          <div className="dk-col-right" data-rightbar-col data-collapsed={rightbarWidth === 0 || undefined} style={{ width: rightbarWidth }}>
            {renderSlot('rightbar', { width: rightbarPref, viewportWidth: viewport, canShow: rightbarPref > 0 && panels.rightbarShown })}
          </div>
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
