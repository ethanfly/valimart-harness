/**
 * Electron 自定义标题栏：只在 window.deskShell 存在时渲染。
 * 几何照上游桌面端（apps/desktop 的 Windows caption，40px）：整条独占一行、与侧栏同色，
 * 左边「折叠侧栏 + 应用/编辑」，右边窗控；菜单走主进程原生弹出（不自己画弹层）。
 * 浏览器 / Edge --app 开发窗没有 preload，这里必须返回 null，避免空白条或重复标题。
 */
import { useEffect, useState } from 'react'
import { IconPanel, IconWinClose, IconWinMax, IconWinMin, IconWinRestore } from './icons.jsx'

const CAPTION_MENUS = [
  { id: 'application', label: '应用' },
  { id: 'edit', label: '编辑' },
]

export function getDeskShell() {
  if (typeof window === 'undefined') return null
  const shell = window.deskShell
  return shell && shell.isElectron === true ? shell : null
}

export function useDeskElectron() {
  const [on, setOn] = useState(() => Boolean(getDeskShell()))
  useEffect(() => {
    const shell = getDeskShell()
    setOn(Boolean(shell))
    const root = document.documentElement
    if (!shell) return undefined
    root.classList.add('dk-desk-electron')
    const apply = (s) => {
      root.classList.toggle('dk-desk-maximized', Boolean(s?.maximized))
      // Also ignore the native-frame estimate supplied by older desktop shells.
      root.style.setProperty('--dk-win-inset', '0px')
    }
    shell.getState?.().then(apply).catch(() => {})
    const off = shell.onState?.(apply)
    return () => {
      off?.()
      root.classList.remove('dk-desk-maximized')
      root.style.removeProperty('--dk-win-inset')
    }
  }, [])
  return on
}

export function DeskTitlebar({ onToggleSidebar }) {
  const shell = getDeskShell()
  const [state, setState] = useState({ maximized: false, focused: true })
  const [openMenuId, setOpenMenuId] = useState(null)

  useEffect(() => {
    if (!shell) return undefined
    shell.getState?.().then((s) => s && setState(s)).catch(() => {})
    return shell.onState?.((s) => setState(s))
  }, [shell])

  if (!shell) return null

  // 原生菜单是模态的：promise 在菜单关掉时才 resolve，期间按钮保持按下态。
  const openMenu = (id, event) => {
    if (typeof shell.openMenu !== 'function') return
    const rect = event.currentTarget.getBoundingClientRect()
    setOpenMenuId(id)
    Promise.resolve(shell.openMenu(id, Math.round(rect.left), Math.round(rect.bottom)))
      .catch(() => {})
      .finally(() => setOpenMenuId((cur) => (cur === id ? null : cur)))
  }

  return (
    <header
      className="dk-titlebar"
      data-focused={state.focused ? '' : undefined}
      data-maximized={state.maximized ? '' : undefined}
    >
      <button type="button" className="dk-caption-btn dk-caption-toggle" title="收起侧边栏" aria-label="收起侧边栏" onClick={() => onToggleSidebar?.()}>
        <IconPanel />
      </button>
      <div className="dk-caption-menubar" role="menubar">
        {CAPTION_MENUS.map((menu) => (
          <button
            key={menu.id}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={openMenuId === menu.id || undefined}
            className="dk-caption-btn"
            // 弹出的原生菜单结束后焦点要回到页面里，别把编辑器选区弄丢。
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => openMenu(menu.id, e)}
          >
            {menu.label}
          </button>
        ))}
      </div>
      <div className="dk-titlebar-spacer" aria-hidden />
      <div className="dk-titlebar-controls">
        <button type="button" className="dk-winbtn" aria-label="最小化" onClick={() => shell.minimize()}>
          <IconWinMin />
        </button>
        <button type="button" className="dk-winbtn" aria-label={state.maximized ? '还原' : '最大化'} onClick={() => shell.maximize()}>
          {state.maximized ? <IconWinRestore /> : <IconWinMax />}
        </button>
        <button type="button" className="dk-winbtn close" aria-label="关闭" onClick={() => shell.close()}>
          <IconWinClose />
        </button>
      </div>
    </header>
  )
}
