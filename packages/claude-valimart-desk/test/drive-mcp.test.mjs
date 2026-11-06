import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { describe, it, before, after } from 'node:test'
import { DriveMirror } from '../lib/drive-mirror.mjs'

const root = path.resolve(import.meta.dirname, '..')
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

const TOOL_NAMES = [
  'company_whoami',
  'company_knowledge',
  'company_tasks',
  'company_task_read',
  'company_task_log',
  'company_task_update',
  'company_task_attach',
  'company_task_submit',
  'company_task_review',
  'company_task_final',
  'company_memory_write',
  'company_memory_read',
  'company_memory_list',
  'company_drive_sync',
]

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'valimart-claude-drive-'))
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

async function waitFor(check, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

/** 进程内假网关：只给 DriveMirror 用，记下每次回推。 */
function fakeGateway(files) {
  const puts = []
  return {
    puts,
    async get(p) {
      if (p === '/api/drive/snapshot') {
        return { files: [...files].map(([rel, buf]) => ({ path: rel, size: buf.length, sha256: sha(buf) })), memoryLayers: [] }
      }
      return files.get(new URL(p, 'http://x').searchParams.get('path'))
    },
    async put(p, buf) {
      const rel = new URL(p, 'http://x').searchParams.get('path')
      puts.push(rel)
      files.set(rel, Buffer.from(buf))
      return { file: { path: rel, size: buf.length } }
    },
  }
}

const stateBox = () => ({ data: { user: { username: 'emp-a' } }, save() {} })

/** HTTP mock 网关：公司盘 + 任务卡 + 人员，够 MCP 工具走通。 */
async function mockGateway() {
  const gw = {
    token: 'session',
    files: new Map(),
    calls: [],
    users: [
      { id: 'u-a', username: 'emp-a', displayName: '陈一', role: 'employee' },
      { id: 'u-d', username: 'director', displayName: '王总监', role: 'director' },
    ],
    tasks: new Map([
      ['tk-1', { id: 'tk-1', title: '详情页改版', status: 'draft', statusLabel: '进行中', assigneeId: 'u-a', assignerId: 'u-d', deliverables: [], log: [], createdAt: '2026-11-01T00:00:00Z' }],
    ]),
  }
  gw.server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    gw.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body })
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (req.headers.authorization !== `Bearer ${gw.token}`) return json(401, { error: { message: '登录已失效', code: 'unauthorized' } })
    const rel = url.searchParams.get('path')
    const taskRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/([a-z]+))?$/)
    if (req.method === 'GET' && url.pathname === '/api/auth/me') return json(200, { user: gw.users[0], company: { name: '惠利玛' }, quota: [] })
    if (req.method === 'GET' && url.pathname === '/api/drive/snapshot') {
      return json(200, {
        files: [...gw.files].map(([p, b]) => ({ path: p, size: b.length, sha256: sha(b) })),
        memoryLayers: [{ dir: '02-methods' }, { dir: '05-logs' }],
      })
    }
    if (req.method === 'GET' && url.pathname === '/api/drive/file') {
      const buf = gw.files.get(rel)
      if (!buf) return json(404, { error: { message: '文件不存在' } })
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      return res.end(buf)
    }
    if (req.method === 'PUT' && url.pathname === '/api/drive/file') {
      const next = url.searchParams.get('append') === '1' ? Buffer.concat([gw.files.get(rel) ?? Buffer.alloc(0), body]) : body
      gw.files.set(rel, next)
      return json(200, { file: { path: rel, size: next.length } })
    }
    if (req.method === 'GET' && url.pathname === '/api/people') return json(200, { users: gw.users })
    if (req.method === 'GET' && url.pathname === '/api/tasks') return json(200, { tasks: [...gw.tasks.values()], statuses: {} })
    if (taskRoute) {
      const task = gw.tasks.get(decodeURIComponent(taskRoute[1]))
      if (!task) return json(404, { error: { message: '任务不存在' } })
      const payload = body.length ? JSON.parse(body.toString('utf8')) : {}
      const action = taskRoute[2]
      if (req.method === 'GET' && !action) return json(200, { task })
      if (req.method === 'PATCH' && !action) {
        Object.assign(task, payload.submission !== undefined ? { submission: payload.submission } : {}, payload.content !== undefined ? { content: payload.content } : {})
        return json(200, { task })
      }
      if (req.method === 'POST' && action === 'deliverables') {
        for (const f of payload.files) task.deliverables.push({ name: f.name, size: Buffer.from(f.dataBase64, 'base64').length, source: f.source })
        return json(200, { task })
      }
      if (req.method === 'POST' && action === 'log') {
        task.log.push({ ts: '2026-11-02T00:00:00Z', actorName: '陈一', kind: payload.kind, text: payload.text })
        return json(200, { task })
      }
      if (req.method === 'POST' && action === 'submit') {
        Object.assign(task, { status: 'pending_review', statusLabel: '待审', reviewerId: payload.reviewerId })
        return json(200, { task })
      }
    }
    return json(404, { error: { message: `没有路由 ${req.method} ${url.pathname}` } })
  })
  await new Promise((resolve) => gw.server.listen(0, '127.0.0.1', resolve))
  gw.url = `http://127.0.0.1:${gw.server.address().port}`
  gw.puts = () => gw.calls.filter((c) => c.method === 'PUT')
  return gw
}

/** 拉起真实的 MCP 进程，按行收发 JSON-RPC；stdout 里任何非 JSON 行都记进 bad。 */
function startMcp(env) {
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'mcp-server.mjs')], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const waiters = new Map()
  const bad = []
  let buf = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (data) => {
    buf += data
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        bad.push(line)
        continue
      }
      waiters.get(msg.id)?.(msg)
      waiters.delete(msg.id)
    }
  })
  child.stderr.on('data', (data) => {
    stderr += data
  })
  let nextId = 1
  const mcp = {
    bad,
    get stderr() {
      return stderr
    },
    request(method, params) {
      const id = nextId++
      const answer = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} 超时；stderr：${stderr}`)), 10_000)
        waiters.set(id, (msg) => {
          clearTimeout(timer)
          resolve(msg)
        })
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return answer
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
    async call(name, args = {}) {
      const msg = await mcp.request('tools/call', { name, arguments: args })
      assert.ok(msg.result, `tools/call ${name} 没有 result：${JSON.stringify(msg)}`)
      return { ...msg.result, text: msg.result.content.map((c) => c.text).join('\n') }
    },
    async init() {
      const msg = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
      mcp.notify('notifications/initialized')
      return msg
    },
    close() {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.stdin.end()
      return exited
    },
  }
  return mcp
}

function writeLoggedInState(file, gatewayUrl) {
  fs.writeFileSync(file, JSON.stringify({
    gatewayUrl,
    sessionToken: 'session',
    gatewayToken: 'gateway-token',
    user: { id: 'u-a', username: 'emp-a', displayName: '陈一', role: 'employee' },
    company: { name: '惠利玛' },
  }))
}

describe('drive mirror', () => {
  const rel = '_office/emp-a/_memory/02-methods/a.md'

  it('does not let a stale copy from an earlier session overwrite a newer remote edit', async () => {
    const dir = tmpDir()
    const files = new Map([[rel, Buffer.from('v1')]])
    const gw = fakeGateway(files)
    await new DriveMirror({ root: dir, gateway: gw, state: stateBox() }).sync()
    files.set(rel, Buffer.from('v2 来自另一台电脑'))
    // 新会话 = 新进程 = 新实例：靠落盘的同步索引认出本机这份只是旧副本
    const r = await new DriveMirror({ root: dir, gateway: gw, state: stateBox() }).sync()
    assert.deepEqual(gw.puts, [])
    assert.equal(r.pulled, 1)
    assert.equal(fs.readFileSync(path.join(dir, rel), 'utf8'), 'v2 来自另一台电脑')
    assert.equal(fs.readdirSync(path.dirname(path.join(dir, rel))).some((n) => n.endsWith('.tmp')), false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('still pushes a local edit made between sessions', async () => {
    const dir = tmpDir()
    const files = new Map([[rel, Buffer.from('v1')]])
    const gw = fakeGateway(files)
    await new DriveMirror({ root: dir, gateway: gw, state: stateBox() }).sync()
    fs.writeFileSync(path.join(dir, rel), '本地改过')
    const r = await new DriveMirror({ root: dir, gateway: gw, state: stateBox() }).sync()
    assert.deepEqual(gw.puts, [rel])
    assert.equal(r.pushed, 1)
    assert.equal(files.get(rel).toString(), '本地改过')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('lets the remote win when there is no sync record, but uploads local-only files', async () => {
    const dir = tmpDir()
    const only = '_office/emp-a/_memory/02-methods/b.md'
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), '来路不明的旧副本')
    fs.writeFileSync(path.join(dir, only), '只在本机')
    const files = new Map([[rel, Buffer.from('远端新版')]])
    const gw = fakeGateway(files)
    await new DriveMirror({ root: dir, gateway: gw, state: stateBox() }).sync()
    assert.deepEqual(gw.puts, [only])
    assert.equal(fs.readFileSync(path.join(dir, rel), 'utf8'), '远端新版')
    assert.equal(files.get(only).toString(), '只在本机')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('mcp server', () => {
  let dir
  let gw
  let mcp
  let stateFile
  let driveDir

  before(async () => {
    dir = tmpDir()
    gw = await mockGateway()
    stateFile = path.join(dir, 'valimart-desk.json')
    driveDir = path.join(dir, 'claude', 'valimart-drive')
    writeLoggedInState(stateFile, gw.url)
    mcp = startMcp({ VALIMART_DESK_STATE: stateFile, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), VALIMART_DRIVE_SYNC_MS: '0' })
  })

  after(async () => {
    await mcp.close()
    gw.server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('initializes and lists the 14 company tools within the tool-name limit', async () => {
    const init = await mcp.init()
    const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json'))
    assert.equal(init.result.protocolVersion, '2025-06-18')
    assert.equal(init.result.serverInfo.name, 'valimart-desk')
    assert.equal(init.result.serverInfo.version, manifest.version)
    assert.ok(init.result.capabilities.tools)
    assert.match(init.result.instructions, /company_knowledge/)
    const list = await mcp.request('tools/list', {})
    const tools = list.result.tools
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort())
    for (const t of tools) {
      assert.equal(t.inputSchema.type, 'object')
      assert.equal('run' in t, false)
      assert.ok(`mcp__plugin_valimart-desk_desk__${t.name}`.length <= 64, t.name)
    }
    assert.equal(tools.find((t) => t.name === 'company_memory_read').annotations.readOnlyHint, true)
    assert.equal(tools.find((t) => t.name === 'company_memory_write').annotations, undefined)
  })

  it('syncs the drive and writes personal memory without pushing it a second time', async () => {
    gw.files.set('_shared/_memory/02-methods/共享.md', Buffer.from('共享经验'))
    const sync = await mcp.call('company_drive_sync')
    assert.equal(sync.isError, false, sync.text)
    assert.match(sync.text, /下载 1/)
    assert.equal(fs.readFileSync(path.join(driveDir, '_shared/_memory/02-methods/共享.md'), 'utf8'), '共享经验')
    assert.ok(readJson(stateFile).lastSyncAt)

    const rel = '_office/emp-a/_memory/02-methods/详情页.md'
    const write = await mcp.call('company_memory_write', { zone: 'personal', path: '02-methods/详情页.md', content: '先放主图' })
    assert.equal(write.isError, false, write.text)
    assert.equal(gw.files.get(rel).toString(), '先放主图')
    assert.equal(fs.readFileSync(path.join(driveDir, rel), 'utf8'), '先放主图')
    const puts = gw.puts().length
    const again = await mcp.call('company_drive_sync')
    assert.match(again.text, /回推 0/)
    assert.equal(gw.puts().length, puts)
  })

  it('appends to a log in place when the local copy is current', async () => {
    const rel = '_office/emp-a/_memory/05-logs/2026-11.md'
    gw.files.set(rel, Buffer.from('- 第一条\n'))
    await mcp.call('company_drive_sync')
    const r = await mcp.call('company_memory_write', { zone: 'personal', path: '05-logs/2026-11.md', content: '- 第二条\n' })
    assert.equal(r.isError, false, r.text)
    assert.match(r.text, /追加/)
    assert.equal(gw.puts().at(-1).query.append, '1')
    assert.equal(gw.files.get(rel).toString(), '- 第一条\n- 第二条\n')
    assert.equal(fs.readFileSync(path.join(driveDir, rel), 'utf8'), '- 第一条\n- 第二条\n')
    assert.match((await mcp.call('company_drive_sync')).text, /回推 0/)
  })

  it('refuses a memory path that climbs out of its zone', async () => {
    const before = gw.calls.length
    const r = await mcp.call('company_memory_write', { zone: 'personal', path: '../../../_shared/handbook/改手册.md', content: 'x' })
    assert.equal(r.isError, true)
    assert.match(r.text, /越出/)
    assert.equal(gw.calls.length, before)
  })

  it('walks a task card: needs a binding, attaches a file, lists reviewers except me', async () => {
    const unbound = await mcp.call('company_task_read')
    assert.equal(unbound.isError, true)
    assert.match(unbound.text, /desk-task/)

    const file = path.join(dir, '交付.txt')
    fs.writeFileSync(file, '交付物内容')
    const attach = await mcp.call('company_task_attach', { taskId: 'tk-1', paths: [file] })
    assert.equal(attach.isError, false, attach.text)
    const post = gw.calls.find((c) => c.path === '/api/tasks/tk-1/deliverables')
    const sent = JSON.parse(post.body.toString('utf8')).files[0]
    assert.equal(sent.name, '交付.txt')
    assert.equal(Buffer.from(sent.dataBase64, 'base64').toString('utf8'), '交付物内容')
    assert.match(fs.readFileSync(path.join(driveDir, 'projects/inbox/tk-1/_task-card.md'), 'utf8'), /交付\.txt/)

    const submit = await mcp.call('company_task_submit', { taskId: 'tk-1' })
    assert.equal(submit.isError, false, submit.text)
    assert.match(submit.text, /u-d\s+王总监/)
    assert.equal(submit.text.includes('u-a'), false)
  })

  it('answers protocol errors and never writes logs to stdout', async () => {
    const unknownTool = await mcp.request('tools/call', { name: 'nope', arguments: {} })
    assert.equal(unknownTool.error.code, -32602)
    const unknownMethod = await mcp.request('resources/list', {})
    assert.equal(unknownMethod.error.code, -32601)
    assert.deepEqual((await mcp.request('ping', {})).result, {})
    assert.deepEqual(mcp.bad, [])
  })

  it('marks the login stale when the gateway rejects the token', async () => {
    gw.token = 'rotated'
    const r = await mcp.call('company_whoami')
    assert.equal(r.isError, true)
    assert.match(r.text, /desk-login/)
    assert.equal(readJson(stateFile).needsRelogin, true)
  })
})

describe('mcp background sync', () => {
  it('syncs on start and keeps syncing on the interval once logged in', async () => {
    const dir = tmpDir()
    const gw = await mockGateway()
    const stateFile = path.join(dir, 'valimart-desk.json')
    writeLoggedInState(stateFile, gw.url)
    gw.files.set('_shared/handbook/岗位.md', Buffer.from('手册'))
    const mcp = startMcp({ VALIMART_DESK_STATE: stateFile, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), VALIMART_DRIVE_SYNC_MS: '50' })
    try {
      await mcp.init()
      const snapshots = () => gw.calls.filter((c) => c.path === '/api/drive/snapshot').length
      assert.equal(await waitFor(() => snapshots() >= 2), true, mcp.stderr)
      assert.equal(fs.readFileSync(path.join(dir, 'claude', 'valimart-drive', '_shared/handbook/岗位.md'), 'utf8'), '手册')
      assert.ok(readJson(stateFile).lastSyncAt)
    } finally {
      await mcp.close()
      gw.server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('session context with the drive', () => {
  function runHook(claude) {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: claude }
    delete env.VALIMART_DESK_STATE
    const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'session-context.mjs')], { env, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    return JSON.parse(run.stdout).hookSpecificOutput.additionalContext
  }

  it('adds the drive layout and the bound task card when logged in', () => {
    const dir = tmpDir()
    const claude = path.join(dir, 'claude')
    const card = path.join(claude, 'valimart-drive', 'projects', 'inbox', 'tk-1')
    fs.mkdirSync(card, { recursive: true })
    fs.writeFileSync(path.join(card, '_task-card.json'), JSON.stringify({ id: 'tk-1', status: 'draft', deliverables: [] }))
    fs.writeFileSync(path.join(card, '_task-card.md'), '# 任务卡 tk-1：详情页改版\n')
    fs.writeFileSync(path.join(claude, 'valimart-desk.json'), JSON.stringify({
      sessionToken: 's',
      gatewayToken: 'g',
      user: { username: 'emp-a', displayName: '陈一', role: 'employee' },
      company: { name: '惠利玛' },
      currentTaskId: 'tk-1',
    }))
    const ctx = runHook(claude)
    assert.match(ctx, /企业交付工作台（惠利玛）/)
    assert.match(ctx, /_office\/emp-a\/_memory/)
    assert.match(ctx, /当前绑定任务卡 tk-1/)
    assert.match(ctx, /口头完成不算完成/)
    assert.match(ctx, /下一步：.*company_task_attach/)
    assert.match(ctx, /# 任务卡 tk-1：详情页改版/)
    assert.equal(ctx.includes('不要提任务卡'), false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('does not demand a task card when none is bound', () => {
    const dir = tmpDir()
    const claude = path.join(dir, 'claude')
    fs.mkdirSync(claude, { recursive: true })
    fs.writeFileSync(path.join(claude, 'valimart-desk.json'), JSON.stringify({
      sessionToken: 's',
      gatewayToken: 'g',
      user: { username: 'emp-a', displayName: '陈一', role: 'employee' },
      company: { name: '惠利玛' },
    }))
    const ctx = runHook(claude)
    assert.match(ctx, /企业交付工作台（惠利玛）/)
    assert.match(ctx, /不要提任务卡/)
    assert.equal(ctx.includes('没有任务卡'), false)
    assert.equal(ctx.includes('口头完成不算完成'), false)
    assert.equal(ctx.includes('当前绑定任务卡'), false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('leaves the drive out when nobody is logged in', () => {
    const dir = tmpDir()
    const claude = path.join(dir, 'claude')
    fs.mkdirSync(claude, { recursive: true })
    const ctx = runHook(claude)
    assert.equal(ctx.includes('企业交付工作台'), false)
    assert.match(ctx, /desk-login/)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('mcp manifest', () => {
  it('registers the desk server from the plugin root and keeps versions in step', () => {
    const server = readJson(path.join(root, '.mcp.json')).mcpServers.desk
    assert.equal(server.command, 'node')
    assert.deepEqual(server.args, ['${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs'])
    assert.ok(fs.existsSync(path.join(root, 'scripts', 'mcp-server.mjs')))
    const plugin = readJson(path.join(root, '.claude-plugin', 'plugin.json'))
    assert.equal(readJson(path.join(root, '.claude-plugin', 'marketplace.json')).plugins[0].version, plugin.version)
    assert.equal(readJson(path.join(root, 'package.json')).version, plugin.version)
  })
})
