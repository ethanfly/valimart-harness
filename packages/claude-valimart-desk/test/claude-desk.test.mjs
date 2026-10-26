import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it, before, after } from 'node:test'
import {
  anthropicMessageToOpenAI,
  createOpenAIToAnthropicStream,
  toAnthropicMessage,
  toOpenAIBody,
} from '../lib/anthropic-bridge.mjs'
import { startBridge } from '../lib/bridge-server.mjs'
import { findOmc, statuslineOwner } from '../lib/omc.mjs'
import { isLoggedIn, loadState, publicView, saveState } from '../lib/state.mjs'
import { hudLine, statusText, userLine } from '../lib/whoami.mjs'

const root = path.resolve(import.meta.dirname, '..')

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'valimart-claude-'))
}

describe('whoami', () => {
  it('shows the signed-in user and stays silent about tokens', () => {
    const state = {
      sessionToken: 'session-secret',
      gatewayToken: 'gateway-secret',
      user: { displayName: '陈一', username: 'emp-a', role: 'employee' },
      company: { name: '惠利玛' },
      quota: [{ label: '本周', kind: 'cny', usedCny: 3, limitCny: 50, usedPct: 6 }],
    }
    assert.equal(userLine(state), 'valimart 陈一 (emp-a) · employee @惠利玛')
    assert.match(hudLine(state), /陈一.*本周 3\/50 元 6%/)
    assert.equal(statusText(state).includes('session-secret'), false)
    assert.equal(userLine({ needsRelogin: true }), 'valimart 需重新登录')
    assert.equal(userLine({}), 'valimart 未登录')
  })
})

describe('state', () => {
  let dir
  const prev = process.env.VALIMART_DESK_STATE
  before(() => {
    dir = tmpDir()
    process.env.VALIMART_DESK_STATE = path.join(dir, 'valimart-desk.json')
  })
  after(() => {
    if (prev === undefined) delete process.env.VALIMART_DESK_STATE
    else process.env.VALIMART_DESK_STATE = prev
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('stores the session and gateway tokens but publicView omits them', () => {
    saveState({
      sessionToken: 's',
      gatewayToken: 'g',
      user: { username: 'emp-a', displayName: '陈一' },
      company: { name: '惠利玛', models: [{ id: 'grok' }] },
    })
    assert.equal(isLoggedIn(), true)
    const view = publicView(loadState())
    assert.equal(view.loggedIn, true)
    assert.equal(view.user.username, 'emp-a')
    assert.equal(JSON.stringify(view).includes('"s"'), false)
    const raw = JSON.parse(fs.readFileSync(process.env.VALIMART_DESK_STATE, 'utf8'))
    assert.equal(raw.gatewayToken, 'g')
  })
})

describe('anthropic bridge', () => {
  it('turns a Claude Code tool turn into OpenAI chat completions', () => {
    const body = toOpenAIBody({
      model: 'grok-4.7',
      max_tokens: 800,
      stream: true,
      system: '按公司流程',
      tools: [{ name: 'company_tasks', description: '列任务', input_schema: { type: 'object', properties: {} } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: '我的任务' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'company_tasks', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '没有卡' }] },
      ],
    })
    assert.equal(body.model, 'grok-4.7')
    assert.equal(body.stream, true)
    assert.equal(body.messages[0].role, 'system')
    assert.equal(body.messages[2].tool_calls[0].id, 'toolu_1')
    assert.equal(body.messages[3].role, 'tool')
    assert.equal(body.tools[0].function.name, 'company_tasks')
  })

  it('keeps tool_use when the gateway answers with tool_calls', () => {
    const message = toAnthropicMessage({
      id: 'chatcmpl-1',
      model: 'grok-4.7',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'company_tasks', arguments: '{}' } }],
        },
      }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    })
    assert.equal(message.stop_reason, 'tool_use')
    assert.equal(message.content.at(-1).type, 'tool_use')
    assert.equal(message.content.at(-1).name, 'company_tasks')
    assert.equal(message.usage.input_tokens, 4)
  })

  it('streams OpenAI chunks as Anthropic events', () => {
    const stream = createOpenAIToAnthropicStream({ model: 'grok-4.7' })
    const start = stream.start('msg_1')
    const mid = stream.push(
      `data: ${JSON.stringify({ id: 'chatcmpl-1', choices: [{ delta: { content: '你好' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}\n\n`,
    )
    const end = stream.end()
    assert.match(start, /message_start/)
    assert.match(mid, /text_delta/)
    assert.match(mid, /你好/)
    assert.match(end.text, /end_turn/)
    assert.match(end.text, /message_stop/)
    assert.equal(end.usage.output_tokens, 1)
  })

  it('drops an empty user message instead of inventing a role', () => {
    assert.deepEqual(anthropicMessageToOpenAI({ role: 'user', content: [] }), [])
  })
})

describe('omc coexistence', () => {
  it('does not claim the status line when oh-my-claudecode is installed', () => {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({
      plugins: { 'oh-my-claudecode@omc': { version: '5.6.2' } },
    }))
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: 'node ~/.claude/hud/omc.mjs' },
    }))
    const owner = statuslineOwner(dir)
    assert.equal(owner.owner, 'omc')
    assert.equal(owner.ours, false)
    assert.equal(findOmc(dir).length, 1)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('leaves a foreign status line alone and recognizes its own', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: 'node C:/plugins/claude-valimart-desk/scripts/statusline.mjs' },
    }))
    assert.equal(statuslineOwner(dir).owner, 'valimart')
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: 'jq -r .model.id' },
    }))
    assert.equal(statuslineOwner(dir).owner, 'other')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('bridge server', () => {
  it('rejects /v1/messages until someone has logged in', async () => {
    const dir = tmpDir()
    const prev = process.env.VALIMART_DESK_STATE
    process.env.VALIMART_DESK_STATE = path.join(dir, 'none.json')
    const started = await startBridge({ port: 0 })
    try {
      const res = await fetch(`${started.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'grok', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
      })
      assert.equal(res.status, 401)
      const body = await res.json()
      assert.match(body.error.message, /desk-login/)
    } finally {
      started.server.close()
      if (prev === undefined) delete process.env.VALIMART_DESK_STATE
      else process.env.VALIMART_DESK_STATE = prev
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('forwards a message to the company gateway and returns Anthropic shape', async () => {
    const dir = tmpDir()
    const prev = process.env.VALIMART_DESK_STATE
    process.env.VALIMART_DESK_STATE = path.join(dir, 'desk.json')
    let seen = null
    const gateway = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-9',
        model: seen.body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '已登录的是陈一' } }],
        usage: { prompt_tokens: 5, completion_tokens: 4 },
      }))
    })
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
    const gatewayPort = gateway.address().port
    saveState({
      gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
      sessionToken: 'session',
      gatewayToken: 'gateway-token',
      user: { username: 'emp-a', displayName: '陈一' },
      defaultModel: 'grok-4.7',
    })
    const started = await startBridge({ port: 0 })
    try {
      const res = await fetch(`${started.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer valimart-gateway' },
        body: JSON.stringify({ max_tokens: 16, messages: [{ role: 'user', content: '我是谁' }] }),
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.role, 'assistant')
      assert.equal(body.content[0].text, '已登录的是陈一')
      assert.equal(seen.auth, 'Bearer gateway-token')
      assert.equal(seen.body.model, 'grok-4.7')
      assert.equal(seen.url, '/v1/chat/completions')
    } finally {
      started.server.close()
      gateway.close()
      if (prev === undefined) delete process.env.VALIMART_DESK_STATE
      else process.env.VALIMART_DESK_STATE = prev
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('scripts', () => {
  it('statusline prints the signed-in user from local state, not from stdin', () => {
    const dir = tmpDir()
    const stateFile = path.join(dir, 'valimart-desk.json')
    fs.writeFileSync(stateFile, JSON.stringify({
      sessionToken: 's',
      gatewayToken: 'g',
      user: { displayName: '陈一', username: 'emp-a', role: 'employee' },
      company: { name: '惠利玛' },
    }))
    const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'statusline.mjs')], {
      input: JSON.stringify({ model: { display_name: 'Grok' }, context_window: { used_percentage: 12 } }),
      env: { ...process.env, VALIMART_DESK_STATE: stateFile },
      encoding: 'utf8',
    })
    assert.equal(run.status, 0)
    assert.match(run.stdout, /陈一 \(emp-a\)/)
    assert.match(run.stdout, /Grok/)
    assert.match(run.stdout, /上下文 12%/)
    assert.equal(run.stdout.includes('gateway'), false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('session start reports the user and refuses to take an OMC status line', () => {
    const dir = tmpDir()
    const claude = path.join(dir, 'claude')
    fs.mkdirSync(path.join(claude, 'plugins'), { recursive: true })
    fs.writeFileSync(path.join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({
      plugins: { 'oh-my-claudecode@omc': {} },
    }))
    fs.writeFileSync(path.join(claude, 'valimart-desk.json'), JSON.stringify({
      sessionToken: 's',
      gatewayToken: 'g',
      user: { displayName: '陈一', username: 'emp-a' },
    }))
    const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'session-context.mjs')], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: claude },
      encoding: 'utf8',
    })
    assert.equal(run.status, 0)
    const payload = JSON.parse(run.stdout)
    assert.match(payload.hookSpecificOutput.additionalContext, /陈一/)
    assert.match(payload.hookSpecificOutput.additionalContext, /oh-my-claudecode/)
    assert.match(payload.hookSpecificOutput.additionalContext, /不要替换 statusLine/)
    assert.equal(payload.systemMessage.includes('陈一'), true)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('manifest', () => {
  it('keeps a name OMC will not treat as its own and only adds a SessionStart hook', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'))
    const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'))
    assert.equal(manifest.name, 'valimart-desk')
    assert.equal(Object.keys(hooks.hooks).join(), 'SessionStart')
    assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /session-context\.mjs/)
    for (const file of fs.readdirSync(path.join(root, 'commands'))) {
      assert.match(file, /^desk-.*\.md$/)
    }
  })
})
