import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TokenStore } from '../src/lib/token-store.js'
import { GatewayClient, GatewayError } from '../src/lib/gateway-client.js'
import { TaskClient, TASK_QUAD, TASK_OVERVIEW_FIELDS } from '../src/lib/tasks.js'
import { startCompanyDeskGateway } from './helpers/start-gateway.js'

let gw

before(async () => {
  gw = await startCompanyDeskGateway()
})

after(async () => {
  await gw.close()
})

function clientFor(username, password) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-tk-'))
  const store = new TokenStore(dir)
  const client = new GatewayClient(store)
  const tasks = new TaskClient(client)
  return { dir, store, client, tasks, login: () => client.login({ gatewayUrl: gw.baseUrl, username, password, device: 'test-task' }) }
}

test('任务卡: create, list, patch, deliverable, bind, submit/review/final', async () => {
  const emp = clientFor('emp-a', 'emp123456')
  const dir = clientFor('director', 'director123')
  const boss = clientFor('boss', 'boss123456')
  await emp.login()
  await dir.login()
  await boss.login()

  const created = await emp.tasks.create({ title: 'vscode 任务卡', content: '任务内容正文' })
  assert.equal(created.task.status, 'draft')
  const id = created.task.id

  const listed = await emp.tasks.list()
  assert.ok(listed.tasks.some((t) => t.id === id))

  const patched = await emp.tasks.update(id, { content: '更新后的任务内容', submission: '提交内容草稿' })
  assert.equal(patched.task.content, '更新后的任务内容')
  assert.equal(patched.task.submission, '提交内容草稿')

  await emp.tasks.bindSession(id, { sessionId: 'chat-test-bind', title: '会话 A' })

  await assert.rejects(() => emp.tasks.submit(id, { reviewerId: dir.store.data.user.id }), (err) => {
    assert.ok(err instanceof GatewayError)
    assert.notEqual(err.status, 200)
    assert.equal(err.code, 'no_deliverables')
    return true
  })

  const files = await emp.tasks.addDeliverables(id, [
    { name: 'done.txt', dataBase64: Buffer.from('交付物').toString('base64') },
  ])
  assert.ok(files.task.deliverables.length >= 1)

  const submitted = await emp.tasks.submit(id, { reviewerId: dir.store.data.user.id })
  assert.equal(submitted.task.status, 'pending_review')
  assert.equal(submitted.task.statusLabel, '待审')

  const reviewed = await dir.tasks.review(id, { decision: 'pass', comment: '结构对' })
  assert.equal(reviewed.task.status, 'pending_final')
  assert.equal(reviewed.task.statusLabel, '待终审')

  const finalized = await boss.tasks.final(id, { decision: 'pass', comment: '通过' })
  assert.equal(finalized.task.status, 'approved')
  assert.equal(finalized.task.statusLabel, '通过')

  assert.deepEqual(TASK_QUAD, ['提交验收', '待审', '待终审', '通过/驳回'])
  assert.ok(TASK_OVERVIEW_FIELDS.includes('提交信息'))
  assert.ok(TASK_OVERVIEW_FIELDS.includes('任务内容'))
  assert.ok(TASK_OVERVIEW_FIELDS.includes('提交内容'))
  assert.ok(TASK_OVERVIEW_FIELDS.includes('交付物'))

  fs.rmSync(emp.dir, { recursive: true, force: true })
  fs.rmSync(dir.dir, { recursive: true, force: true })
  fs.rmSync(boss.dir, { recursive: true, force: true })
})
