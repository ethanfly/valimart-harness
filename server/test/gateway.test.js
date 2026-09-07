/**
 * 网关端到端测试（node --test）：使用临时数据目录 + Mock 上游，不依赖网络。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createGateway } from '../src/index.js'

let gw
let base
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-gateway-test-'))

before(async () => {
  gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: tmp,
    upstreams: { mock: { kind: 'mock', label: 'Mock', models: [{ id: 'mock-echo', name: 'Mock Echo', priceCnyPerM: { input: 1, output: 2, cachedInput: 0.1 } }] } },
    channels: [
      { id: 'grok', label: 'Grok', kind: 'subscription', baseUrl: 'https://api.x.ai/v1', hint: 'grok-4.6, grok-4.6-fast', reasoningEfforts: ['low', 'high'] },
      { id: 'mock', label: 'Mock', kind: 'key', baseUrl: 'mock://', hint: 'mock-echo' },
    ],
    defaultModel: 'mock-echo',
    quickInference: { defaultModel: 'mock-echo' },
    quota: { anchor: '2026-08-31T17:45:21+08:00', weeklyCny: 100, byRole: { admin: 1000, director: 500, employee: 100 } },
    fetchReleases: async () => [],
    fetchModels: async () => new Response(JSON.stringify({ error: 'no' }), { status: 404 }),
  })
  base = await gw.listen()
})

after(async () => {
  await gw.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function api(method, p, { token, body, raw } = {}) {
  const r = await fetch(base + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  })
  const text = await r.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { text }
  }
  return { status: r.status, json }
}

const ctx = {}

test('登录：种子管理员 + 演示账号，签发登录令牌与网关令牌', async () => {
  const boss = await api('POST', '/api/auth/login', { body: { username: 'boss', password: 'boss123456', device: 'test' } })
  assert.equal(boss.status, 200)
  assert.equal(boss.json.user.role, 'admin')
  assert.ok(boss.json.sessionToken)
  assert.ok(boss.json.gatewayToken.startsWith('dgw_'))
  assert.ok(boss.json.company.models.some((m) => m.id === 'mock-echo'))
  ctx.boss = boss.json

  const emp = await api('POST', '/api/auth/login', { body: { username: 'emp-a', password: 'emp123456', device: 'test' } })
  assert.equal(emp.status, 200)
  ctx.emp = emp.json
  const dir = await api('POST', '/api/auth/login', { body: { username: 'director', password: 'director123', device: 'test' } })
  assert.equal(dir.status, 200)
  ctx.dir = dir.json

  const bad = await api('POST', '/api/auth/login', { body: { username: 'emp-a', password: 'wrong' } })
  assert.equal(bad.status, 401)
})

test('模型代理：/v1/models 与 /v1/chat/completions（流式）并按人记账', async () => {
  const models = await api('GET', '/v1/models', { token: ctx.emp.gatewayToken })
  assert.equal(models.status, 200)
  assert.ok(models.json.data.some((m) => m.id === 'mock-echo'))

  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.emp.gatewayToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-echo', stream: true, messages: [{ role: 'user', content: '你好，网关' }] }),
  })
  assert.equal(r.status, 200)
  const text = await r.text()
  assert.match(text, /data: \{/)
  assert.match(text, /\[DONE\]/)
  assert.match(text, /"usage"/)

  const nonStream = await api('POST', '/v1/chat/completions', { token: ctx.emp.gatewayToken, body: { model: 'mock-echo', messages: [{ role: 'user', content: 'ping' }] } })
  assert.equal(nonStream.status, 200)
  assert.equal(nonStream.json.choices[0].message.role, 'assistant')

  const colleagues = await api('GET', '/api/colleagues', { token: ctx.emp.sessionToken })
  assert.equal(colleagues.status, 200)
  assert.ok(colleagues.json.ledger7d.requests >= 2)
  const me = colleagues.json.users.find((u) => u.username === 'emp-a')
  assert.ok(me.spend7dCny > 0)
  assert.equal(me.online, true)
  assert.ok(colleagues.json.quota[0].usedPct >= 0)
  assert.ok(colleagues.json.quota[0].refreshAt)

  const unknown = await api('POST', '/v1/chat/completions', { token: ctx.emp.gatewayToken, body: { model: 'nope', messages: [] } })
  assert.equal(unknown.status, 404)
  const noAuth = await api('POST', '/v1/chat/completions', { body: { model: 'mock-echo', messages: [] } })
  assert.equal(noAuth.status, 401)
})

test('任务卡：新建 → 绑定进程 → 口头完成不算 → 加交付物 → 提交验收 → 待审 → 待终审 → 通过', async () => {
  const created = await api('POST', '/api/tasks', { token: ctx.emp.sessionToken, body: { title: '学习agent完成详情页', content: '按销冠模块顺序做详情页', project: '电商详情页' } })
  assert.equal(created.status, 201)
  const task = created.json.task
  assert.match(task.id, /^tk-[0-9a-f]{10}$/)
  assert.equal(task.status, 'draft')
  assert.equal(task.assignee.username, 'emp-a')

  const bound = await api('POST', `/api/tasks/${task.id}/sessions`, { token: ctx.emp.sessionToken, body: { sessionId: 'session-19226000-f6ce-4f05-92a2-1d54f2e9d625', title: '详情页检查' } })
  assert.equal(bound.status, 200)
  assert.equal(bound.json.task.sessions.length, 1)
  assert.ok(bound.json.task.log.some((l) => l.kind === 'session'))

  const verbal = await api('POST', `/api/tasks/${task.id}/submit`, { token: ctx.emp.sessionToken, body: { reviewerId: ctx.dir.user.id } })
  assert.equal(verbal.status, 400)
  assert.equal(verbal.json.error.code, 'no_deliverables')

  const files = await api('POST', `/api/tasks/${task.id}/deliverables`, {
    token: ctx.emp.sessionToken,
    body: { files: [{ name: '详情页.html', dataBase64: Buffer.from('<h1>详情页</h1>').toString('base64'), source: 'session', sessionId: 'session-19226000-f6ce-4f05-92a2-1d54f2e9d625' }] },
  })
  assert.equal(files.status, 200)
  assert.equal(files.json.task.deliverables[0].path, `projects/inbox/${task.id}/详情页.html`)
  assert.ok(fs.existsSync(path.join(tmp, 'drive', 'projects', 'inbox', task.id, '详情页.html')))

  const adopted = await api('PATCH', `/api/tasks/${task.id}`, { token: ctx.emp.sessionToken, body: { submission: '已完成详情页三件套上架', adopt: 'submission', sessionId: 'session-19226000-f6ce-4f05-92a2-1d54f2e9d625' } })
  assert.equal(adopted.status, 200)
  assert.ok(adopted.json.task.log.some((l) => l.kind === 'adopt'))

  const submitted = await api('POST', `/api/tasks/${task.id}/submit`, { token: ctx.emp.sessionToken, body: { reviewerId: ctx.dir.user.id } })
  assert.equal(submitted.status, 200)
  assert.equal(submitted.json.task.status, 'pending_review')
  assert.equal(submitted.json.task.reviewer.username, 'director')

  const notReviewer = await api('POST', `/api/tasks/${task.id}/review`, { token: ctx.emp.sessionToken, body: { decision: 'pass' } })
  assert.equal(notReviewer.status, 403)

  const reviewed = await api('POST', `/api/tasks/${task.id}/review`, { token: ctx.dir.sessionToken, body: { decision: 'pass', comment: '结构对' } })
  assert.equal(reviewed.status, 200)
  assert.equal(reviewed.json.task.status, 'pending_final')

  const finalized = await api('POST', `/api/tasks/${task.id}/final`, { token: ctx.boss.sessionToken, body: { decision: 'pass', comment: '老板通过' } })
  assert.equal(finalized.status, 200)
  assert.equal(finalized.json.task.status, 'approved')
  assert.equal(finalized.json.task.statusLabel, '通过')

  const list = await api('GET', '/api/tasks', { token: ctx.dir.sessionToken })
  assert.ok(list.json.tasks.some((t) => t.id === task.id))

  // 驳回分支
  const t2 = (await api('POST', '/api/tasks', { token: ctx.emp.sessionToken, body: { title: '未命名报告' } })).json.task
  await api('POST', `/api/tasks/${t2.id}/deliverables`, { token: ctx.emp.sessionToken, body: { files: [{ name: 'a.txt', dataBase64: Buffer.from('x').toString('base64') }] } })
  await api('POST', `/api/tasks/${t2.id}/submit`, { token: ctx.emp.sessionToken, body: { reviewerId: ctx.dir.user.id } })
  const rejected = await api('POST', `/api/tasks/${t2.id}/review`, { token: ctx.dir.sessionToken, body: { decision: 'reject', comment: '缺证据' } })
  assert.equal(rejected.json.task.status, 'rejected')
  const resubmit = await api('POST', `/api/tasks/${t2.id}/submit`, { token: ctx.emp.sessionToken, body: { reviewerId: ctx.dir.user.id } })
  assert.equal(resubmit.json.task.status, 'pending_review')
})

test('公司盘：个人记忆按人隔离，共享区员工只能追加 05-logs', async () => {
  const w = await api('PUT', '/api/drive/file?path=_office/emp-a/_memory/02-methods/详情页做法.md', { token: ctx.emp.sessionToken, body: '# 做法\n照销冠模块顺序', raw: true })
  assert.equal(w.status, 200)
  const other = await api('GET', '/api/drive/file?path=_office/emp-a/_memory/02-methods/详情页做法.md', { token: ctx.dir.sessionToken })
  assert.equal(other.status, 403)
  const own = await api('GET', '/api/drive/file?path=_office/emp-a/_memory/02-methods/详情页做法.md', { token: ctx.emp.sessionToken })
  assert.equal(own.status, 200)
  const sharedDenied = await api('PUT', '/api/drive/file?path=_shared/_memory/02-methods/x.md', { token: ctx.emp.sessionToken, body: 'x', raw: true })
  assert.equal(sharedDenied.status, 403)
  const logAppend = await api('PUT', '/api/drive/file?path=_shared/_memory/05-logs/2026-09.md&append=1', { token: ctx.emp.sessionToken, body: '- 上架完成\n', raw: true })
  assert.equal(logAppend.status, 200)
  const sharedByDirector = await api('PUT', '/api/drive/file?path=_shared/_memory/02-methods/详情页模块顺序.md', { token: ctx.dir.sessionToken, body: '# 模块顺序', raw: true })
  assert.equal(sharedByDirector.status, 200)
  const snap = await api('GET', '/api/drive/snapshot', { token: ctx.emp.sessionToken })
  assert.equal(snap.status, 200)
  assert.ok(snap.json.files.some((f) => f.path === '_shared/_memory/02-methods/详情页模块顺序.md'))
  assert.ok(!snap.json.files.some((f) => f.path.startsWith('_office/director/')))
  const escape = await api('GET', '/api/drive/file?path=../users.json', { token: ctx.emp.sessionToken })
  assert.notEqual(escape.status, 200)
})

test('人员：发账号、改角色/部门、停用、吊销令牌即时生效、种子管理员保护', async () => {
  const denied = await api('GET', '/api/personnel', { token: ctx.emp.sessionToken })
  assert.equal(denied.status, 403)
  const p = await api('GET', '/api/personnel', { token: ctx.boss.sessionToken })
  assert.equal(p.status, 200)
  assert.ok(p.json.departments.some((d) => d.name === '内容部'))

  const created = await api('POST', '/api/personnel/users', { token: ctx.boss.sessionToken, body: { username: 'probe-emp', password: 'probe123', displayName: '探针', role: 'employee', department: '内容部' } })
  assert.equal(created.status, 201)
  const probeLogin = await api('POST', '/api/auth/login', { body: { username: 'probe-emp', password: 'probe123' } })
  assert.equal(probeLogin.status, 200)

  const ok1 = await api('GET', '/v1/models', { token: probeLogin.json.gatewayToken })
  assert.equal(ok1.status, 200)
  const revoked = await api('POST', `/api/personnel/users/${created.json.user.id}/revoke-token`, { token: ctx.boss.sessionToken })
  assert.equal(revoked.status, 200)
  assert.equal(revoked.json.revoked, 1)
  const after1 = await api('GET', '/v1/models', { token: probeLogin.json.gatewayToken })
  assert.equal(after1.status, 401)
  const othersFine = await api('GET', '/v1/models', { token: ctx.emp.gatewayToken })
  assert.equal(othersFine.status, 200)

  const roleChange = await api('PATCH', `/api/personnel/users/${created.json.user.id}`, { token: ctx.boss.sessionToken, body: { role: 'director', department: '电商部' } })
  assert.equal(roleChange.json.user.role, 'director')
  assert.equal(roleChange.json.user.department, '电商部')

  const disabled = await api('PATCH', `/api/personnel/users/${created.json.user.id}`, { token: ctx.boss.sessionToken, body: { disabled: true } })
  assert.equal(disabled.json.user.disabled, true)
  const loginDisabled = await api('POST', '/api/auth/login', { body: { username: 'probe-emp', password: 'probe123' } })
  assert.equal(loginDisabled.status, 403)

  const seedDemote = await api('PATCH', `/api/personnel/users/${ctx.boss.user.id}`, { token: ctx.boss.sessionToken, body: { role: 'employee' } })
  assert.equal(seedDemote.status, 400)
  assert.equal(seedDemote.json.error.code, 'seed_protected')
  const seedDisable = await api('PATCH', `/api/personnel/users/${ctx.boss.user.id}`, { token: ctx.boss.sessionToken, body: { disabled: true } })
  assert.equal(seedDisable.status, 400)
})

test('令牌绑定登录设备：换电脑 / 管理页登录不打断桌面端；登出只收回本机；管理员吊销一次收回全部', async () => {
  // 同一个人在第二台电脑登录：第一台的令牌照常可用，心跳看到的是「自己这台」的令牌状态
  const pc1 = await api('POST', '/api/auth/login', { body: { username: 'mingan', password: 'emp123456', device: 'pc-1' } })
  const pc2 = await api('POST', '/api/auth/login', { body: { username: 'mingan', password: 'emp123456', device: 'pc-2' } })
  assert.equal(pc1.status, 200)
  assert.equal(pc2.status, 200)
  assert.notEqual(pc1.json.gatewayToken, pc2.json.gatewayToken)
  assert.equal((await api('GET', '/v1/models', { token: pc1.json.gatewayToken })).status, 200, '第二台登录后第一台仍可调模型')
  assert.equal((await api('GET', '/v1/models', { token: pc2.json.gatewayToken })).status, 200)
  assert.equal((await api('POST', '/api/presence', { token: pc1.json.sessionToken, body: {} })).json.gatewayTokenActive, true)

  // 管理页 / 网页登录：不签网关令牌，也不影响桌面端
  const web = await api('POST', '/api/auth/login', { body: { username: 'mingan', password: 'emp123456', device: 'admin-page', gatewayToken: false } })
  assert.equal(web.status, 200)
  assert.equal(web.json.gatewayToken, null)
  assert.equal((await api('GET', '/v1/models', { token: pc1.json.gatewayToken })).status, 200)
  assert.equal((await api('POST', '/api/presence', { token: web.json.sessionToken, body: {} })).json.gatewayTokenActive, false, '网页登录自己没有网关令牌')

  // 第二台登出：只收回第二台的令牌
  assert.equal((await api('POST', '/api/auth/logout', { token: pc2.json.sessionToken, body: {} })).status, 200)
  assert.equal((await api('GET', '/v1/models', { token: pc2.json.gatewayToken })).status, 401)
  assert.equal((await api('GET', '/v1/models', { token: pc1.json.gatewayToken })).status, 200)

  // 管理员吊销：这个人所有电脑上的令牌立刻 401；登录会话还在，心跳据此提示「重新登录」
  const mingan = (await api('GET', '/api/people', { token: ctx.boss.sessionToken })).json.users.find((u) => u.username === 'mingan')
  const revoked = await api('POST', `/api/personnel/users/${mingan.id}/revoke-token`, { token: ctx.boss.sessionToken })
  assert.equal(revoked.status, 200)
  assert.ok(revoked.json.revoked >= 1)
  assert.equal((await api('GET', '/v1/models', { token: pc1.json.gatewayToken })).status, 401)
  const hb = await api('POST', '/api/presence', { token: pc1.json.sessionToken, body: {} })
  assert.equal(hb.status, 200)
  assert.equal(hb.json.gatewayTokenActive, false)
})

test('快速推理与订阅信息', async () => {
  const qi = await api('POST', '/api/quick-inference/run', { token: ctx.emp.sessionToken, body: { prompt: '把这句话缩短：今天天气很好' } })
  assert.equal(qi.status, 200)
  assert.ok(qi.json.content.length > 0)
  assert.ok(qi.json.latencyMs >= 0)
  const company = await api('GET', '/api/company', { token: ctx.emp.sessionToken })
  assert.equal(company.status, 200)
  assert.equal(company.json.canEdit, false)
  const patched = await api('PATCH', '/api/company', { token: ctx.boss.sessionToken, body: { plan: '企业版', seats: 30 } })
  assert.equal(patched.json.company.plan, '企业版')
  assert.equal(patched.json.company.seats, 30)
})

test('通道：管理员加入订阅 → 全员模型目录更新；凭据不外泄；断开即下架', async () => {
  const secret = 'xai-secret-token-should-never-leak'
  const empView = await api('GET', '/api/channels', { token: ctx.emp.sessionToken })
  assert.equal(empView.status, 200)
  assert.equal(empView.json.canEdit, false)
  const grokBefore = empView.json.channels.find((c) => c.id === 'grok')
  assert.equal(grokBefore.connected, false)
  assert.equal(grokBefore.kindLabel, '订阅')
  // config.json 里已配好的上游（这里是 Mock）显示为「已接 · 配置文件接入」
  assert.equal(empView.json.channels.find((c) => c.id === 'mock').source, 'config')

  // 员工不能接入
  const forbidden = await api('POST', '/api/channels/grok/connect', { token: ctx.emp.sessionToken, body: { credential: secret, models: 'grok-4.6' } })
  assert.equal(forbidden.status, 403)
  // 缺凭据 / 缺模型
  const noCred = await api('POST', '/api/channels/grok/connect', { token: ctx.boss.sessionToken, body: { models: 'grok-4.6' } })
  assert.equal(noCred.status, 400)
  const noModel = await api('POST', '/api/channels/grok/connect', { token: ctx.boss.sessionToken, body: { credential: secret, models: '' } })
  assert.equal(noModel.status, 200, noModel.json.error?.message)
  assert.ok(noModel.json.channel.models.includes('grok-4.6'), '空模型时应回退到内置目录')
  await api('POST', '/api/channels/grok/disconnect', { token: ctx.boss.sessionToken, body: {} })

  // 心跳带模型目录签名：接入前后签名不同，员工客户端据此在一个心跳内重写本机路由
  const sigBefore = (await api('POST', '/api/presence', { token: ctx.emp.sessionToken, body: {} })).json.modelsSignature
  assert.equal(typeof sigBefore, 'string')

  const connected = await api('POST', '/api/channels/grok/connect', { token: ctx.boss.sessionToken, body: { credential: secret, models: 'grok-4.6, grok-4.6-fast, grok-4.6' } })
  assert.equal(connected.status, 200)
  const sigAfter = (await api('POST', '/api/presence', { token: ctx.emp.sessionToken, body: {} })).json.modelsSignature
  assert.notEqual(sigAfter, sigBefore, '接入通道后目录签名必须变化')
  assert.ok(!sigAfter.includes(secret), '目录签名不能带凭据')
  assert.equal(connected.json.channel.connected, true)
  assert.equal(connected.json.channel.source, 'runtime')
  assert.deepEqual(connected.json.channel.models, ['grok-4.6', 'grok-4.6-fast'])
  assert.ok(!JSON.stringify(connected.json).includes(secret), '接入响应不能带凭据')

  // 全员可见：/api/auth/me 的公司模型目录、/v1/models 都出现新模型，展示名与推理档位来自通道默认
  const me = await api('GET', '/api/auth/me', { token: ctx.emp.sessionToken })
  const grokModel = me.json.company.models.find((m) => m.id === 'grok-4.6')
  assert.ok(grokModel)
  assert.equal(grokModel.name, 'Grok 4.6')
  assert.deepEqual(grokModel.reasoningEfforts, ['low', 'high'])
  assert.ok(!JSON.stringify(me.json).includes(secret), '公司目录不能带凭据')
  const v1 = await api('GET', '/v1/models', { token: ctx.emp.gatewayToken })
  assert.ok(v1.json.data.some((m) => m.id === 'grok-4.6-fast'))
  const list = await api('GET', '/api/channels', { token: ctx.emp.sessionToken })
  assert.ok(!JSON.stringify(list.json).includes(secret), '通道列表不能带凭据')

  // 凭据只落在服务端（默认 gateway.sqlite），不下发
  const stored = gw.channels.store.load()
  assert.equal(stored.items.grok.credential, secret)
  assert.ok(fs.existsSync(path.join(tmp, 'gateway.sqlite')), '默认走 SQLite')
  assert.ok(!fs.existsSync(path.join(tmp, 'channels.json')), '新库不再写 channels.json')

  // 断开：模型即刻下架，请求该模型 → 404
  const fromConfig = await api('POST', '/api/channels/mock/disconnect', { token: ctx.boss.sessionToken })
  assert.equal(fromConfig.status, 409)
  const off = await api('POST', '/api/channels/grok/disconnect', { token: ctx.boss.sessionToken })
  assert.equal(off.status, 200)
  assert.equal(off.json.channel.connected, false)
  const v1After = await api('GET', '/v1/models', { token: ctx.emp.gatewayToken })
  assert.ok(!v1After.json.data.some((m) => m.id.startsWith('grok')))
  const gone = await api('POST', '/v1/chat/completions', { token: ctx.emp.gatewayToken, body: { model: 'grok-4.6', messages: [{ role: 'user', content: 'x' }] } })
  assert.equal(gone.status, 404)
  assert.equal(gone.json.error.code, 'model_not_found')
})

test('知识检索（第四层通道）：公司里有没有人做过 → 谁/何时/在哪，按人隔离，不拷贝会话', async () => {
  // 前面的用例已经留下：emp-a 的个人记忆「详情页做法」、总监写的共享经验「详情页模块顺序」、任务卡「学习agent完成详情页」（已通过）
  const r = await api('GET', '/api/knowledge/search?q=' + encodeURIComponent('详情页'), { token: ctx.emp.sessionToken })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.terms, ['详情页'])
  const kinds = new Set(r.json.hits.map((h) => h.kind))
  assert.ok(kinds.has('task'), '应命中任务卡')
  assert.ok(kinds.has('shared'), '应命中共享经验')
  assert.ok(kinds.has('personal'), '应命中自己的个人记忆')
  const taskHit = r.json.hits.find((h) => h.kind === 'task')
  assert.equal(taskHit.who, '员工A')
  assert.equal(taskHit.statusLabel, '通过')
  assert.match(taskHit.path, /^projects\/inbox\/tk-/)
  assert.ok(taskHit.deliverables.includes('详情页.html'))
  assert.ok(taskHit.snippet.includes('详情页'))
  // 只给「谁/何时/在哪」：结果里没有会话事件、没有凭据
  assert.ok(!JSON.stringify(r.json).includes('assistant/message'))

  // 总监搜不到员工的个人记忆（个人记忆跟人走，不外泄）
  const byDir = await api('GET', '/api/knowledge/search?q=' + encodeURIComponent('详情页'), { token: ctx.dir.sessionToken })
  assert.equal(byDir.status, 200)
  assert.ok(!byDir.json.hits.some((h) => h.kind === 'personal' && h.path.startsWith('_office/emp-a/')))

  // 只搜某几类 / 没人做过
  const onlyTask = await api('GET', '/api/knowledge/search?q=' + encodeURIComponent('详情页') + '&kinds=task', { token: ctx.emp.sessionToken })
  assert.ok(onlyTask.json.hits.length > 0 && onlyTask.json.hits.every((h) => h.kind === 'task'))
  const none = await api('GET', '/api/knowledge/search?q=' + encodeURIComponent('量子计算'), { token: ctx.emp.sessionToken })
  assert.equal(none.json.hits.length, 0)
  assert.ok(none.json.scanned.files >= 1)
  const empty = await api('GET', '/api/knowledge/search?q=', { token: ctx.emp.sessionToken })
  assert.equal(empty.json.hits.length, 0)

  // 知识 / 工具合集：手册 + 共享经验六层
  const col = await api('GET', '/api/knowledge/collections', { token: ctx.emp.sessionToken })
  assert.equal(col.status, 200)
  assert.ok(col.json.handbook.some((f) => f.name.includes('岗位手册')))
  assert.ok(col.json.skills.some((f) => f.path.replace(/\\/g, '/').includes('_shared/skills/company-briefing/SKILL.md')))
  const skillSearch = await api('GET', '/api/knowledge/search?q=' + encodeURIComponent('四格验收'), { token: ctx.emp.sessionToken })
  assert.ok(skillSearch.json.hits.some((h) => h.kind === 'skill'), '示例技能应能被检索')
  assert.deepEqual(Object.keys(col.json.shared), ['01-projects', '02-methods', '03-evidence', '04-reviews', '05-logs', '90-system'])
  assert.ok(col.json.shared['02-methods'].files.some((f) => f.name === '详情页模块顺序.md'))
})

test('关联进程：+ 关联 / 撤销，日志留痕，视图带关联人', async () => {
  const t = (await api('POST', '/api/tasks', { token: ctx.emp.sessionToken, body: { title: '关联进程测试' } })).json.task
  const sid = 'session-ff12a10b-b4c6-406f-85f3-fc70fea05055'
  const bound = await api('POST', `/api/tasks/${t.id}/sessions`, { token: ctx.emp.sessionToken, body: { sessionId: sid, title: '详情页任务', device: 'test-pc' } })
  assert.equal(bound.status, 200)
  assert.equal(bound.json.task.sessions[0].user.username, 'emp-a')
  // 别人（无关员工）不能撤销
  const probe = await api('POST', '/api/auth/login', { body: { username: 'mingan', password: 'emp123456' } })
  const denied = await api('DELETE', `/api/tasks/${t.id}/sessions/${sid}`, { token: probe.json.sessionToken })
  assert.ok([403, 404].includes(denied.status))
  const unbound = await api('DELETE', `/api/tasks/${t.id}/sessions/${sid}`, { token: ctx.emp.sessionToken })
  assert.equal(unbound.status, 200)
  assert.equal(unbound.json.task.sessions.length, 0)
  assert.ok(unbound.json.task.log.some((l) => l.kind === 'session' && l.unbound === true && l.sessionId === sid))
  const again = await api('DELETE', `/api/tasks/${t.id}/sessions/${sid}`, { token: ctx.emp.sessionToken })
  assert.equal(again.status, 404)
  assert.equal(again.json.error.code, 'session_not_bound')
})

test('服务器管理页 /admin 可达；/api/status 仅总监/管理员', async () => {
  const page = await fetch(base + '/admin')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
  const html = await page.text()
  for (const s of ['valimart harness', 'harness', '模型通道', '加入订阅', '加入模型', '知识库查询', '公司盘', '内核', '客户端', '试打补丁', '回滚到上一版', '初始设置', '上传并发布']) assert.ok(html.includes(s), `管理页应包含「${s}」`)
  assert.ok(html.includes('/api/admin/client'), '管理页应拉客户端目录')
  assert.ok(html.includes('data-page="org"') || html.includes('#org'), '管理页应有组织分页')
  assert.ok(html.includes('data-page="knowledge"') || html.includes('#knowledge'), '管理页应有知识分页')
  for (const s of ['概览', '组织', '岗位', '更新', '模型', '知识', '工具']) assert.ok(html.includes(s), `管理页应包含「${s}」`)
  for (const id of ['overview', 'updates', 'models', 'knowledge', 'org', 'tools']) {
    assert.ok(html.includes(`data-page="${id}"`), `管理页应有 ${id} 分页`)
  }
  assert.ok(html.includes('id="nav"'), '管理页应有侧栏菜单')
  assert.ok(html.includes('class="fold"'), '知识/工具合集应折叠')
  assert.ok(html.includes('data-export='), '管理页应有导出')
  assert.ok(html.includes('data-import='), '管理页应有导入')
  assert.ok(html.includes('data-posset='), '人员应能派岗位')
  for (const s of ["['knowledge', '知识库']", "['skills', '技能']", "['personnel', '人员']", "['positions', '岗位']", "['departments', '部门']", "impexp('tools', '工具目录')"]) {
    assert.ok(html.includes(s), `管理页应有 ${s} 导入导出`)
  }
  assert.ok(html.includes('x-client-build-id'), '管理页上传安装包应带 buildId')
  assert.ok(html.includes('data-edit='), '已接入通道应有编辑入口')
  assert.match(html, /form:not\(\.row\) > button/, '堆叠表单提交按钮与上一栏留间距（写入知识库不贴内容框）')
  assert.match(html, /#channels table/, '通道表单独定列宽，避免模型把短列挤成竖排')
  assert.match(html, /\.ch-models/, '通道模型用标签折行，不把整行撑乱')
  assert.ok(html.includes('/admin/brand/valimart-mark.png'), 'favicon 仍用花标')
  assert.ok(html.includes('class="word"'), '管理页 logo 用完整字标蒙版（图里已含花标）')
  assert.ok(!html.includes('class="mark"'), '字标图已含花标，不要再并一枚 mark')
  assert.ok(!html.includes('<small>harness</small>'), '管理页不应把 harness 当 logo 文字')
  assert.match(html, /let status, channels, collections, kernel, client, plugins = \{ entries: \[\] \}/, 'plugins 必须和外层变量一起声明，否则 renderMain 会 ReferenceError')
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    try {
      new Function(m[1])
    } catch (err) {
      assert.fail(`管理页 inline script 语法错误: ${err.message}`)
    }
  }
  const mark = await fetch(base + '/admin/brand/valimart-mark.png')
  assert.equal(mark.status, 200)
  assert.match(mark.headers.get('content-type'), /image\/png/)
  const markBuf = Buffer.from(await mark.arrayBuffer())
  assert.equal(markBuf[0], 0x89)
  assert.equal(markBuf[1], 0x50)
  const fav = await fetch(base + '/favicon.ico')
  assert.equal(fav.status, 200)
  const root = await fetch(base + '/', { redirect: 'manual' })
  assert.equal(root.status, 302)
  assert.equal(root.headers.get('location'), '/admin')

  const denied = await api('GET', '/api/status', { token: ctx.emp.sessionToken })
  assert.equal(denied.status, 403)
  const st = await api('GET', '/api/status', { token: ctx.boss.sessionToken })
  assert.equal(st.status, 200)
  assert.ok(st.json.server.uptimeSeconds >= 0)
  assert.ok(st.json.people.total >= 8)
  assert.ok(st.json.tasks.total >= 3)
  assert.ok(st.json.drive.shared.files >= 2)
  assert.ok(Array.isArray(st.json.channels) && st.json.channels.length === 2)
  assert.ok(!JSON.stringify(st.json).includes('xai-secret'), '状态接口不能带凭据')
})

test('周额度：用满后 429', async () => {
  // 把 emp-a 的个人周额度设成极小，再请求
  await api('PATCH', `/api/personnel/users/${ctx.emp.user.id}`, { token: ctx.boss.sessionToken, body: { weeklyQuotaCny: 0.000001 } })
  const r = await api('POST', '/v1/chat/completions', { token: ctx.emp.gatewayToken, body: { model: 'mock-echo', messages: [{ role: 'user', content: 'x' }] } })
  assert.equal(r.status, 429)
  assert.equal(r.json.error.code, 'quota_exceeded')
  await api('PATCH', `/api/personnel/users/${ctx.emp.user.id}`, { token: ctx.boss.sessionToken, body: { weeklyQuotaCny: null } })
  const ok = await api('POST', '/v1/chat/completions', { token: ctx.emp.gatewayToken, body: { model: 'mock-echo', messages: [{ role: 'user', content: 'x' }] } })
  assert.equal(ok.status, 200)
})

test('周额度：并发两笔只放行一笔，第二笔 429', async () => {
  const created = await api('POST', '/api/personnel/users', {
    token: ctx.boss.sessionToken,
    body: { username: 'quota-race', password: 'quota123', displayName: '额度竞态', role: 'employee', department: '测试' },
  })
  assert.equal(created.status, 201)
  await api('PATCH', `/api/personnel/users/${created.json.user.id}`, { token: ctx.boss.sessionToken, body: { weeklyQuotaCny: 0.0000005 } })
  const login = await api('POST', '/api/auth/login', { body: { username: 'quota-race', password: 'quota123', device: 'test' } })
  assert.equal(login.status, 200)
  const body = { model: 'mock-echo', messages: [{ role: 'user', content: 'race' }] }
  const [a, b] = await Promise.all([
    api('POST', '/v1/chat/completions', { token: login.json.gatewayToken, body }),
    api('POST', '/v1/chat/completions', { token: login.json.gatewayToken, body }),
  ])
  const statuses = [a.status, b.status].sort()
  assert.deepEqual(statuses, [200, 429])
  const denied = a.status === 429 ? a : b
  assert.equal(denied.json.error.code, 'quota_exceeded')
})

test('客户端：未登录 401；无发布时 available=false；总监可读、员工不能管、管理员发布/回滚', async () => {
  const no = await api('GET', '/api/client/current')
  assert.equal(no.status, 401)
  const empty = await api('GET', '/api/client/current', { token: ctx.boss.sessionToken })
  assert.equal(empty.status, 200)
  assert.equal(empty.json.available, false)
  const miss = await api('GET', '/api/client/download', { token: ctx.boss.sessionToken })
  assert.equal(miss.status, 404)

  const empGet = await api('GET', '/api/admin/client', { token: ctx.emp.sessionToken })
  assert.equal(empGet.status, 403)
  const dirGet = await api('GET', '/api/admin/client', { token: ctx.dir.sessionToken })
  assert.equal(dirGet.status, 200)
  assert.ok(Array.isArray(dirGet.json.stored))
  const dirPub = await api('POST', '/api/admin/client/publish', { token: ctx.dir.sessionToken, body: { buildId: 'nope' } })
  assert.equal(dirPub.status, 403)

  const empPub = await api('POST', '/api/admin/client/publish', { token: ctx.emp.sessionToken, body: { buildId: 'nope' } })
  assert.equal(empPub.status, 403)

  const exe = Buffer.from('FAKE-CLIENT-A')
  const sha = crypto.createHash('sha256').update(exe).digest('hex')
  const up = await fetch(base + '/api/admin/client/publish', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + ctx.boss.sessionToken,
      'content-type': 'application/octet-stream',
      'x-client-build-id': '0.1.0+aaa',
      'x-client-sha256': sha,
      'x-client-version': '0.1.0',
      'x-client-filename': 'valimart-harness-Setup-0.1.0.exe',
    },
    body: exe,
  })
  assert.equal(up.status, 200)
  const published = await up.json()
  assert.equal(published.buildId, '0.1.0+aaa')

  const cur = await api('GET', '/api/client/current', { token: ctx.emp.sessionToken })
  assert.equal(cur.json.available, true)
  assert.equal(cur.json.buildId, '0.1.0+aaa')
  assert.equal(cur.json.sha256, sha)

  const bin = await fetch(base + '/api/client/download', { headers: { authorization: 'Bearer ' + ctx.emp.sessionToken } })
  assert.equal(bin.status, 200)
  assert.equal(Buffer.from(await bin.arrayBuffer()).toString(), 'FAKE-CLIENT-A')

  const exe2 = Buffer.from('FAKE-CLIENT-B')
  const sha2 = crypto.createHash('sha256').update(exe2).digest('hex')
  await fetch(base + '/api/admin/client/publish', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + ctx.boss.sessionToken,
      'content-type': 'application/octet-stream',
      'x-client-build-id': '0.1.0+bbb',
      'x-client-sha256': sha2,
      'x-client-version': '0.1.0',
      'x-client-filename': 'valimart-harness-Setup-0.1.0.exe',
    },
    body: exe2,
  })
  const after = await api('GET', '/api/client/current', { token: ctx.boss.sessionToken })
  assert.equal(after.json.buildId, '0.1.0+bbb')

  const rb = await api('POST', '/api/admin/client/rollback', { token: ctx.boss.sessionToken })
  assert.equal(rb.status, 200)
  assert.equal(rb.json.buildId, '0.1.0+aaa')
  const stored = await api('GET', '/api/admin/client', { token: ctx.boss.sessionToken })
  assert.equal(stored.json.stored.length, 2)
  const republish = await api('POST', '/api/admin/client/publish', { token: ctx.boss.sessionToken, body: { buildId: '0.1.0+bbb' } })
  assert.equal(republish.status, 200)
  assert.equal(republish.json.buildId, '0.1.0+bbb')
  const cur2 = await api('GET', '/api/client/current', { token: ctx.emp.sessionToken })
  assert.equal(cur2.json.buildId, '0.1.0+bbb')
})

test('组织：岗位额度 token/金额；导入导出；员工不能管', async () => {
  const emp = await api('GET', '/api/org', { token: ctx.emp.sessionToken })
  assert.equal(emp.status, 403)
  const created = await api('POST', '/api/org/positions', { token: ctx.boss.sessionToken, body: { name: '设计师', quotaKind: 'tokens', weeklyQuotaTokens: 5000 } })
  assert.equal(created.status, 201)
  assert.equal(created.json.position.quotaKind, 'tokens')
  const listed = await api('GET', '/api/org', { token: ctx.dir.sessionToken })
  assert.equal(listed.status, 200)
  assert.ok(listed.json.positions.some((p) => p.name === '设计师'))
  const assign = await api('PATCH', `/api/personnel/users/${ctx.emp.user.id}`, { token: ctx.boss.sessionToken, body: { positionId: created.json.position.id } })
  assert.equal(assign.status, 200)
  assert.equal(assign.json.user.positionId, created.json.position.id)
  const empRow = assign.json.departments.flatMap((d) => d.users).find((u) => u.id === ctx.emp.user.id)
  assert.equal(empRow.quota.kind, 'tokens')
  assert.equal(empRow.quota.source, 'position')
  assert.equal(empRow.quota.limit, 5000)
  const patched = await api('PATCH', `/api/org/positions/${created.json.position.id}`, { token: ctx.boss.sessionToken, body: { quotaKind: 'cny', weeklyQuotaCny: 40 } })
  assert.equal(patched.status, 200)
  assert.equal(patched.json.position.quotaKind, 'cny')
  const exp = await api('GET', '/api/admin/export?kinds=positions,departments,personnel,tools,knowledge,skills', { token: ctx.boss.sessionToken })
  assert.equal(exp.status, 200)
  assert.equal(exp.json.kind, 'valimart-harness-org')
  assert.ok(exp.json.positions.some((p) => p.name === '设计师'))
  assert.ok(Array.isArray(exp.json.tools))
  assert.ok(Array.isArray(exp.json.knowledge))
  assert.ok(Array.isArray(exp.json.skills))
  const empExp = await api('GET', '/api/admin/export', { token: ctx.emp.sessionToken })
  assert.equal(empExp.status, 403)
  const knImp = await api('POST', '/api/admin/import', { token: ctx.boss.sessionToken, body: { bundle: exp.json, kinds: ['knowledge', 'skills'] } })
  assert.equal(knImp.status, 200)
  const del = await api('DELETE', `/api/org/positions/${created.json.position.id}`, { token: ctx.boss.sessionToken })
  assert.equal(del.status, 200)
})

test('内核：总监可 GET 管理视图；员工 GET 403；总监不能 publish', async () => {
  const empGet = await api('GET', '/api/admin/kernel', { token: ctx.emp.sessionToken })
  assert.equal(empGet.status, 403)

  const dirGet = await api('GET', '/api/admin/kernel', { token: ctx.dir.sessionToken })
  assert.equal(dirGet.status, 200)
  assert.ok('current' in dirGet.json)
  assert.ok(Array.isArray(dirGet.json.stored))
  assert.ok(Array.isArray(dirGet.json.discover))
  assert.ok('pinVersion' in dirGet.json)

  const dirPub = await api('POST', '/api/admin/kernel/publish', { token: ctx.dir.sessionToken, body: { version: '9.9.9' } })
  assert.equal(dirPub.status, 403)
})

test('内核：未登录读 current 是 401；登录后无 current 则 bundled', async () => {
  const no = await api('GET', '/api/kernel/current')
  assert.equal(no.status, 401)
  const ok = await api('GET', '/api/kernel/current', { token: ctx.boss.sessionToken })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.bundled, true)
  assert.equal(ok.json.tarball, false)
  const tar = await api('GET', '/api/kernel/tarball', { token: ctx.boss.sessionToken })
  assert.equal(tar.status, 404)
})

test('内核：员工不能 publish；管理员 publish / rollback', async () => {
  const forbidden = await api('POST', '/api/admin/kernel/publish', { token: ctx.emp.sessionToken, body: { version: '9.9.9' } })
  assert.equal(forbidden.status, 403)

  const dir = path.join(tmp, 'kernels', '0.1.9-test')
  fs.mkdirSync(dir, { recursive: true })
  const tar = path.join(dir, 'kernel.tar')
  fs.writeFileSync(tar, 'FAKE-TAR')
  const sha = crypto.createHash('sha256').update('FAKE-TAR').digest('hex')
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    package: '@deepseek-ai/dsh', version: '0.1.9-test', sha256: sha, bytes: 8,
    sourceTag: 'dsh-v0.1.9-test', sourceRepo: 'https://github.com/deepseek-ai/deepseek-harness',
    patched: 'test', builtAt: new Date().toISOString(),
  }))

  const pub = await api('POST', '/api/admin/kernel/publish', { token: ctx.boss.sessionToken, body: { version: '0.1.9-test' } })
  assert.equal(pub.status, 200)
  assert.equal(pub.json.version, '0.1.9-test')
  assert.equal(pub.json.previous, null)

  const cur = await api('GET', '/api/kernel/current', { token: ctx.boss.sessionToken })
  assert.equal(cur.json.bundled, false)
  assert.equal(cur.json.version, '0.1.9-test')
  assert.equal(cur.json.sha256, sha)

  const bin = await fetch(base + '/api/kernel/tarball', { headers: { authorization: 'Bearer ' + ctx.boss.sessionToken } })
  assert.equal(bin.status, 200)
  assert.equal(Buffer.from(await bin.arrayBuffer()).toString(), 'FAKE-TAR')

  const rb0 = await api('POST', '/api/admin/kernel/rollback', { token: ctx.boss.sessionToken })
  assert.equal(rb0.status, 400)

  fs.mkdirSync(path.join(tmp, 'kernels', '0.1.8-test'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'kernels', '0.1.8-test', 'kernel.tar'), 'OLD')
  const sha8 = crypto.createHash('sha256').update('OLD').digest('hex')
  fs.writeFileSync(path.join(tmp, 'kernels', '0.1.8-test', 'manifest.json'), JSON.stringify({
    package: '@deepseek-ai/dsh', version: '0.1.8-test', sha256: sha8, bytes: 3,
    sourceTag: 'dsh-v0.1.8-test', sourceRepo: 'https://github.com/deepseek-ai/deepseek-harness',
    patched: 'test', builtAt: new Date().toISOString(),
  }))
  await api('POST', '/api/admin/kernel/publish', { token: ctx.boss.sessionToken, body: { version: '0.1.8-test' } })
  const after = await api('GET', '/api/kernel/current', { token: ctx.boss.sessionToken })
  assert.equal(after.json.version, '0.1.8-test')
  assert.equal(after.json.sha256, sha8)

  const rb = await api('POST', '/api/admin/kernel/rollback', { token: ctx.boss.sessionToken })
  assert.equal(rb.status, 200)
  assert.equal(rb.json.version, '0.1.9-test')
})

test('内核：prepare 缺 version 为 400；员工 403（不跑 npm）', async () => {
  const denied = await api('POST', '/api/admin/kernel/prepare', { token: ctx.emp.sessionToken, body: { version: '9.0.0' } })
  assert.equal(denied.status, 403)
  const r = await api('POST', '/api/admin/kernel/prepare', { token: ctx.boss.sessionToken, body: {} })
  assert.equal(r.status, 400)
  assert.equal(r.json.error.code, 'bad_request')
})

test('内核：prepare 对不在 npm 的 version 返回 400 且不跑 npm', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-gw-npm-'))
  let installs = 0
  const extra = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    upstreams: { mock: { kind: 'mock', label: 'Mock', models: [{ id: 'mock-echo', name: 'Mock Echo', priceCnyPerM: { input: 1, output: 2, cachedInput: 0.1 } }] } },
    channels: [],
    defaultModel: 'mock-echo',
    fetchReleases: async () => [],
    fetchNpmVersions: async () => ['0.1.2-rc.1'],
    prepareInstaller: () => {
      installs++
    },
  })
  const url = await extra.listen()
  try {
    const login = await fetch(url + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'boss123456', device: 'test' }),
    })
    const { sessionToken } = await login.json()
    const r = await fetch(url + '/api/admin/kernel/prepare', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + sessionToken, 'content-type': 'application/json' },
      body: JSON.stringify({ version: '0.1.3-alpha.1' }),
    })
    const json = await r.json()
    assert.equal(r.status, 400)
    assert.equal(json.error.code, 'not_on_npm')
    assert.match(json.error.message, /GitHub 有 tag/)
    assert.match(json.error.message, /@deepseek-ai\/dsh@0\.1\.3-alpha\.1/)
    assert.equal(installs, 0)
  } finally {
    await extra.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
