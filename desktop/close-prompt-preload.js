'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('closePrompt', {
  choose: (action, remember) => ipcRenderer.send('desk:close-prompt', { action, remember: Boolean(remember) }),
})
