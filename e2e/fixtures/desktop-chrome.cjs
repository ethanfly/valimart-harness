const { app, BrowserWindow, Menu, ipcMain } = require('electron')
const path = require('node:path')
const { attachImageMenu } = require('../../desktop/image-menu.cjs')
const { attachWindowDrag } = require('../../desktop/window-drag.cjs')
app.whenReady().then(async () => {
  const url = process.argv.find((arg) => arg.startsWith('http://127.0.0.1:'))
  const win = new BrowserWindow({ show: false, width: 900, height: 700, frame: false, titleBarStyle: 'hidden', webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true, preload: path.resolve(__dirname, '../../desktop/preload.js') } })
  win.setMenu(null)
  ipcMain.handle('desk:window-state', () => ({ maximized: win.isMaximized(), focused: win.isFocused(), inset: 0 }))
  ipcMain.on('desk:window-maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize())
  if (process.platform === 'win32') attachWindowDrag(win, url, { ipcMain })
  global.testWindow = win
  global.actions = { copied: [], revealed: [], errors: [] }
  // Verify native menu/renderer integration without replacing the user's clipboard or opening Explorer.
  win.webContents.copyImageAt = (x, y) => global.actions.copied.push([x, y])
  attachImageMenu(win, url, {
    Menu: { buildFromTemplate: (items) => {
      const menu = Menu.buildFromTemplate(items)
      global.testMenu = menu
      return { popup() {} }
    } },
    shell: { showItemInFolder: (file) => global.actions.revealed.push(file) },
    dialog: { showMessageBox: async (_win, options) => global.actions.errors.push(options.message) },
  })
  await win.loadURL(url)
})
app.on('window-all-closed', () => app.quit())
