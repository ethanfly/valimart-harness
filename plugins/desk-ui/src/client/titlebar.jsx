/**
 * Electron 自定义标题栏：只在 window.deskShell 存在时渲染。
 * 浏览器 / Edge --app 开发窗没有 preload，这里必须返回 null，避免空白条或重复标题。
 */
import { useEffect, useState } from 'react'
import { BrandMark, PRODUCT_NAME } from './brand.jsx'
import { IconWinClose, IconWinMax, IconWinMin, IconWinRestore } from './icons.jsx'

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

export function DeskTitlebar({ sidebarWidth }) {
  const shell = getDeskShell()
  const [state, setState] = useState({ maximized: false, focused: true })

  useEffect(() => {
    if (!shell) return undefined
    shell.getState?.().then((s) => s && setState(s)).catch(() => {})
    return shell.onState?.((s) => setState(s))
  }, [shell])

  if (!shell) return null

  return (
    <header
      className="dk-titlebar"
      data-focused={state.focused ? '' : undefined}
      data-maximized={state.maximized ? '' : undefined}
      style={{ '--dk-titlebar-side-w': `${sidebarWidth}px` }}
    >
      <div className="dk-titlebar-side" aria-hidden />
      <div className="dk-titlebar-main">
        <span className="dk-titlebar-title">
          <BrandMark size={13} />
          <span>{PRODUCT_NAME}</span>
        </span>
      </div>
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
