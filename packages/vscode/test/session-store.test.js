import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TokenStore } from '../src/lib/token-store.js'
import { GatewayClient } from '../src/lib/gateway-client.js'
import { SessionController } from '../src/session.js'
import { ChatStore } from '../src/lib/chat-store.js'
import { autoSessionTitle, shouldAutoTitle, DEFAULT_SESSION_TITLE } from '../src/lib/session-title.js'
import { startScriptedModelServer } from './helpers/start-gateway.js'

test('autoSessionTitle 去掉 markdown 并截断', () => {
  assert.equal(autoSessionTitle('  # Hello **world**  '), 'Hello world')
  assert.equal(autoSessionTitle('a'.repeat(80)).endsWith('…'), true)
  assert.equal(autoSessionTitle('```js\ncode\n```\nfix login'), 'fix login')
  assert.equal(autoSessionTitle('see [docs](https://example.com) please'), 'see docs please')
  assert.equal(shouldAutoTitle({ title: DEFAULT_SESSION_TITLE, titleLocked: false }), true)
  assert.equal(shouldAutoTitle({ title: '手动', titleLocked: true }), false)
})

test('会话落盘：重登同一账号能切回历史；换账号互不影响', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-chats-'))
  const store = new TokenStore(stateDir)
  store.setLogin({
    gatewayUrl: 'http://127.0.0.1:9',
    sessionToken: 's',
    gatewayToken: 'g',
    user: { username: 'ethan' },
    company: { models: [{ id: 'mock-echo' }] },
  })
  const session = new SessionController({ store, client: new GatewayClient(store) })
  session.current().messages.push({ role: 'user', content: '第一轮' })
  session.current().title = '第一轮'
  session.persistChats()
  const other = session.newSession()
  session.renameSession(other.id, '第二轮')

  const again = new SessionController({ store, client: new GatewayClient(store) })
  assert.equal(again.chats.length, 2)
  assert.equal(again.current().title, '第二轮')
  assert.equal(again.current().titleLocked, true)
  assert.ok(again.chats.some((c) => c.messages.some((m) => m.content === '第一轮')))

  store.setLogin({
    gatewayUrl: 'http://127.0.0.1:9',
    sessionToken: 's2',
    gatewayToken: 'g2',
    user: { username: 'other' },
    company: { models: [{ id: 'mock-echo' }] },
  })
  const stranger = new SessionController({ store, client: new GatewayClient(store) })
  assert.equal(stranger.chats.length, 1)
  assert.equal(stranger.current().title, DEFAULT_SESSION_TITLE)
  assert.equal(stranger.transcript.length, 0)

  const disk = JSON.parse(fs.readFileSync(path.join(stateDir, 'chats.json'), 'utf8'))
  assert.ok(disk.byUser.ethan.chats.length >= 2)
  assert.ok(!JSON.stringify(disk).includes('sessionToken'))
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('删除最后一个会话会清空而不是把列表删光；切换不串历史', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-chats2-'))
  const store = new TokenStore(stateDir)
  store.setLogin({
    gatewayUrl: 'http://127.0.0.1:9',
    sessionToken: 's',
    gatewayToken: 'g',
    user: { username: 'ethan' },
    company: {},
  })
  const session = new SessionController({ store, client: new GatewayClient(store) })
  const a = session.currentId
  session.current().messages.push({ role: 'user', content: 'A' })
  const b = session.newSession()
  session.current().messages.push({ role: 'user', content: 'B' })
  session.switchSession(a)
  assert.equal(session.transcript[0].content, 'A')
  session.deleteSession(b.id)
  assert.equal(session.chats.length, 1)
  session.deleteSession(session.currentId)
  assert.equal(session.chats.length, 1)
  assert.equal(session.transcript.length, 0)
  assert.equal(session.current().title, DEFAULT_SESSION_TITLE)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('send 自动标题只发生一次；手动重命名后不再覆盖', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-title-ws-'))
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-title-st-'))
  const stub = await startScriptedModelServer([{ role: 'assistant', content: '好' }])
  const store = new TokenStore(stateDir)
  store.setLogin({
    gatewayUrl: stub.baseUrl,
    sessionToken: 'sess',
    gatewayToken: 'dgw',
    user: { username: 'boss' },
    company: { defaultModel: 'mock-echo', models: [{ id: 'mock-echo' }] },
  })
  const session = new SessionController({ store, client: new GatewayClient(store), getWorkspaceRoot: () => root })
  session.store.data.autoMemory = false
  await session.send('请帮我改登录页')
  assert.equal(session.current().title, '请帮我改登录页')
  session.renameSession(session.currentId, '登录页')
  await session.send('再改一下按钮')
  assert.equal(session.current().title, '登录页')
  await stub.close()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('ChatStore 不把图片 dataUrl 写进磁盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-img-'))
  const cs = new ChatStore(dir)
  cs.save('ethan', {
    currentId: 'chat-1',
    chats: [{
      id: 'chat-1',
      title: '图',
      messages: [{ role: 'user', content: '看图', images: [{ name: 'a.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }] }],
    }],
  })
  const raw = fs.readFileSync(path.join(dir, 'chats.json'), 'utf8')
  assert.ok(!raw.includes('data:image'))
  assert.match(raw, /omitted/)
  fs.rmSync(dir, { recursive: true, force: true })
})
