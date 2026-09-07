import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
const { imageInfoUrl, attachImageMenu } = createRequire(import.meta.url)('../../desktop/image-menu.cjs')
const origin = 'http://127.0.0.1:19800'
const image = origin + '/desk/api/sessions/one/image?path=%E5%9B%BE%20(1).png'

test('图片定位只查询本机、同源会话图片端点', () => {
  const info = new URL(imageInfoUrl(image, origin))
  assert.equal(info.searchParams.get('path'), '图 (1).png')
  assert.equal(info.searchParams.get('info'), '1')
  for (const url of ['file:///C:/secret.png', 'https://example.com/a.png', origin + '/other?path=a.png', origin + '/desk/api/sessions/one/image']) assert.equal(imageInfoUrl(url, origin), null)
  assert.equal(imageInfoUrl('https://example.com/desk/api/sessions/one/image?path=a.png', 'https://example.com'), null)
})

test('图片菜单分发复制、定位；页面跳转后不执行，定位失败反馈错误', async () => {
  let listener, items, currentUrl = origin, file = path.resolve('work', '图 (1).png')
  const copied = [], revealed = [], errors = []
  const contents = {
    on: (event, cb) => { assert.equal(event, 'context-menu'); listener = cb },
    isDestroyed: () => false, getURL: () => currentUrl,
    copyImageAt: (...args) => copied.push(args),
    executeJavaScript: async () => file,
  }
  const win = { webContents: contents, isDestroyed: () => false }
  attachImageMenu(win, origin, {
    Menu: { buildFromTemplate: (value) => { items = value; return { popup: () => {} } } },
    shell: { showItemInFolder: (value) => revealed.push(value) },
    dialog: { showMessageBox: async (_win, options) => errors.push(options.message) },
  })
  listener({}, { mediaType: 'image', srcURL: image, hasImageContents: true, x: 20, y: 30 })
  assert.deepEqual(items.map((i) => i.label), ['复制图片', '打开图片文件所在位置'])
  items[0].click()
  assert.deepEqual(copied, [[20, 30]])
  await items[1].click()
  assert.deepEqual(revealed, [file])
  file = 'relative.png'
  await items[1].click()
  assert.equal(errors.length, 1)
  currentUrl = 'https://untrusted.example'
  items[0].click()
  await items[1].click()
  assert.equal(copied.length, 1)
  assert.equal(revealed.length, 1)
})
