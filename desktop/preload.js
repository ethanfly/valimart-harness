/**
 * 桌面壳预加载：窗口控制及 Windows 标题栏拖动。无 deskShell 时渲染进程不画标题栏。
 * 插件 UI 尚未挂上时先插一条兜底按钮，避免隐藏原生栏后窗口无法关闭。
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
})

const FALLBACK_ID = 'dk-shell-fallback'
const btnCss =
  'width:46px;height:36px;border:0;border-radius:0;background:transparent;color:#56565c;cursor:pointer;-webkit-app-region:no-drag;display:inline-flex;align-items:center;justify-content:center;padding:0;'

function glyph(inner) {
  return `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1">${inner}</svg>`
}

function installFallback() {
  if (document.getElementById(FALLBACK_ID) || document.querySelector('.dk-titlebar')) return
  const bar = document.createElement('div')
  bar.id = FALLBACK_ID
  bar.setAttribute('role', 'banner')
  bar.style.cssText =
    'position:fixed;top:0;left:0;right:0;height:36px;z-index:2147483000;display:flex;justify-content:flex-end;align-items:stretch;-webkit-app-region:drag;user-select:none;'
  bar.innerHTML = [
    `<button type="button" data-act="min" aria-label="最小化" style="${btnCss}">${glyph('<path d="M1 5h8"/>')}</button>`,
    `<button type="button" data-act="max" aria-label="最大化" style="${btnCss}">${glyph('<rect x="1.5" y="1.5" width="7" height="7"/>')}</button>`,
    `<button type="button" data-act="close" aria-label="关闭" style="${btnCss}">${glyph('<path d="M2 2l6 6M8 2L2 8"/>')}</button>`,
  ].join('')
  for (const btn of bar.querySelectorAll('button')) {
    btn.addEventListener('mouseenter', () => {
      const close = btn.dataset.act === 'close'
      btn.style.background = close ? '#c42b1c' : 'rgba(0,0,0,.06)'
      btn.style.color = close ? '#fff' : '#1b1b1f'
    })
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'transparent'
      btn.style.color = '#56565c'
    })
    btn.addEventListener('click', () => {
      if (btn.dataset.act === 'min') ipcRenderer.send('desk:window-minimize')
      else if (btn.dataset.act === 'max') ipcRenderer.send('desk:window-maximize')
      else ipcRenderer.send('desk:window-close')
    })
  }
  document.documentElement.append(bar)
}

function bootChrome() {
  document.documentElement.classList.add('dk-desk-electron')
  if (process.platform === 'win32') installWindowDrag()
  const sync = () => {
    if (document.querySelector('.dk-titlebar')) document.getElementById(FALLBACK_ID)?.remove()
    else installFallback()
  }
  sync()
  new MutationObserver(sync).observe(document.documentElement, { childList: true, subtree: true })
}

function installWindowDrag() {
  // Keep the fallback in the preload, so it also covers the startup title bar and older UI payloads.
  const style = document.createElement('style')
  style.textContent = '.dk-titlebar-main, .dk-titlebar-main *, .dk-brand, .dk-brand *, #dk-shell-fallback, #dk-shell-fallback * { -webkit-app-region: no-drag !important; }'
  document.head.append(style)
  let dragging = null
  const dragTarget = (event) => {
    const element = event.target.closest?.('.dk-titlebar-main, .dk-brand, #dk-shell-fallback')
    return element && !event.target.closest('button, a, input, textarea, select, [role="button"], [contenteditable="true"]') ? element : null
  }
  const end = () => {
    if (!dragging) return
    const { element, pointerId } = dragging
    dragging = null
    ipcRenderer.send('desk:drag-end')
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
  }
  document.addEventListener('pointerdown', (event) => {
    if (!event.isTrusted || event.button !== 0 || !event.isPrimary) return
    const element = dragTarget(event)
    if (!element) return
    event.preventDefault()
    end()
    dragging = { element, pointerId: event.pointerId }
    element.setPointerCapture(event.pointerId)
    ipcRenderer.send('desk:drag-start', { x: event.screenX, y: event.screenY })
  }, true)
  document.addEventListener('dblclick', (event) => {
    if (!event.isTrusted || event.button !== 0 || !dragTarget(event)) return
    event.preventDefault()
    end()
    ipcRenderer.send('desk:window-maximize')
  }, true)
  document.addEventListener('pointermove', (event) => {
    if (!dragging || event.pointerId !== dragging.pointerId) return
    if (!(event.buttons & 1)) return end()
    ipcRenderer.send('desk:drag-move', { x: event.screenX, y: event.screenY })
  }, true)
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(name, end, true)
  window.addEventListener('blur', end)
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootChrome, { once: true })
else bootChrome()
