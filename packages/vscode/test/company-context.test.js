import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TokenStore } from '../src/lib/token-store.js'
import { GatewayClient } from '../src/lib/gateway-client.js'
import { SessionController } from '../src/session.js'
import { CompanyContext } from '../src/lib/company-context.js'
import { createWorkspaceTools } from '../src/lib/workspace-fs.js'
import { startCompanyDeskGateway } from './helpers/start-gateway.js'

test('real company gateway: auto context, personal memory persistence, permissions and task binding', async t => {
  const gw = await startCompanyDeskGateway()
  t.after(() => gw.close())
  assert.equal(gw.source, 'createGateway', 'This test requires the real sibling company-harness gateway, not a compatibility stub')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-company-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new TokenStore(path.join(root, 'state'))
  const client = new GatewayClient(store)
  const session = new SessionController({ store, client, getWorkspaceRoot: () => root })
  await session.login({ gatewayUrl: gw.baseUrl, username: 'boss', password: 'boss123456' })
  assert.equal(session.companyContext.state.status, 'ready')
  await session.companyContext.write({ zone: 'shared', path: '02-methods/team-test.md', content: '团队知识：TEAM_CONTEXT_SENTINEL' })
  await session.logout()
  await session.login({ gatewayUrl: gw.baseUrl, username: 'emp-a', password: 'emp123456' })
  assert.match(session.companyContext.context, /TEAM_CONTEXT_SENTINEL/)
  const cc = session.companyContext
  await assert.rejects(cc.write({ zone: 'shared', path: '02-methods/forbidden.md', content: 'no' }), e => e.status === 403)
  assert.throws(() => cc.path('personal', '../boss/private.md'), /越出/)
  await cc.write({ zone: 'personal', path: '05-logs/append.md', content: 'one' })
  await cc.write({ zone: 'personal', path: '05-logs/append.md', content: 'two' })
  assert.equal(await cc.read(cc.path('personal', '05-logs/append.md')), 'onetwo')
  const payloads = []
  client.chatCompletions = async body => {
    payloads.push(body)
    return { choices: [{ message: { content: body.messages[0].content.includes('个人记忆整理器') ? JSON.stringify({ content: '用户明确偏好：测试中使用 MEMORY_SENTINEL 命名。' }) : '已记录命名偏好。' } }] }
  }
  session.setModel('mock-echo')
  await session.send('以后测试请使用 MEMORY_SENTINEL 命名')
  assert.match(payloads[0].messages[0].content, /TEAM_CONTEXT_SENTINEL/)
  assert.ok(payloads[0].tools.some(t => t.function.name === 'company_memory_write'))
  assert.match(cc.state.memory, /已保存/)
  const fresh = new CompanyContext(new GatewayClient(new TokenStore(store.dir)))
  await fresh.refresh()
  assert.match(fresh.context, /MEMORY_SENTINEL/)
  assert.ok(fresh.state.files.some(f => f.path.startsWith('_office/emp-a/_memory/04-reviews/')))
  store.data.autoMemory = false
  const before = payloads.length
  await session.send('不写入新的记忆')
  assert.equal(payloads.length, before + 1, 'disabled auto memory does not make an extraction request')
  const task = (await session.createTask({ title: '绑定上下文', content: 'BOUND_TASK_SENTINEL' })).task
  await session.bindCurrentSession(task.id)
  const tools = cc.tools(createWorkspaceTools({ workspaceRoot: root }), session)
  assert.equal((await tools.execute('company_task_read', {})).task.id, task.id)
  await tools.execute('company_task_log', { text: '完成检索' })
  await tools.execute('company_task_update', { submission: '已接入知识上下文' })
  fs.writeFileSync(path.join(root, 'deliverable.md'), '# 实际交付物')
  const attached = await tools.execute('company_task_attach', { paths: ['deliverable.md'] })
  assert.equal(attached.task.deliverables[0].name, 'deliverable.md')
  await assert.rejects(tools.execute('company_task_attach', { paths: ['../outside.txt'] }), /越出/)
  await session.send('查看当前任务')
  assert.match(payloads.at(-1).messages[0].content, /BOUND_TASK_SENTINEL/)
  session.newSession()
  assert.equal(session.boundTaskId, null)
  await session.logout()
  assert.equal(cc.context, '')
  assert.deepEqual(cc.state.files, [])
})

test('knowledge outage is visible and failed extraction never writes fabricated memory', async () => {
  let writes = 0
  const client = { store: { data: { user: { username: 'alice' } } }, request: async method => { if (method === 'PUT') writes++; throw new Error('offline') }, chatCompletions: async () => ({ choices: [{ message: { content: 'invalid JSON' } }] }) }
  const cc = new CompanyContext(client)
  await cc.refresh()
  assert.equal(cc.state.status, 'error')
  assert.match(cc.state.error, /offline/)
  cc.state.status = 'ready'
  await cc.remember({ prompt: 'p', result: { text: 'r', applied: [] }, model: 'mock', sessionId: 's' })
  assert.match(cc.state.memory, /未保存/)
  assert.equal(writes, 0)
})

test('logout invalidates an in-flight context refresh', async () => {
  let resolveRequest
  const cc = new CompanyContext({ store: { data: { user: { username: 'previous' } } }, request: () => new Promise(resolve => { resolveRequest = resolve }) })
  const loading = cc.refresh()
  cc.reset()
  resolveRequest({ personal: [{ path: '_office/previous/_memory/old.md' }] })
  await loading
  assert.equal(cc.state.status, 'idle')
  assert.deepEqual(cc.state.files, [])
})
