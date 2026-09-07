'use strict'
const { sameWebOrigin } = require('./dsh-web-url.cjs')

/** Windows fallback for Electron builds where CSS drag regions never reach native hit testing. */
function attachWindowDrag(win, trustedUrl, { ipcMain }) {
  let drag = null
  const contents = win.webContents
  const allowed = (event) => !win.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame && sameWebOrigin(contents.getURL(), trustedUrl)
  const stop = () => { drag = null }
  const validPoint = (point) => point && ['x', 'y'].every((key) => Number.isFinite(point[key]) && Math.abs(point[key]) <= 100000)
  const start = (event, pointer) => {
    if (!allowed(event) || !validPoint(pointer) || win.isFullScreen()) return
    drag = { pointer, bounds: win.getBounds(), maximized: win.isMaximized() }
  }
  const move = (event, cursor) => {
    if (!allowed(event) || !validPoint(cursor)) return stop()
    if (!drag) return
    // Keep each event's original screen position: IPC can run after the physical cursor has moved on.
    const dx = cursor.x - drag.pointer.x, dy = cursor.y - drag.pointer.y
    if (Math.abs(dx) + Math.abs(dy) < 3) return
    if (drag.restoring) {
      drag.position = { x: Math.round(drag.bounds.x + dx), y: Math.round(drag.bounds.y + dy) }
      return
    }
    if (drag.maximized) {
      const normal = win.getNormalBounds()
      const fraction = Math.max(0, Math.min(1, (drag.pointer.x - drag.bounds.x) / drag.bounds.width))
      const grabY = Math.max(0, Math.min(36, drag.pointer.y - drag.bounds.y))
      const bounds = { ...normal, x: Math.round(cursor.x - normal.width * fraction), y: cursor.y - grabY }
      const restoring = { pointer: cursor, bounds, position: { x: bounds.x, y: bounds.y }, maximized: false, restoring: true }
      drag = restoring
      // Windows restores asynchronously. Moving before this event can cancel the restore.
      win.once('unmaximize', () => {
        restoring.restoring = false
        if (!win.isDestroyed()) win.setPosition(restoring.position.x, restoring.position.y)
      })
      win.unmaximize()
    } else win.setPosition(Math.round(drag.bounds.x + dx), Math.round(drag.bounds.y + dy))
  }
  const end = (event) => {
    if (event.sender !== contents) return
    if (drag?.restoring && win.isMaximized()) win.unmaximize()
    stop()
  }
  ipcMain.on('desk:drag-start', start)
  ipcMain.on('desk:drag-move', move)
  ipcMain.on('desk:drag-end', end)
  win.on('blur', stop)
  contents.on('did-start-navigation', stop)
  win.once('closed', () => {
    stop()
    ipcMain.removeListener('desk:drag-start', start)
    ipcMain.removeListener('desk:drag-move', move)
    ipcMain.removeListener('desk:drag-end', end)
  })
}

module.exports = { attachWindowDrag }
