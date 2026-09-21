import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TokenStore } from '../src/lib/token-store.js'
import { GatewayClient } from '../src/lib/gateway-client.js'
import { SessionController } from '../src/session.js'
import { CompanyContext } from '../src/lib/company-context.js'
import { buildUserContent } from '../src/lib/chat-payload.js'
import { startStubModelServer, startScriptedModelServer, startCompanyDeskGateway } from './helpers/start-gateway.js'

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('SessionController.send uses catalog model id and writes workspace file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ws-'))
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-st-'))
  const rel = 'from-session.txt'
  const contents = 'session-controller-wrote-this'
  const stub = await startStubModelServer({
    toolCall: {
      id: 'call_sess_1',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ path: rel, contents }) },
    },
    thenText: 'session done',
  })
  const store = new TokenStore(stateDir)
  store.setLogin({
    gatewayUrl: stub.baseUrl,
    sessionToken: 'sess',
    gatewayToken: 'dgw',
    user: { username: 'boss' },
    company: { defaultModel: 'mock-echo', models: [{ id: 'mock-echo', name: 'Mock Echo' }] },
  })
  const client = new GatewayClient(store)
  const modelsSeen = []
  const payloads = []
  const inner = client.chatCompletions.bind(client)
  client.chatCompletions = async (body) => {
    modelsSeen.push(body.model)
    payloads.push(body)
    return inner(body)
  }
  const session = new SessionController({
    store,
    client,
    getWorkspaceRoot: () => root,
    getEditorContext: () => ({
      currentFile: path.join(root, 'open.js'),
      selection: 'SELECTION_FROM_EDITOR',
    }),
  })
  const result = await session.send('please write the file')
  assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), contents)
  assert.ok(modelsSeen.length >= 1)
  assert.ok(modelsSeen.every((id) => id === 'mock-echo'))
  const firstUser = payloads[0].messages.find((m) => m.role === 'user')
  const blob = typeof firstUser.content === 'string' ? firstUser.content : JSON.stringify(firstUser.content)
  assert.ok(blob.includes('SELECTION_FROM_EDITOR'))
  assert.equal(result.model, 'mock-echo')
  await stub.close()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('image attach appears in /v1 user-message payload', async () => {
  const content = buildUserContent({ text: 'look', images: [{ dataUrl: TINY_PNG }] })
  assert.ok(Array.isArray(content))
  assert.ok(content.some((p) => p.type === 'image_url' && String(p.image_url.url).includes('iVBORw0KGgo')))

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ws-'))
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-st-'))
  const stub = await startStubModelServer({
    toolCall: {
      id: 'call_img',
      type: 'function',
      function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
    },
    thenText: 'saw the image',
  })
  const store = new TokenStore(stateDir)
  store.setLogin({
    gatewayUrl: stub.baseUrl,
    sessionToken: 'sess',
    gatewayToken: 'dgw',
    user: { username: 'boss' },
    company: { models: [{ id: 'mock-echo' }] },
  })
  const client = new GatewayClient(store)
  const payloads = []
  const inner = client.chatCompletions.bind(client)
  client.chatCompletions = async (body) => {
    payloads.push(body)
    return inner(body)
  }
  const session = new SessionController({ store, client, getWorkspaceRoot: () => root })
  await session.send('describe this', { images: [{ dataUrl: TINY_PNG }] })
  const serialized = JSON.stringify(payloads[0])
  assert.ok(serialized.includes('image_url'))
  assert.ok(serialized.includes('iVBORw0KGgo'))
  await stub.close()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('new session B does not send session A turns to /v1', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ws-'))
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-st-'))
  const stub = await startStubModelServer({
    thenText: 'ok',
    toolCall: {
      id: 'call_list',
      type: 'function',
      function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
    },
  })
  const store = new TokenStore(stateDir)
  store.setLogin({
    gatewayUrl: stub.baseUrl,
    sessionToken: 'sess',
    gatewayToken: 'dgw',
    user: { username: 'boss' },
    company: { models: [{ id: 'mock-echo' }] },
  })
  const client = new GatewayClient(store)
  const payloads = []
  const inner = client.chatCompletions.bind(client)
  client.chatCompletions = async (body) => {
    payloads.push(structuredClone(body))
    return inner(body)
  }
  const session = new SessionController({ store, client, getWorkspaceRoot: () => root })
  const marker = 'ALPHA_UNIQUE_TURN_TEXT_zzz'
  await session.send(marker)
  session.newSession()
  assert.equal(session.transcript.length, 0)
  payloads.length = 0
  await session.send('beta-only')
  const later = JSON.stringify(payloads)
  assert.ok(!later.includes(marker))
  assert.ok(later.includes('beta-only'))
  await stub.close()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('公司知识在 TTL 内复用，不必每条消息都重拉全量', async () => {
  let collections = 0
  const client = {
    store: { data: { user: { username: 'boss' }, sessionToken: 's' } },
    async request(_method, route) {
      if (route.startsWith('/api/knowledge/collections')) {
        collections++
        return { handbook: [{ path: 'h.md', name: 'h.md', mtime: new Date().toISOString() }] }
      }
      if (route.startsWith('/api/knowledge/search')) return { hits: [] }
      return '# handbook body'
    },
  }
  const cc = new CompanyContext(client)
  const first = await cc.prompt('x')
  await cc.prompt('y')
  assert.equal(collections, 1, '第二条消息不该再拉一遍公司资料')
  assert.match(first, /h\.md/)
  await cc.prompt('z', { force: true })
  assert.equal(collections, 2, '手动刷新仍然强制重拉')
})

test('send 会播报阶段事件，转圈不再一脸茫然', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ws-'))
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-st-'))
  const stub = await startScriptedModelServer([{ role: 'assistant', content: '好了' }])
  const store = new TokenStore(stateDir)
  store.setLogin({
    gatewayUrl: stub.baseUrl,
    sessionToken: 'sess',
    gatewayToken: 'dgw',
    user: { username: 'boss' },
    company: { models: [{ id: 'mock-echo' }], defaultModel: 'mock-echo' },
  })
  const session = new SessionController({ store, client: new GatewayClient(store), getWorkspaceRoot: () => root })
  session.store.data.autoMemory = false
  const stages = []
  await session.send('随便聊聊', { onEvent: (ev) => { if (ev.type === 'stage') stages.push(ev.message) } })
  assert.ok(stages.length >= 2, `应有阶段播报：${stages.join(',')}`)
  assert.equal(session.transcript.at(-1).content, '好了')
  await stub.close()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('selected non-default model + 思考强度 land in shipped /v1 body (live gateway)', async () => {
  const gw = await startCompanyDeskGateway()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ws-'))
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-st-'))
  const store = new TokenStore(stateDir)
  const client = new GatewayClient(store)
  const session = new SessionController({ store, client, getWorkspaceRoot: () => root })
  await session.login({
    gatewayUrl: gw.baseUrl,
    username: gw.credentials.username,
    password: gw.credentials.password,
    device: 'test-vscode',
  })
  const models = session.publicState().models
  const def = session.publicState().model
  assert.ok(models.some((m) => m.id === 'mock-reasoner'), 'catalog includes mock-reasoner')
  assert.notEqual(def, 'mock-reasoner')
  session.setModel('mock-reasoner')
  session.setEffort('high')
  const bodies = []
  const inner = client.chatCompletions.bind(client)
  client.chatCompletions = async (body) => {
    bodies.push(body)
    return inner(body)
  }
  await session.send('ping selected model')
  assert.ok(bodies.length >= 1)
  assert.equal(bodies[0].model, 'mock-reasoner')
  assert.equal(bodies[0].reasoning_effort, 'high')
  assert.equal(bodies[0].effort, 'high')
  await gw.close()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('@ 提及：正文只进这一轮请求，transcript 与后续历史保持干净', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-mention-send-'))
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-mention-st-'))
  fs.writeFileSync(path.join(root, 'notes.md'), 'NOTE_BODY_42\n第二行', 'utf8')
  const stub = await startScriptedModelServer([{ role: 'assistant', content: '看完了' }])
  const store = new TokenStore(stateDir)
  store.setLogin({
    gatewayUrl: stub.baseUrl,
    sessionToken: 'sess',
    gatewayToken: 'dgw',
    user: { username: 'boss' },
    company: { defaultModel: 'mock-echo', models: [{ id: 'mock-echo', name: 'Mock Echo' }] },
  })
  const client = new GatewayClient(store)
  const session = new SessionController({ store, client, getWorkspaceRoot: () => root })
  const events = []
  const result = await session.send('@notes.md 讲一下这个文件', { onEvent: (e) => events.push(e) })

  const sent = JSON.stringify(stub.bodies[0].messages)
  assert.match(sent, /NOTE_BODY_42/, '文件正文要随本轮请求内联')
  assert.match(sent, /@notes\.md/)
  assert.match(sent, /不要再对这些路径调用 read_file/)
  assert.equal(result.text, '看完了')
  assert.ok(events.some((e) => e.type === 'stage' && /内联 1 个 @文件/.test(e.message)))

  const userMsg = session.transcript.find((m) => m.role === 'user')
  assert.equal(userMsg.content, '@notes.md 讲一下这个文件', '气泡里只显示用户写的话')
  assert.deepEqual(userMsg.mentions, ['notes.md'])
  assert.ok(!JSON.stringify(userMsg.apiContent).includes('NOTE_BODY_42'), '历史重放不该反复带上文件正文')

  // 第二轮：上一轮的正文不再重放
  await session.send('再说说 @missing.md')
  const second = JSON.stringify(stub.bodies[1].messages)
  assert.ok(!second.includes('NOTE_BODY_42'), '内联内容不进入后续轮次')
  assert.match(second, /未能内联[\s\S]*@missing\.md/, '读不到的提及要说明')

  await stub.close()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('discoverGateways：未登录时把选中的网关记进本地状态，手填地址不覆盖', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-discover-st-'))
  const store = new TokenStore(stateDir)
  const calls = []
  const finder = {
    find: async (opts) => {
      calls.push(opts)
      return {
        gateways: [{ name: 'ValimartHarness', urls: ['http://10.0.0.2:8790', 'http://192.168.1.2:8790'], instanceId: 'id-1' }],
        picked: 'http://10.0.0.2:8790',
        cached: false,
      }
    },
  }
  const session = new SessionController({ store, client: new GatewayClient(store), gatewayFinder: finder })

  const r = await session.discoverGateways({ gatewayUrl: 'http://127.0.0.1:8790' })
  assert.deepEqual(r.gateways, [{
    name: 'ValimartHarness',
    urls: ['http://10.0.0.2:8790', 'http://192.168.1.2:8790'],
    needsSetup: false,
    instanceId: 'id-1',
    source: 'http',
  }])
  assert.equal(r.picked, 'http://10.0.0.2:8790')
  assert.equal(r.lastUrl, 'http://127.0.0.1:8790', '上次用过的地址作为发现起点')
  assert.equal(calls[0].lastUrl, 'http://127.0.0.1:8790')
  assert.equal(store.data.gatewayUrl, 'http://10.0.0.2:8790', '未登录时记下选中地址')
  assert.ok(fs.existsSync(path.join(stateDir, 'desk-state.json')))

  const r2 = await session.discoverGateways({ gatewayUrl: 'http://my-own:8790', keepUrl: true })
  assert.equal(r2.lastUrl, 'http://my-own:8790')
  assert.equal(store.data.gatewayUrl, 'http://10.0.0.2:8790', '手填地址不被覆盖')

  // 已登录时不再改动保存的地址
  store.setLogin({ gatewayUrl: 'http://logged-in:8790', sessionToken: 's', gatewayToken: 'g', user: { username: 'ethan' }, company: {} })
  await session.discoverGateways({ force: true })
  assert.equal(store.data.gatewayUrl, 'http://logged-in:8790')
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('文件改动：assistant 消息带 +N/−M，getFileChange 能拿到 before/after', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-change-ws-'))
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-change-st-'))
  fs.writeFileSync(path.join(root, 'exists.js'), 'const a = 1\n', 'utf8')
  const stub = await startScriptedModelServer([
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'new.txt', contents: 'l1\nl2\n' }) } },
        { id: 'call_w2', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ path: 'exists.js', oldText: 'const a = 1', newText: 'const a = 2' }) } },
      ],
    },
    { role: 'assistant', content: '改完了' },
  ])
  const store = new TokenStore(stateDir)
  store.setLogin({
    gatewayUrl: stub.baseUrl,
    sessionToken: 'sess',
    gatewayToken: 'dgw',
    user: { username: 'boss' },
    company: { defaultModel: 'mock-echo', models: [{ id: 'mock-echo', name: 'Mock Echo' }] },
  })
  const session = new SessionController({ store, client: new GatewayClient(store), getWorkspaceRoot: () => root })

  await session.send('改两个文件')
  const last = session.transcript.at(-1)
  assert.equal(last.role, 'assistant')
  assert.equal(last.content, '改完了')
  assert.deepEqual(
    last.files.slice().sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: 'exists.js', created: false, added: 1, removed: 1, tooLarge: false, hasDiff: true },
      { path: 'new.txt', created: true, added: 2, removed: 0, tooLarge: false, hasDiff: true },
    ],
  )

  const change = session.getFileChange({ path: 'new.txt' })
  assert.equal(change.before, '')
  assert.equal(change.after, 'l1\nl2\n')
  assert.equal(change.created, true)
  assert.equal(change.abs, path.join(root, 'new.txt'))

  const patched = session.getFileChange({ path: 'exists.js' })
  assert.equal(patched.before, 'const a = 1\n')
  assert.equal(patched.after, 'const a = 2\n')
  assert.equal(session.getFileChange({ path: 'nope.txt' }), null, '没改过的文件没有预览')

  // 同一文件再写一次：保留最早 before + 最新 after，diff 展示整轮改动
  await session.send('再改 new.txt')
  const again = session.getFileChange({ path: 'new.txt' })
  assert.equal(again.before, '', '仍是本轮开始前的内容')
  assert.equal(again.after, 'l1\nl2\n', '第二次写的内容一样，after 不变')

  await stub.close()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('setLimits：maxTurns 生效（1 轮后走收尾汇报，不静默停止）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-limit-ws-'))
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-limit-st-'))
  const stub = await startScriptedModelServer([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_loop', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.js' }) } }],
    },
    { role: 'assistant', content: '进度：读完了 a.js，还需要继续。' },
  ])
  fs.writeFileSync(path.join(root, 'a.js'), 'x\n', 'utf8')
  const store = new TokenStore(stateDir)
  store.setLogin({
    gatewayUrl: stub.baseUrl,
    sessionToken: 'sess',
    gatewayToken: 'dgw',
    user: { username: 'boss' },
    company: { defaultModel: 'mock-echo', models: [{ id: 'mock-echo', name: 'Mock Echo' }] },
  })
  const session = new SessionController({ store, client: new GatewayClient(store), getWorkspaceRoot: () => root })
  assert.equal(session.limits.maxTurns, 0, '默认不限制轮次')
  assert.deepEqual(session.setLimits({ maxTurns: 1 }), { maxTurns: 1, maxElapsedMs: 8 * 60_000 })
  await session.send('一直读文件')
  const last = session.transcript.at(-1)
  assert.equal(last.stopReason, 'max_turns')
  assert.match(last.content, /进度：读完了/)
  assert.ok(stub.bodies.length >= 2, '收尾请求也发出去了')
  await stub.close()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('searchMentions 给 @ 面板返回工作区文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-mention-index-'))
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src/session.js'), '1', 'utf8')
  fs.writeFileSync(path.join(root, 'README.md'), '2', 'utf8')
  const session = new SessionController({
    store: new TokenStore(fs.mkdtempSync(path.join(os.tmpdir(), 'vh-mention-st2-'))),
    client: new GatewayClient(new TokenStore(fs.mkdtempSync(path.join(os.tmpdir(), 'vh-mention-st3-')))),
    getWorkspaceRoot: () => root,
  })
  assert.deepEqual(session.searchMentions('sess').paths, ['src/session.js'])
  assert.deepEqual(new Set(session.searchMentions('').paths), new Set(['src/session.js', 'README.md']))
  assert.equal(session.searchMentions('README').root.replaceAll('\\', '/'), root.replaceAll('\\', '/'))
  fs.rmSync(root, { recursive: true, force: true })
})
