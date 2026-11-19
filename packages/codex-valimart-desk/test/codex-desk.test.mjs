import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { after, before, describe, it } from 'node:test'
import { parseDeskLoginArgs } from '../lib/login-args.mjs'
import { assertDecision, canFinalize, canReview, canSubmit, hasDeliverables, reviewerOptions, workflowHint } from '../lib/task-workflow.mjs'
import { peopleOptions, personIdFromChoice } from '../lib/people-options.mjs'
import { zoneRoot } from '../lib/drive-paths.mjs'
import { isLoggedIn, loadState, publicView, saveState, statePath } from '../lib/state.mjs'
import { callTool, listTools, TOOL_NAMES } from '../lib/tools.mjs'
import { companyDrivePrompt, MCP_INSTRUCTIONS } from '../lib/company-prompt.mjs'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

function jsonRpc(request) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(root, 'scripts/mcp-server.mjs')], {
      env: { ...process.env, VALIMART_DRIVE_SYNC_MS: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    let errors = ''
    child.stderr.on('data', (chunk) => { errors += chunk })
    let settled = false
    const finish = (action) => {
      if (settled) return
      settled = true
      action()
    }
    const timer = setTimeout(() => finish(() => {
      child.kill()
      reject(new Error(`MCP 调用超时：${output || '<no output>'}${errors ? `\nstderr: ${errors}` : ''}`))
    }), 3000)
    child.stdout.on('data', (chunk) => {
      output += chunk
      for (const line of output.split('\n')) {
        if (!line.trim()) continue
        try {
          const message = JSON.parse(line)
          if (message.id === request.id) {
            finish(() => {
              clearTimeout(timer)
              child.kill()
              resolve({ message, errors })
            })
          }
        } catch { /* 等下一行 */ }
      }
    })
    child.on('error', reject)
    child.on('close', () => finish(() => {
      clearTimeout(timer)
      reject(new Error(`MCP 提前退出：${output || '<no output>'}${errors ? `\nstderr: ${errors}` : ''}`))
    }))
    child.stdin.write(`${JSON.stringify(request)}\n`)
  })
}

describe('codex desk state and workflow', () => {
  it('keeps login tokens in CODEX_HOME and hides them from publicView', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desk-'))
    process.env.CODEX_HOME = home
    try {
      const saved = saveState({
        gatewayUrl: 'http://127.0.0.1:18791',
        sessionToken: 'session-secret',
        gatewayToken: 'gateway-secret',
        user: { id: 'u1', username: 'emp-a', displayName: '员工A', role: 'employee' },
        company: { id: 'c1', name: 'Acme' },
      })
      assert.equal(statePath(), path.join(home, 'valimart-desk.json'))
      assert.equal(isLoggedIn(saved), true)
      const view = publicView(loadState())
      assert.equal(view.user.username, 'emp-a')
      assert.equal(JSON.stringify(view).includes('session-secret'), false)
      assert.equal(JSON.stringify(view).includes('gateway-secret'), false)
    } finally { delete process.env.CODEX_HOME }
  })

  it('uses codex home for the drive and returns the company prompt only when logged in', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-prompt-'))
    process.env.CODEX_HOME = home
    try {
      assert.equal(companyDrivePrompt(), '')
      saveState({
        sessionToken: 's', gatewayToken: 'g',
        user: { username: 'emp-a', displayName: '员工A', role: 'employee' },
        company: { name: 'Acme' }, currentTaskId: 'tk-1',
      })
      const prompt = companyDrivePrompt()
      assert.match(prompt, new RegExp(path.join(home, 'valimart-drive')))
      assert.match(prompt, /tk-1/)
    } finally { delete process.env.CODEX_HOME }
  })

  it('maps zones and validates the four-step workflow', () => {
    assert.equal(zoneRoot('personal', 'emp-a'), '_office/emp-a/_memory')
    assert.equal(zoneRoot('shared', 'emp-a'), '_shared/_memory')
    assert.equal(zoneRoot('handbook', 'emp-a'), '_shared/handbook')
    const emp = { id: 'u1', username: 'emp-a', role: 'employee' }
    const boss = { id: 'u2', username: 'boss', role: 'admin' }
    const reviewer = { id: 'u3', username: 'reviewer', role: 'director' }
    const task = { status: 'draft', assigneeId: 'u1', reviewerId: 'u3', assignerId: 'u3', deliverables: [{ name: 'a' }] }
    assert.deepEqual(reviewerOptions([emp, boss, reviewer], emp).map((item) => item.id), ['u2', 'u3'])
    assert.equal(canSubmit(task, emp), true)
    assert.equal(canReview({ ...task, status: 'pending_review' }, reviewer), true)
    assert.equal(canFinalize({ ...task, status: 'pending_final' }, boss), true)
    assert.equal(hasDeliverables(task), true)
    assert.equal(assertDecision('pass'), 'pass')
    assert.throws(() => assertDecision('ok'))
    assert.match(workflowHint(task), /company_task_submit/)
  })

  it('keeps self first and maps labels back to ids', () => {
    const me = { id: 'u1', username: 'emp-a', displayName: '员工A' }
    const other = { id: 'u2', username: 'boss', displayName: '老板' }
    const options = peopleOptions([other, me], me, { employeesSelfOnly: false })
    assert.equal(options[0].id, 'u1')
    assert.equal(personIdFromChoice(options[1].label, options), 'u2')
  })

  it('reads login credentials from args and env only', () => {
    const parsed = parseDeskLoginArgs('http://127.0.0.1:8790 emp-a', { DESK_GATEWAY_PASSWORD: 'secret' })
    assert.equal(parsed.url, 'http://127.0.0.1:8790')
    assert.equal(parsed.username, 'emp-a')
    assert.equal(parsed.password, 'secret')
  })
})

describe('codex MCP shell', () => {
  let server
  let baseUrl
  let home

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/auth/me' && req.headers.authorization === 'Bearer session-secret') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ user: { id: 'u1', username: 'emp-a', displayName: '员工A', role: 'employee' }, company: { id: 'c1', name: 'Acme' }, quota: [] }))
        return
      }
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'unauthorized', message: '未登录' } }))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mcp-'))
    process.env.CODEX_HOME = home
    saveState({ gatewayUrl: baseUrl, sessionToken: 'session-secret', gatewayToken: 'gateway-secret', user: { id: 'u1', username: 'old', role: 'employee' }, company: { name: 'Old' } })
  })

  after(() => {
    delete process.env.CODEX_HOME
    return new Promise((resolve) => server.close(resolve))
  })

  it('lists the company drive and task tools', async () => {
    const response = await jsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    assert.equal(response.message.result.tools.length, TOOL_NAMES.length)
    for (const name of ['company_knowledge', 'company_memory_write', 'company_drive_sync', 'company_task_submit']) assert.ok(TOOL_NAMES.includes(name))
  })

  it('calls whoami through the gateway and keeps tokens out of the result', async () => {
    const response = await jsonRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'company_whoami', arguments: {} } })
    assert.equal(response.message.result.isError, false, `${JSON.stringify(response.message)}\n${response.errors}`)
    const text = response.message.result.content[0].text
    assert.match(text, /emp-a/)
    assert.equal(text.includes('session-secret'), false)
    assert.equal(loadState().user.username, 'emp-a')
  })

  it('passes tool errors back as MCP results', async () => {
    const response = await jsonRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'company_task_attach', arguments: { paths: ['missing.txt'] } } })
    assert.equal(response.message.result.isError, true)
    assert.match(response.message.result.content[0].text, /当前没有绑定任务卡/)
  })

  it('exposes MCP instructions and all expected manifests', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'), 'utf8'))
    const marketplace = JSON.parse(fs.readFileSync(path.join(root, '.agents/plugins/marketplace.json'), 'utf8'))
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'))
    assert.equal(manifest.name, marketplace.plugins[0].name)
    assert.equal(manifest.mcpServers, './.mcp.json')
    assert.equal(mcp.mcpServers.desk.command, 'node')
    assert.match(fs.readFileSync(path.join(root, 'skills/company-briefing/SKILL.md'), 'utf8'), /name: company-briefing/)
    assert.match(MCP_INSTRUCTIONS, /company_knowledge/)
  })
})

describe('npm distribution', () => {
  it('publishes the plugin root and executable wrapper', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    assert.equal(manifest.private, undefined)
    assert.equal(manifest.bin['codex-valimart-desk'], 'bin/cli.mjs')
    for (const item of ['.agents', '.codex-plugin', '.mcp.json', 'bin', 'hooks', 'lib', 'scripts', 'skills']) assert.ok(manifest.files.includes(item), item)
    const bin = path.join(root, 'bin/cli.mjs')
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bin, '--marketplace-path'])
      let output = ''
      child.stdout.on('data', (chunk) => { output += chunk })
      child.on('close', (status) => resolve({ status, output }))
      child.on('error', reject)
    })
    assert.equal(result.status, 0)
    assert.equal(result.output.trim(), root)
    assert.ok(fs.existsSync(path.join(root, 'skills/company-briefing/SKILL.md')))
  })
})
