'use strict'
const path = require('node:path')

function imageInfoUrl(source, pageUrl) {
  try {
    const page = new URL(pageUrl)
    const image = new URL(source)
    if (!['http:', 'https:'].includes(page.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(page.hostname)) return null
    if (image.origin !== page.origin || !/^\/desk\/api\/sessions\/[^/]+\/image$/.test(image.pathname) || !image.searchParams.get('path')) return null
    image.searchParams.set('info', '1')
    return image.href
  } catch { return null }
}

/** Use Chromium's decoded image, so copy works for SVG/JPEG too and keeps full resolution. */
function attachImageMenu(win, trustedUrl, { Menu, shell, dialog }) {
  const contents = win.webContents
  contents.on('context-menu', (_event, params) => {
    if (params.mediaType !== 'image') return
    const stillTrusted = () => {
      try { return !contents.isDestroyed() && new URL(contents.getURL()).origin === new URL(trustedUrl).origin } catch { return false }
    }
    if (!stillTrusted()) return
    const infoUrl = imageInfoUrl(params.srcURL, trustedUrl)
    const items = [{
      label: '复制图片', enabled: params.hasImageContents,
      click: () => { if (stillTrusted()) contents.copyImageAt(params.x, params.y) },
    }]
    if (infoUrl) items.push({
      label: '打开图片文件所在位置',
      click: async () => {
        try {
          if (!stillTrusted()) return
          // Fetch in the authenticated page: the host checks login, workspace containment and image bytes.
          const file = await contents.executeJavaScript(`(async () => {
            const response = await fetch(${JSON.stringify(infoUrl)}, { credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw new Error('图片不存在、不可访问或登录已失效');
            return (await response.json()).file;
          })()`)
          if (!stillTrusted()) return
          if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('未取得有效的图片文件地址')
          shell.showItemInFolder(file)
        } catch (error) {
          if (!win.isDestroyed()) await dialog.showMessageBox(win, { type: 'error', title: '无法打开图片位置', message: error.message, buttons: ['确定'] })
        }
      },
    })
    else if (/^https?:\/\//i.test(params.srcURL)) items.push({
      label: '打开图片地址',
      click: () => { if (stillTrusted()) shell.openExternal(params.srcURL).catch(() => {}) },
    })
    Menu.buildFromTemplate(items).popup({ window: win })
  })
}

module.exports = { attachImageMenu, imageInfoUrl }
