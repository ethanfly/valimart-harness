import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { build } from 'esbuild'
import { applyEdit, CODE_PATCHES } from '../scripts/kernel/patches.mjs'
import { serveSessionImage } from '../plugins/desk-host/lib/session-image.js'

// Exercise the installed kernel's real Markdown and AssistantNodeView, patched in memory only.
const kernelPackages = path.resolve('node_modules/@deepseek-ai')
const frontend = path.join(kernelPackages, 'dsh-web-frontend/dist/assets')
test.skip(!fs.existsSync(frontend), '需要已安装的 dsh 内核（npm run setup）')
let server, base, tmp, first, second

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-images-browser-'))
  first = path.join(tmp, 'one')
  second = path.join(tmp, 'two')
  fs.mkdirSync(first)
  fs.mkdirSync(second)
  const svg = (width) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="32"><rect width="100%" height="100%" fill="red"/></svg>`
  fs.writeFileSync(path.join(first, '结果 (1).svg'), svg(64))
  // A valid PNG, with the exact output filename and final reply from the reported session.
  fs.writeFileSync(path.join(first, 'beauty-portrait-20260907.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64'))
  fs.writeFileSync(path.join(second, '结果 (1).svg'), svg(128))
  const entry = fs.readdirSync(frontend).find((n) => /^index-.*\.js$/.test(n))
  let boot = fs.readFileSync(path.join(frontend, entry), 'utf8')
  if (!boot.includes('new Bp(lc).run();')) throw new Error('内核浏览器测试锚点已变化')
  boot = boot.replace('new Bp(lc).run();', 'window.testModules=zp();')
  const patch = CODE_PATCHES.find((p) => p.mark === 'company-assistant-markdown-slot-v1')
  let chat = fs.readFileSync(path.join(kernelPackages, 'dsh-client-ui-chat/lib/client.js'), 'utf8')
  if (!chat.includes(patch.mark)) for (const edit of patch.edits) chat = applyEdit(chat, edit)
  chat = chat.replace('exports.apply = apply;', 'exports.apply = apply; exports.TestAssistantNodeView = AssistantNodeView;')
  const bundle = await build({ entryPoints: ['plugins/desk-ui/src/client/markdown.jsx'], bundle: true, write: false, format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'] })
  const component = bundle.outputFiles[0].text
  const harness = `
    const require = (id) => window.testModules[id];
    window.__ModuleLoader__ = { load: ({factory}) => { window.testChat=factory(require); } };
    ${chat}
    const module = {exports:{}}; const exports=module.exports;
    ${component}
    const React = require('react');
    const root = require('react-dom/client').createRoot(document.getElementById('root'));
    window.renderExample = (text, sessionId='one', streaming=false, custom=true) => root.render(React.createElement(window.testChat.TestAssistantNodeView, {
      node: {location:{kind:'root'}, data:{blocks:[{kind:'text',text}], status:streaming?'running':'closed'}},
      useTurnData:()=>undefined, t:(key)=>key,
      renderSlot:(slot,props,options)=>{
        if(slot!=='conversation.assistant.markdown') throw new Error('Wrong slot: '+slot);
        return custom ? React.createElement(module.exports.SessionMarkdown,{...props,sessionId}) : options.fallback;
      }
    }));
  `
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    try {
      if (url.pathname === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(`<div id="root"></div><script type="module" src="/assets/${entry}"></script>`) }
      if (url.pathname === '/harness.js') { res.setHeader('content-type', 'text/javascript; charset=utf-8'); return res.end(harness) }
      if (url.pathname.startsWith('/assets/')) {
        res.setHeader('content-type', 'text/javascript')
        return res.end(url.pathname === `/assets/${entry}` ? boot : fs.readFileSync(path.join(frontend, path.basename(url.pathname))))
      }
      const match = /^\/desk\/api\/sessions\/(one|two)\/image$/.exec(url.pathname)
      if (match) return await serveSessionImage(req, res, { loggedIn: true, session: { header: { cwd: match[1] === 'one' ? first : second } }, source: url.searchParams.get('path') })
      res.writeHead(404); res.end()
    } catch (e) { res.writeHead(e.status ?? 500); res.end(e.message) }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

test('实际内核：本地图片、放大、失败重试、流式回复和会话切换', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(base)
  await page.waitForFunction(() => !!window.testModules)
  await page.addScriptTag({ url: base + '/harness.js' })
  await page.evaluate(() => window.renderExample('# 生成结果\n\n![结果](<结果 (1).svg>)'))
  const img = page.locator('#root img').first()
  await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBe(64)
  await expect(page.locator('h1')).toHaveText('生成结果')
  await img.click()
  await expect(page.locator('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('dialog')).toHaveCount(0)
  await page.evaluate(() => window.renderExample('![结果](<结果 (1).svg>)', 'two', true))
  await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBe(128)
  await page.evaluate(() => window.renderExample('![稍后生成](later.svg)', 'two'))
  await expect(page.getByText('图片加载失败：稍后生成')).toBeVisible()
  fs.copyFileSync(path.join(second, '结果 (1).svg'), path.join(second, 'later.svg'))
  await page.getByRole('button', { name: /重试图片/ }).click()
  await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBe(128)
  await page.evaluate(() => window.renderExample('![越界](../one/结果%20(1).svg)', 'two'))
  await expect(page.getByText('图片加载失败：越界')).toBeVisible()
  // Hosts without desk-ui still use the stock Markdown fallback.
  await page.evaluate(() => window.renderExample('**原生回退**', 'one', false, false))
  await expect(page.locator('strong')).toHaveText('原生回退')
  expect(errors).toEqual([])
})

test('实际内核：截图中的文件名回复和普通图片链接直接预览', async ({ page }) => {
  await page.goto(base)
  await page.waitForFunction(() => !!window.testModules)
  await page.addScriptTag({ url: base + '/harness.js' })
  await page.evaluate(() => window.renderExample('已生成，清新写实风：长发白裙、自然微笑、花园暖阳。\n\n图片文件：`beauty-portrait-20260907.png`\n\n想换成古风、御姐风或动漫风，也可以告诉我。'))
  const img = page.locator('#root img').first()
  await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBe(1)
  await expect(page.locator('code')).toHaveText('beauty-portrait-20260907.png')
  await img.click()
  await expect(page.locator('dialog')).toBeVisible()
  await page.getByRole('button', { name: '关闭图片' }).click()
  await page.evaluate(() => window.renderExample('[下载图片](<结果 (1).svg>)\n\n`结果 (1).svg`'))
  await expect(page.locator('#root img')).toHaveCount(1)
  await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBe(64)
  await page.evaluate(() => window.renderExample('图片文件：结果 (1).svg', 'two', true))
  await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBe(128)
})
