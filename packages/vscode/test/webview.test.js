import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import { chromium } from 'playwright'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const task = { id: 'tk-1', title: '新版插件体验优化', content: '支持粘贴图片，修复审核人选择。', status: 'draft', assigneeId: 'me', assignerId: 'director', deliverables: [{ name: '插件验收说明.md' }], assignee: { displayName: '冯一宸' }, assigner: { displayName: '设计总监' } }
const slashCommands = [
  { name: 'goal', usage: '/goal [condition|clear]', description: '设置或清除持久目标；Agent 持续推进直到条件成立' },
  { name: 'model', usage: '/model [id]', description: '查看或切换公司目录模型' },
  { name: 'effort', usage: '/effort [level]', description: '查看或切换思考强度' },
  { name: 'new', usage: '/new', description: '创建新会话' },
  { name: 'rename', usage: '/rename [标题]', description: '重命名当前会话（之后不再被自动标题覆盖）' },
  { name: 'status', usage: '/status', description: '当前登录人员与剩余额度' },
  { name: 'help', usage: '/help', description: '列出斜杠命令' },
]

const state = { loggedIn: true, gatewayUrl: 'http://127.0.0.1:8790', sessionId: 'chat-1', sessions: [{ id: 'chat-1', title: '改进体验' }, { id: 'chat-2', title: '另一条' }], slashCommands, user: { id: 'me', username: 'ethan', displayName: '冯一宸', role: 'admin', department: '技术部' }, models: [{ id: 'grok-4.6', name: 'Grok 4.6' }], model: 'grok-4.6', efforts: ['high', 'xhigh'], effort: 'high', quota: [{ label: 'Grok', remaining: 98, limit: 100, remainingPct: 98 }], transcript: [{ role: 'user', content: '帮我改进插件的使用体验。' }, { role: 'assistant', content: '可以直接在输入框粘贴图片，也可以先选择一张任务卡。' }], tasks: [task], taskDetail: task, peopleStatus: 'ready', people: [{ id: 'me', role: 'admin', displayName: '本人' }, { id: 'director', role: 'director', displayName: '设计团队验收负责人', department: '产品设计部' }, { id: 'emp', role: 'employee', displayName: '员工' }], companyContext: { status: 'ready', loaded: 8, files: Array.from({ length: 8 }), memory: '本轮无新增可复用记忆' } }

async function startMediaServer(t) {
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return }
    if (req.url === '/light.css') { res.setHeader('content-type', 'text/css'); res.end(':root { --bg: #fafafa; --fg: #222; --muted: #666; --input-bg: #fff; --input-fg: #222; --accent: #1676b3; }'); return }
    const file = req.url === '/' ? 'chat.html' : req.url.slice(1)
    if (!['chat.html', 'chat.css', 'chat.js', 'mark.png'].includes(file)) { res.writeHead(404); res.end(); return }
    let content = fs.readFileSync(new URL(`../media/${file}`, import.meta.url))
    if (file === 'chat.html') content = content.toString().replaceAll('{{cspSource}}', "'self'").replaceAll('{{nonce}}', 'testnonce').replaceAll('{{css}}', '/chat.css').replaceAll('{{js}}', '/chat.js').replaceAll('{{mark}}', '/mark.png')
    res.setHeader('content-type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'image/png')
    res.end(content)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

async function openChatPage(t) {
  const url = await startMediaServer(t)
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 320, height: 900 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ postMessage: message => window.sent.push(message) }) })
  await page.goto(url)
  // window.postMessage 的接收是异步任务，而且跑在浏览器进程里；
  // 必须做一次页面往返再断言，否则读到的是还没重绘的 DOM。
  const flush = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))))
  const render = async (s, busy = false) => {
    await page.evaluate(([s, busy]) => window.postMessage({ type: 'state', state: s, busy }, '*'), [s, busy])
    await flush()
  }
  const send = async (m) => {
    await page.evaluate((m) => window.postMessage(m, '*'), m)
    await flush()
  }
  const posted = type => page.evaluate(t => window.sent.filter(m => m.type === t), type)
  const countSent = type => page.evaluate(t => window.sent.filter(m => m.type === t).length, type)
  // 面板的搜索请求有 110ms 防抖：必须等「这一条」真的发出去，不能只看历史上有没有过。
  const waitSentNew = async (type, before) => {
    await page.waitForFunction(([t, n]) => window.sent.filter((m) => m.type === t).length > n, [type, before], { timeout: 5000 })
    return posted(type)
  }
  return { page, errors, render, send, posted, countSent, waitSentNew }
}

test('webview: pasted images, reviewer states, CSP and narrow/light layouts', async t => {
  const { page, errors, render } = await openChatPage(t)
  await render(state)
  await page.locator('#prompt').waitFor({ state: 'visible' })
  await page.locator('#prompt').fill('看看这张图')
  await page.evaluate(png => {
    const data = new DataTransfer()
    data.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], 'pasted.png', { type: 'image/png' }))
    document.getElementById('prompt').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, png)
  await page.locator('.image-chip img').waitFor()
  assert.equal(await page.locator('#prompt').inputValue(), '看看这张图')
  await page.locator('#sendBtn').click()
  const send = await page.evaluate(() => window.sent.find(m => m.type === 'send'))
  assert.equal(send.images[0].dataUrl, `data:image/png;base64,${png}`)
  assert.equal(send.prompt, '看看这张图')
  assert.equal(await page.locator('.image-chip').count(), 0)
  // Plain-text paste must retain native default behavior.
  assert.equal(await page.evaluate(() => {
    const data = new DataTransfer(); data.setData('text/plain', 'hello')
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    document.getElementById('prompt').dispatchEvent(event)
    return event.defaultPrevented
  }), false)
  await page.locator('#imageInput').setInputFiles({ name: 'again.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
  await page.getByRole('button', { name: '移除图片 again.png' }).click()
  assert.equal(await page.locator('.image-chip').count(), 0)
  await page.locator('#tabTasks').click()
  await render(state)
  await page.locator('#reviewerSelect').selectOption('director')
  assert.equal(await page.locator('#reviewerSelect option').count(), 2)
  assert.equal(await page.locator('#taskSubmitBtn').isEnabled(), true)
  await page.locator('#taskSubmitBtn').click()
  assert.equal(await page.evaluate(() => window.sent.find(m => m.type === 'taskSubmit').reviewerId), 'director')
  fs.mkdirSync(new URL('../out/evidence/', import.meta.url), { recursive: true })
  for (const width of [280, 320, 480, 800]) {
    await page.setViewportSize({ width, height: 900 })
    await page.locator('#reviewerSelect').scrollIntoViewIfNeeded()
    const bounds = await page.locator('#reviewerSelect').boundingBox()
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, `reviewer overflow at ${width}`)
    assert.ok(bounds.height >= 32)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: `out/evidence/tasks-${width}.png` })
  }
  await render({ ...state, people: [], peopleStatus: 'ready' })
  await page.waitForFunction(() => document.querySelector('#reviewerSelect').disabled)
  assert.match(await page.locator('#reviewerSelect').textContent(), /暂无其他总监或管理员/)
  assert.equal(await page.locator('#taskSubmitBtn').isEnabled(), false)
  await render({ ...state, people: [], peopleStatus: 'error', peopleError: '无法连接网关' })
  await page.waitForFunction(() => document.querySelector('#reviewerHint').textContent.includes('无法连接'))
  assert.match(await page.locator('#reviewerSelect').textContent(), /加载失败/)
  await render({ ...state, taskDetail: null })
  await page.locator('#taskDetail').waitFor({ state: 'hidden' })
  await page.locator('#tabChat').click()
  await render(state)
  await page.setViewportSize({ width: 320, height: 900 })
  await page.screenshot({ path: 'out/evidence/chat-dark.png' })
  await page.addStyleTag({ url: '/light.css' })
  await page.screenshot({ path: 'out/evidence/chat-light.png' })
  assert.deepEqual(errors, [])
})

test('composer: 以 / 开头的普通文本不再当命令、斜杠面板键盘操作、运行中断留在 transcript', async t => {
  const { page, errors, render, send, posted } = await openChatPage(t)
  await render(state)
  await page.locator('#prompt').waitFor({ state: 'visible' })

  // 1) / 开头但不是命令：面板给出说明，输入原样作为普通消息发出
  await page.locator('#prompt').fill('/src/lib/session.js 讲一下这个文件')
  await page.locator('.slash-hint').waitFor()
  assert.match(await page.locator('.slash-hint').textContent(), /不是斜杠命令，将作为普通消息发送/)
  await page.locator('#sendBtn').click()
  const sends = await posted('send')
  assert.equal(sends.at(-1).prompt, '/src/lib/session.js 讲一下这个文件')
  assert.deepEqual(await posted('slash'), [], 'webview 不再区分 slash 消息类型')

  // 2) 键盘：↓ 选择 + Enter 补全，不会顺手把消息发出去
  await page.locator('#prompt').fill('/mo')
  await page.locator('.slash-item').first().waitFor()
  const sentBefore = (await posted('send')).length
  await page.locator('#prompt').press('ArrowDown')
  await page.locator('#prompt').press('Enter')
  assert.equal(await page.locator('#prompt').inputValue(), '/model ')
  assert.equal((await posted('send')).length, sentBefore)

  // 3) 已带参数的已知命令显示用法，而不是「没有命令」
  await page.locator('#prompt').fill('/model grok-4.6')
  await page.locator('.slash-hint').waitFor()
  assert.match(await page.locator('.slash-hint').textContent(), /\/model \[id\]/)
  await page.locator('#prompt').press('Escape')
  assert.equal(await page.locator('#slashPalette').isHidden(), true)

  // 4) 转圈时说明卡在哪一步、第几轮
  await render(state, true)
  assert.equal(await page.locator('#thinking').isVisible(), true)
  await send({ type: 'event', event: { type: 'stage', message: '正在载入公司知识' } })
  assert.equal(await page.locator('.thinking-label').textContent(), '正在载入公司知识')
  await send({ type: 'event', event: { type: 'request', turn: 2, turnCount: 3, maxTurns: 0 } })
  assert.equal(await page.locator('.thinking-label').textContent(), '模型思考中 · 第 3 轮')

  // 5) 运行中断：host 已写进 transcript，webview 不再重复贴一条被重绘抹掉
  await send({ type: 'error', message: '运行中断：等待响应超时', inTranscript: true })
  assert.equal(await page.locator('.msg.err').count(), 0)
  await render({ ...state, transcript: [...state.transcript, { role: 'system', content: '运行中断：等待响应超时', error: true }] }, false)
  assert.equal(await page.locator('.msg.err').count(), 1)
  assert.match(await page.locator('.msg.err').textContent(), /运行中断/)
  assert.equal(await page.locator('#thinking').isVisible(), false)

  // 6) 非 transcript 的提示仍然立刻可见
  await send({ type: 'error', message: '额度已用尽，明天刷新' })
  assert.match(await page.locator('#transcript').textContent(), /额度已用尽/)
  await page.screenshot({ path: 'out/evidence/composer-slash-hint.png' })
  assert.deepEqual(errors, [])
})

test('composer: @ 文件补全走宿主索引；图片与发送按钮尺寸一致', async t => {
  const { page, errors, render, send, posted, countSent, waitSentNew } = await openChatPage(t)
  await render(state)
  await page.locator('#prompt').waitFor({ state: 'visible' })

  // 1) 光标停在 @token 上 → 向宿主要工作区候选
  const beforeSearch = await countSent('mention-search')
  await page.locator('#prompt').fill('看下 @src/li')
  const requests = await waitSentNew('mention-search', beforeSearch)
  assert.equal(requests.at(-1).query, 'src/li')
  assert.ok(Number.isInteger(requests.at(-1).requestId))
  assert.deepEqual(await posted('send'), [], '补全期间不发消息')

  // 2) 宿主回结果 → 面板列出目录/文件名
  await send({ type: 'mention-result', requestId: requests.at(-1).requestId, root: 'E:/repo', paths: ['src/lib/slash.js', 'src/lib/session.js'] })
  const items = page.locator('.mention-item')
  await items.first().waitFor()
  assert.equal(await items.count(), 2)
  assert.equal((await items.first().textContent()).replace(/\s+/g, ''), 'src/lib/slash.js')
  await page.screenshot({ path: 'out/evidence/mention-palette.png' })

  // 3) Enter 只插入 @路径，不收口就发送；插入后原样带进 send 载荷
  await page.locator('#prompt').press('Enter')
  assert.equal(await page.locator('#prompt').inputValue(), '看下 @src/lib/slash.js ')
  assert.equal(await page.locator('#slashPalette').isHidden(), true)
  await page.locator('#sendBtn').click()
  assert.equal((await posted('send')).at(-1).prompt, '看下 @src/lib/slash.js')

  // 4) 迟到的旧结果不能盖掉当前面板
  const beforeSecond = await countSent('mention-search')
  await page.locator('#prompt').fill('再 @media')
  const latest = (await waitSentNew('mention-search', beforeSecond)).at(-1)
  await send({ type: 'mention-result', requestId: latest.requestId - 1, root: 'E:/repo', paths: ['stale/old.js'] })
  await send({ type: 'mention-result', requestId: latest.requestId, root: 'E:/repo', paths: ['media/chat.css'] })
  assert.equal((await page.locator('.mention-item').textContent()).replace(/\s+/g, ''), 'media/chat.css')

  // 5) 没打开工作区时给中文提示，而不是空面板
  const beforeThird = await countSent('mention-search')
  await page.locator('#prompt').fill('@read')
  const noRoot = (await waitSentNew('mention-search', beforeThird)).at(-1)
  await send({ type: 'mention-result', requestId: noRoot.requestId, root: null, paths: [] })
  await page.locator('.slash-hint').waitFor()
  assert.match(await page.locator('.slash-hint').textContent(), /先打开一个工作区文件夹/)

  // 6) 图片按钮与发送按钮：同尺寸同基线；窄栏里选择器换行但按钮不溢出
  await page.setViewportSize({ width: 420, height: 900 })
  await render(state)
  await page.locator('#prompt').press('Escape')
  const boxes = await page.evaluate(() => {
    const pick = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) } }
    return { attach: pick('attachBtn'), send: pick('sendBtn'), selects: [pick('modelSelect'), pick('effortSelect')] }
  })
  assert.deepEqual(boxes.attach, boxes.send, '两个动作按钮必须一模一样大')
  assert.ok(boxes.attach.w >= 28 && boxes.attach.w <= 40, `按钮尺寸异常：${boxes.attach.w}`)
  assert.equal(boxes.selects[0].h, boxes.attach.h, '选择器与按钮同高，一行对齐')
  assert.equal(boxes.selects[0].top, boxes.attach.top, '同一基线')
  assert.equal(boxes.selects[1].top, boxes.attach.top, '两个选择器也在同一行')
  await page.screenshot({ path: 'out/evidence/composer-buttons.png' })

  for (const width of [280, 320, 480]) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))
    await render(state)
    const row = await page.evaluate(() => {
      const bar = document.getElementById('composer').querySelector('.composer-bar').getBoundingClientRect()
      const actions = document.querySelector('.composer-actions').getBoundingClientRect()
      const selects = document.querySelector('.composer-selects').getBoundingClientRect()
      const attach = document.getElementById('attachBtn').getBoundingClientRect()
      const send = document.getElementById('sendBtn').getBoundingClientRect()
      return {
        fitsRight: actions.right <= bar.right + 1,
        sameSize: Math.round(attach.width) === Math.round(send.width) && Math.round(attach.height) === Math.round(send.height),
        noOverlap: selects.right <= attach.left + 1 || selects.top >= attach.bottom || attach.top >= selects.bottom,
        w: Math.round(actions.width),
      }
    })
    assert.ok(row.fitsRight, `${width}px 下动作按钮溢出`)
    assert.ok(row.sameSize, `${width}px 下两个按钮尺寸不一致`)
    assert.ok(row.noOverlap, `${width}px 下选择器压住了按钮`)
    assert.ok(row.w > 0)
    await page.screenshot({ path: `out/evidence/composer-${width}.png` })
  }
  // 7) 气泡下方标出这条消息到底内联了哪些文件
  await render({
    ...state,
    transcript: [
      { role: 'user', content: '看下 @src/lib/slash.js', mentions: ['src/lib/slash.js'] },
      { role: 'assistant', content: '好的' },
    ],
  })
  assert.equal(await page.locator('.mention-tag').textContent(), '@src/lib/slash.js')
  assert.match(await page.locator('.msg.user').textContent(), /看下 @src\/lib\/slash\.js/, '气泡正文仍是用户原话')
  assert.deepEqual(errors, [])
})

test('改动预览：改动卡片与工具文件名都能点开 VS Code diff', async t => {
  const { page, errors, render, send, posted } = await openChatPage(t)
  await render({
    ...state,
    transcript: [
      { role: 'user', content: '改一下' },
      {
        role: 'assistant',
        content: '改好了',
        files: [
          { path: 'src/a.js', added: 3, removed: 1, created: false, hasDiff: true, tooLarge: false },
          { path: 'src/new.js', added: 12, removed: 0, created: true, hasDiff: true, tooLarge: false },
          { path: 'src/huge.js', added: 0, removed: 0, created: false, hasDiff: false, tooLarge: true },
        ],
      },
    ],
  })
  const cards = page.locator('.file-change')
  assert.equal(await cards.count(), 3)
  assert.match(await cards.first().textContent(), /src\/a\.js/)
  assert.match(await cards.first().textContent(), /\+3/)
  assert.match(await cards.first().textContent(), /−1/)
  assert.match(await cards.nth(1).textContent(), /新建/)
  assert.match(await cards.nth(2).textContent(), /文件较大/)
  await page.screenshot({ path: 'out/evidence/file-changes.png' })

  await cards.first().click()
  const fromCard = (await posted('openChange')).at(-1)
  assert.equal(fromCard.path, 'src/a.js')
  assert.equal(fromCard.mode, 'diff')

  // 工具消息：连续调用叠成紧凑 chip，写入类点开 diff，读取类只打开文件
  await send({ type: 'event', event: { type: 'tool-start', name: 'write_file', args: { path: 'src/b.js' } } })
  assert.equal(await page.locator('.tool-chip.pending').count(), 1)
  await send({ type: 'event', event: { type: 'tool', name: 'write_file', args: { path: 'src/b.js' }, result: { path: 'src/b.js', bytes: 3 } } })
  await send({ type: 'event', event: { type: 'tool', name: 'read_file', args: { path: 'src/c.js' }, result: { path: 'src/c.js', contents: 'x' } } })
  assert.equal(await page.locator('.tool-stack').count(), 1)
  assert.equal(await page.locator('.tool-chip').count(), 2)
  assert.equal(await page.locator('.msg.tool').count(), 0)
  const links = page.locator('.tool-chip .file-link')
  assert.equal(await links.count(), 2)
  await links.first().click()
  assert.equal((await posted('openChange')).at(-1).mode, 'diff')
  await links.nth(1).click()
  assert.equal((await posted('openChange')).at(-1).mode, 'file')

  // 没有工作区时给中文提示
  await send({ type: 'openChange-result', ok: false, reason: 'no-root' })
  assert.match(await page.locator('.msg.system').last().textContent(), /没有打开工作区文件夹/)
  assert.deepEqual(errors, [])
})

test('登录页：自动搜索局域网网关、可切换、手填地址不被覆盖', async t => {
  const { page, errors, render, send, posted, countSent, waitSentNew } = await openChatPage(t)

  // 1) 登录页一出现就自动找（和桌面客户端一致）
  await render({ ...state, loggedIn: false, transcript: [] })
  const first = await waitSentNew('discover', 0)
  assert.equal(first.at(-1).keepUrl, false)
  assert.equal(first.at(-1).force, false)
  assert.ok(Number.isInteger(first.at(-1).requestId))
  assert.equal(first.at(-1).gatewayUrl, 'http://127.0.0.1:8790', '把上次用过的地址当起点')
  assert.match(await page.locator('#gatewayNote').textContent(), /正在寻找本机网关/)

  // 2) 宿主回两台网关 → 备注 + 列表 + 自动回填选中地址
  await send({
    type: 'discover-result',
    requestId: first.at(-1).requestId,
    picked: 'http://10.0.0.2:8790',
    gateways: [
      { name: 'ValimartHarness', urls: ['http://10.0.0.2:8790', 'http://192.168.1.2:8790'] },
      { name: '备用网关', urls: ['http://10.0.0.3:8790'] },
    ],
  })
  assert.equal(await page.locator('#gatewayUrl').inputValue(), 'http://10.0.0.2:8790')
  assert.match(await page.locator('#gatewayNote').textContent(), /找到 2 台网关/)
  assert.equal(await page.locator('.finder-item').count(), 2)
  assert.equal((await page.locator('.finder-item').first().textContent()).includes('ValimartHarness'), true)
  assert.match(await page.locator('.finder-item').first().textContent(), /另有 1 个地址/)
  assert.equal(await page.locator('.finder-item.on').count(), 1, '当前选中的那台高亮')
  await page.screenshot({ path: 'out/evidence/gateway-finder.png' })

  // 3) 点另一台 → 地址跟着换
  await page.locator('.finder-item').nth(1).click()
  assert.equal(await page.locator('#gatewayUrl').inputValue(), 'http://10.0.0.3:8790')
  assert.equal(await page.locator('.finder-item.on').textContent().then((t) => t.includes('备用网关')), true)

  // 4) 手填过地址后，「自动搜索」带回的结果不再覆盖输入框
  await page.locator('#gatewayUrl').fill('http://my-own:8790')
  const before = await countSent('discover')
  await page.locator('#gatewayFindBtn').click()
  const again = await waitSentNew('discover', before)
  assert.equal(again.at(-1).force, true)
  assert.equal(again.at(-1).keepUrl, true)
  assert.equal(again.at(-1).gatewayUrl, 'http://my-own:8790')
  await send({ type: 'discover-result', requestId: again.at(-1).requestId, picked: 'http://10.0.0.2:8790', gateways: [] })
  assert.equal(await page.locator('#gatewayUrl').inputValue(), 'http://my-own:8790', '手填地址不被覆盖')
  assert.match(await page.locator('#gatewayNote').textContent(), /都没找到网关/)

  // 5) 宿主报错时给中文提示，不弹全局错误条
  const beforeErr = await countSent('discover')
  await page.locator('#gatewayFindBtn').click()
  const failed = await waitSentNew('discover', beforeErr)
  await send({ type: 'discover-result', requestId: failed.at(-1).requestId, gateways: [], picked: '', error: '网络不可用' })
  assert.match(await page.locator('#gatewayNote').textContent(), /寻找网关失败：网络不可用/)
  assert.equal(await page.locator('#loginError').textContent(), '', '登录错误行不该被网关发现占用')
  assert.deepEqual(errors, [])
})

test('工作台：会话切换 / 停止 / 流式气泡 / 思考折叠 / 文件引用', async t => {
  const { page, errors, render, send, posted } = await openChatPage(t)
  await render(state)
  assert.equal(await page.locator('#sessionSelect option').count(), 2)
  assert.equal(await page.locator('#sessionSelect').inputValue(), 'chat-1')
  await page.locator('#sessionSelect').selectOption('chat-2')
  assert.equal((await posted('switchSession')).at(-1).id, 'chat-2')

  await page.locator('#detachBtn').click()
  assert.equal((await posted('openEditor')).length, 1)

  await page.locator('#prompt').fill('直接回车发送')
  const sentBeforeEnter = (await posted('send')).length
  await page.locator('#prompt').press('Enter')
  assert.equal((await posted('send')).length, sentBeforeEnter + 1)
  assert.equal((await posted('send')).at(-1).prompt, '直接回车发送')
  await page.locator('#prompt').fill('换行')
  await page.locator('#prompt').press('Control+Enter')
  assert.match(await page.locator('#prompt').inputValue(), /换行\n/)
  assert.equal((await posted('send')).length, sentBeforeEnter + 1)

  await render(state, true)
  assert.equal(await page.locator('#stopBtn').isVisible(), true)
  await page.locator('#stopBtn').click()
  assert.equal((await posted('cancel')).length, 1)

  await render({
    ...state,
    transcript: [
      { role: 'user', content: '改 src/lib/session.js' },
    ],
  }, true)
  await send({ type: 'event', event: { type: 'delta', text: '正在改', reasoning: '先读文件' } })
  assert.match(await page.locator('.msg.live').textContent(), /正在改/)
  assert.match(await page.locator('.process .reasoning').textContent(), /先读文件/)

  await render({
    ...state,
    transcript: [
      { role: 'user', content: '改完了' },
      {
        role: 'assistant',
        content: '看 src/lib/session.js:12',
        html: '<p>看 <button type="button" class="file-ref" data-path="src/lib/session.js" data-line="12">src/lib/session.js:12</button></p>',
        reasoning: '逐步推理',
        tools: [{ name: 'read_file', count: 1 }],
        stopReason: 'stop',
      },
    ],
  })
  assert.match(await page.locator('.process').textContent(), /工具 read_file/)
  await page.locator('.file-ref').click()
  const opened = (await posted('openChange')).at(-1)
  assert.equal(opened.path, 'src/lib/session.js')
  assert.equal(opened.mode, 'file')
  assert.equal(opened.line, '12')
  await page.screenshot({ path: 'out/evidence/workbench-sessions.png' })
  assert.deepEqual(errors, [])
})
