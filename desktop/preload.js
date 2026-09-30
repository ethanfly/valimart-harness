/**
 * 桌面壳预加载：窗口控制。无 deskShell 时渲染进程不画标题栏。
 * 插件 UI 尚未挂上时先插一条兜底按钮，避免隐藏原生栏后窗口无法关闭。
 * 拖窗走 CSS -webkit-app-region: drag，由系统合成器跟手，不走 IPC setPosition。
 */
'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('deskShell', {
  isElectron: true,
  minimize: () => ipcRenderer.send('desk:window-minimize'),
  maximize: () => ipcRenderer.send('desk:window-maximize'),
  close: () => ipcRenderer.send('desk:window-close'),
  getPrefs: () => ipcRenderer.invoke('desk:prefs-get'),
  setPrefs: (patch) => ipcRenderer.invoke('desk:prefs-set', patch),
  getState: () => ipcRenderer.invoke('desk:window-state'),
  onState: (cb) => {
    const listener = (_event, state) => cb(state)
    ipcRenderer.on('desk:window-state', listener)
    return () => ipcRenderer.removeListener('desk:window-state', listener)
  },
  setBackground: (color) => ipcRenderer.send('desk:window-bg', color),
  openExternal: (u) => ipcRenderer.send('desk:open-external', u),
  // caption 上的「应用 / 编辑」：渲染进程只报位置，菜单由主进程原生弹出。
  openMenu: (name, x, y) => ipcRenderer.invoke('desk:menu-popup', name, x, y),
})

const FALLBACK_ID = 'dk-shell-fallback'
const TITLEBAR_H = 40
const btnCss =
  'width:46px;height:40px;border:0;border-radius:0;background:transparent;color:#56565c;cursor:pointer;-webkit-app-region:no-drag;display:inline-flex;align-items:center;justify-content:center;padding:0;font-size:10px;line-height:1;'

// 这张栏只在插件 UI 还没挂上时兜底，不需要和自绘窗控逐像素一致：用文本字形即可。
const FALLBACK_BUTTONS = [
  { act: 'min', label: '最小化', glyph: '❘' },
  { act: 'max', label: '最大化', glyph: '❐' },
  { act: 'close', label: '关闭', glyph: '✕' },
]

function installFallback() {
  if (document.getElementById(FALLBACK_ID) || document.querySelector('.dk-titlebar')) return
  const bar = document.createElement('div')
  bar.id = FALLBACK_ID
  bar.setAttribute('role', 'banner')
  bar.style.cssText =
    `position:fixed;top:0;left:0;right:0;height:${TITLEBAR_H}px;z-index:2147483000;display:flex;justify-content:flex-end;align-items:stretch;-webkit-app-region:drag;user-select:none;`
  for (const { act, label, glyph } of FALLBACK_BUTTONS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.dataset.act = act
    btn.setAttribute('aria-label', label)
    btn.setAttribute('title', label)
    btn.style.cssText = btnCss
    btn.textContent = glyph
    btn.addEventListener('mouseenter', () => {
      const close = act === 'close'
      btn.style.background = close ? '#c42b1c' : 'rgba(0,0,0,.06)'
      btn.style.color = close ? '#fff' : '#1b1b1f'
    })
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'transparent'
      btn.style.color = '#56565c'
    })
    btn.addEventListener('click', () => {
      if (act === 'min') ipcRenderer.send('desk:window-minimize')
      else if (act === 'max') ipcRenderer.send('desk:window-maximize')
      else ipcRenderer.send('desk:window-close')
    })
    bar.append(btn)
  }
  document.documentElement.append(bar)
}

function bootChrome() {
  document.documentElement.classList.add('dk-desk-electron')
  const sync = () => {
    if (document.querySelector('.dk-titlebar')) document.getElementById(FALLBACK_ID)?.remove()
    else installFallback()
  }
  sync()
  new MutationObserver(sync).observe(document.documentElement, { childList: true, subtree: true })
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootChrome, { once: true })
else bootChrome()
