import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TokenStore } from '../src/lib/token-store.js'
import { parseSlashInput, filterSlashCommands, dispatchSlash, looksLikeSlashCommand, isSlashCommandName } from '../src/lib/slash.js'
import { SessionController } from '../src/session.js'

function controller() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-sl-'))
  const store = new TokenStore(dir)
  store.setLogin({
    gatewayUrl: 'http://127.0.0.1:9',
    sessionToken: 's',
    gatewayToken: 'g',
    user: { username: 'boss', displayName: '老板', role: 'admin' },
    company: {
      defaultModel: 'mock-echo',
      models: [
        { id: 'mock-echo', name: 'Mock Echo' },
        { id: 'mock-reasoner', name: 'Mock Reasoner', reasoningEfforts: { off: null, low: 'low', high: 'high' } },
      ],
    },
    quota: [{ provider: 'mock', label: 'Mock', kind: 'cny', usedCny: 1, limitCny: 100, usedPct: 1, remainingPct: 99, refreshAt: '2099-01-01T00:00:00.000Z' }],
  })
  const session = new SessionController({ store, client: { store }, getWorkspaceRoot: () => dir })
  session.selectedModel = 'mock-echo'
  return { session, dir }
}

test('parseSlashInput and filterSlashCommands', () => {
  assert.equal(parseSlashInput('hello'), null)
  const g = parseSlashInput('/goal file a.txt exists')
  assert.equal(g.command, 'goal')
  assert.equal(g.args, 'file a.txt exists')
  const names = filterSlashCommands('/g').map((c) => c.name)
  assert.ok(names.includes('goal'))
  assert.ok(filterSlashCommands('').some((c) => c.name === 'help'))
})

test('/help lists /goal /model /effort /new /rename /status /sync /drive', () => {
  const { session, dir } = controller()
  const r = session.handleSlash('/help')
  const listed = r.commands.join(' ')
  for (const name of ['/goal', '/model', '/effort', '/new', '/rename', '/status', '/sync', '/drive']) {
    assert.ok(listed.includes(name), `missing ${name}`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

test('/model and /effort change the same selection used on send', () => {
  const { session, dir } = controller()
  const m = dispatchSlash(session, parseSlashInput('/model mock-reasoner'))
  assert.equal(m.model, 'mock-reasoner')
  assert.equal(session.selectedModel, 'mock-reasoner')
  const e = dispatchSlash(session, parseSlashInput('/effort high'))
  assert.equal(e.effort, 'high')
  assert.equal(session.selectedEffort, 'high')
  assert.equal(session.publicState().model, 'mock-reasoner')
  assert.equal(session.publicState().effort, 'high')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('/rename locks the title', () => {
  const { session, dir } = controller()
  const r = session.handleSlash('/rename 登录页改版')
  assert.equal(r.title, '登录页改版')
  assert.equal(session.current().titleLocked, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('/new creates an empty session', () => {
  const { session, dir } = controller()
  const first = session.currentId
  session.current().messages.push({ role: 'user', content: 'old turn' })
  const r = session.handleSlash('/new')
  assert.notEqual(r.sessionId, first)
  assert.equal(session.transcript.length, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('/status returns logged-in user + 额度 fields', () => {
  const { session, dir } = controller()
  const r = session.handleSlash('/status')
  assert.equal(r.user.username, 'boss')
  assert.ok(Array.isArray(r.quota) && r.quota.length > 0)
  const q = r.quota[0]
  assert.ok('remaining' in q || 'remainingPct' in q)
  assert.ok('used' in q || 'usedPct' in q)
  assert.ok('limit' in q)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('/goal condition then /goal clear', () => {
  const { session, dir } = controller()
  const set = session.handleSlash('/goal file goal-done.txt exists')
  assert.equal(set.cleared, false)
  assert.equal(session.goal.condition, 'file goal-done.txt exists')
  const cleared = session.handleSlash('/goal clear')
  assert.equal(cleared.cleared, true)
  assert.equal(session.goal, null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('以 / 开头但不是命令的输入不再报「未知命令」', () => {
  const notCommands = [
    '/src/lib/slash.js 这个文件是干什么的',
    '/api/users 这个接口返回什么',
    '/media 目录里都有啥',
    '// 双斜杠注释',
    '/123',
    '/',
    '/goalx foo',
    '/mod 想切模型',
  ]
  for (const text of notCommands) {
    assert.equal(looksLikeSlashCommand(text), false, `must not be a command: ${text}`)
    const parsed = parseSlashInput(text)
    if (parsed) assert.equal(parsed.known, false, text)
  }
  for (const text of ['/help', '/status', '/Goal clear', '/model mock-echo', '/new', '/effort']) {
    assert.equal(looksLikeSlashCommand(text), true, `must be a command: ${text}`)
  }
  assert.equal(isSlashCommandName('goal'), true)
  assert.equal(isSlashCommandName('nope'), false)
})

test('handleSlash 只吃已知命令，其它返回 null 让 composer 按普通消息发送', () => {
  const { session, dir } = controller()
  assert.equal(session.handleSlash('/src/lib/slash.js 讲一下'), null)
  assert.equal(session.handleSlash('/mod'), null)
  assert.equal(session.handleSlash('//'), null)
  assert.equal(session.handleSlash('/help').command, 'help')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('pushSystemNote 写进当前会话，重绘后仍然可见', () => {
  const { session, dir } = controller()
  session.pushSystemNote('运行中断：agent exceeded 8 turns', { error: true })
  const last = session.transcript[session.transcript.length - 1]
  assert.equal(last.role, 'system')
  assert.equal(last.error, true)
  assert.match(last.content, /运行中断/)
  assert.ok(last.html.includes('运行中断'))
  // system 记录不进入模型上下文
  assert.deepEqual(
    session.historyMessages().map((m) => m.role),
    [],
  )
  fs.rmSync(dir, { recursive: true, force: true })
})
