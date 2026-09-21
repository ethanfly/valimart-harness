import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TokenStore } from '../src/lib/token-store.js'
import { GatewayClient } from '../src/lib/gateway-client.js'
import { applyWrite, applyPatch, createWorkspaceTools } from '../src/lib/workspace-fs.js'
import { runAgentLoop, normalizeAssistantMessage, serializeToolResult, TOOL_RESULT_LIMIT } from '../src/lib/agent-loop.js'
import { startStubModelServer, startScriptedModelServer } from './helpers/start-gateway.js'

test('applyWrite writes real bytes on disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ws-'))
  const rel = path.join('src', 'hello.txt')
  applyWrite(root, rel, 'alpha-bytes-42')
  const onDisk = fs.readFileSync(path.join(root, rel), 'utf8')
  assert.equal(onDisk, 'alpha-bytes-42')
  fs.rmSync(root, { recursive: true, force: true })
})

test('applyPatch replaces oldText with newText on disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ws-'))
  const rel = 'note.md'
  applyWrite(root, rel, 'hello WORLD today')
  applyPatch(root, rel, 'WORLD', 'workspace')
  assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), 'hello workspace today')
  fs.rmSync(root, { recursive: true, force: true })
})

test('agent loop with stub model tool-call writes the target file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ws-'))
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-st-'))
  const rel = path.join('out', 'agent-target.txt')
  const contents = 'written-by-shipped-loop'
  const stub = await startStubModelServer({
    toolCall: {
      id: 'call_write_1',
      type: 'function',
      function: {
        name: 'write_file',
        arguments: JSON.stringify({ path: rel.replaceAll('\\', '/'), contents }),
      },
    },
    thenText: 'created the file.',
  })
  const store = new TokenStore(stateDir)
  store.setLogin({
    gatewayUrl: stub.baseUrl,
    sessionToken: 'sess_stub',
    gatewayToken: 'dgw_stub',
    user: { username: 'boss' },
    company: { models: [{ id: 'mock-echo' }], defaultModel: 'mock-echo' },
  })
  const client = new GatewayClient(store)
  const tools = createWorkspaceTools({ workspaceRoot: root })
  const result = await runAgentLoop({
    client,
    tools,
    model: 'mock-echo',
    userMessage: 'write the target file',
  })
  assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), contents)
  assert.ok(result.applied.some((a) => a.name === 'write_file'))
  assert.match(result.text, /created the file/)
  await stub.close()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('agent loop apply_patch tool-call changes existing file bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ws-'))
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-st-'))
  const rel = 'patch-me.js'
  applyWrite(root, rel, 'const n = 1\n')
  const stub = await startStubModelServer({
    toolCall: {
      id: 'call_patch_1',
      type: 'function',
      function: {
        name: 'apply_patch',
        arguments: JSON.stringify({ path: rel, oldText: 'const n = 1', newText: 'const n = 99' }),
      },
    },
    thenText: 'patched.',
  })
  const store = new TokenStore(stateDir)
  store.setLogin({
    gatewayUrl: stub.baseUrl,
    sessionToken: 'sess_stub',
    gatewayToken: 'dgw_stub',
    user: { username: 'boss' },
    company: { models: [{ id: 'mock-echo' }] },
  })
  const result = await runAgentLoop({
    client: new GatewayClient(store),
    tools: createWorkspaceTools({ workspaceRoot: root }),
    model: 'mock-echo',
    userMessage: 'bump n',
  })
  assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), 'const n = 99\n')
  assert.ok(result.applied.some((a) => a.name === 'apply_patch'))
  await stub.close()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
})

/* ── 「跑完工具就没了」回归：循环必须有可见答复 ───────────────────────── */

const toolCallMsg = (name, args, id) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
})

function stubClient(baseUrl) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-st-'))
  const store = new TokenStore(stateDir)
  store.setLogin({
    gatewayUrl: baseUrl,
    sessionToken: 'sess',
    gatewayToken: 'dgw',
    user: { username: 'boss' },
    company: { models: [{ id: 'mock-echo' }], defaultModel: 'mock-echo' },
  })
  return { client: new GatewayClient(store), stateDir }
}

test('工具轮次用尽时不抛错，改用无工具收尾请求给出进度答复', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ws-'))
  const stub = await startScriptedModelServer((body) =>
    body.tools ? toolCallMsg('list_dir', { path: '.' }) : { role: 'assistant', content: '已经读了 3 次目录，还差改文件。' },
  )
  const { client, stateDir } = stubClient(stub.baseUrl)
  const result = await runAgentLoop({
    client,
    tools: createWorkspaceTools({ workspaceRoot: root }),
    model: 'mock-echo',
    userMessage: 'go',
    maxTurns: 3,
  })
  assert.equal(result.stopReason, 'max_turns')
  assert.match(result.text, /还差改文件/)
  assert.equal(stub.bodies.length, 4, '3 个工具轮 + 1 个无工具收尾')
  assert.equal(stub.bodies[3].tools, undefined, '收尾请求不能再带 tools')
  assert.equal(stub.bodies[0].stream, true, '工作台对照参考项目走 SSE；桩服务仍回 JSON')
  assert.equal(stub.bodies[0].messages.filter((m) => m.role === 'tool').length, 0)
  await stub.close()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('maxTurns=0 不限制轮次，模型自己停才结束', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ws-'))
  let n = 0
  const stub = await startScriptedModelServer(() => {
    n += 1
    return n < 6
      ? toolCallMsg('list_dir', { path: '.' }, `c${n}`)
      : { role: 'assistant', content: '做完了' }
  })
  const { client, stateDir } = stubClient(stub.baseUrl)
  const result = await runAgentLoop({
    client,
    tools: createWorkspaceTools({ workspaceRoot: root }),
    model: 'mock-echo',
    userMessage: 'go',
    maxTurns: 0,
  })
  assert.equal(result.stopReason, 'stop')
  assert.equal(result.text, '做完了')
  assert.equal(n, 6)
  await stub.close()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('收尾请求也失败时，本地兜底答复仍然说明改了什么', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ws-'))
  const client = {
    async chatCompletions(body) {
      if (body.tools) {
        return {
          choices: [
            {
              message: toolCallMsg('write_file', { path: 'a.txt', contents: 'x' }, 'c1'),
              finish_reason: 'tool_calls',
            },
          ],
        }
      }
      throw new Error('gateway down')
    },
  }
  const result = await runAgentLoop({
    client,
    tools: createWorkspaceTools({ workspaceRoot: root }),
    model: 'mock-echo',
    userMessage: 'go',
    maxTurns: 2,
  })
  assert.match(result.text, /上限/)
  assert.match(result.text, /a\.txt/)
  assert.ok(result.applied.some((a) => a.path === 'a.txt'))
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'x')
  fs.rmSync(root, { recursive: true, force: true })
})

test('重发给网关的历史被洗白：只留 role/content/tool_calls，超长工具结果截断', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ws-'))
  applyWrite(root, 'big.txt', 'x'.repeat(200_000))
  const stub = await startScriptedModelServer((body, i) =>
    i === 0
      ? {
          ...toolCallMsg('read_file', { path: 'big.txt' }),
          reasoning_content: '不该回放的私有字段',
          annotations: [{ type: 'x' }],
          index: 0,
        }
      : { role: 'assistant', content: '读完了' },
  )
  const { client, stateDir } = stubClient(stub.baseUrl)
  await runAgentLoop({
    client,
    tools: createWorkspaceTools({ workspaceRoot: root }),
    model: 'mock-echo',
    userMessage: 'read big',
  })
  const resend = stub.bodies[1]
  const assistant = resend.messages.find((m) => m.role === 'assistant')
  assert.deepEqual(Object.keys(assistant).sort(), ['content', 'role', 'tool_calls'])
  assert.equal(assistant.reasoning_content, undefined)
  assert.equal(assistant.tool_calls[0].id, 'call_0_0', '缺 id 时补一个，避免 tool_call_id 对不上')
  const toolMsg = resend.messages.find((m) => m.role === 'tool')
  assert.ok(toolMsg.content.length <= TOOL_RESULT_LIMIT + 200, `tool content 应被截断，实际 ${toolMsg.content.length}`)
  assert.match(toolMsg.content, /已截断/)
  await stub.close()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('模型回空内容时不留空气泡，转成可见说明', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ws-'))
  const stub = await startScriptedModelServer([{ role: 'assistant', content: '   ' }])
  const { client, stateDir } = stubClient(stub.baseUrl)
  const result = await runAgentLoop({
    client,
    tools: createWorkspaceTools({ workspaceRoot: root }),
    model: 'mock-echo',
    userMessage: 'hi',
  })
  assert.match(result.text, /模型没有返回文字说明/)
  await stub.close()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('网关返回空 choices 时明确报错而不是无限等待', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ws-'))
  const client = { chatCompletions: async () => ({ id: 'x', choices: [] }) }
  await assert.rejects(
    () =>
      runAgentLoop({
        client,
        tools: createWorkspaceTools({ workspaceRoot: root }),
        model: 'mock-echo',
        userMessage: 'hi',
      }),
    /choices 为空/,
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('墙钟超时同样收尾，不再无限制调用工具', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ws-'))
  const client = {
    async chatCompletions(body) {
      if (body.tools) return { choices: [{ message: toolCallMsg('list_dir', { path: '.' }, 'c1'), finish_reason: 'tool_calls' }] }
      return { choices: [{ message: { role: 'assistant', content: '时间到了，先汇报进度。' }, finish_reason: 'stop' }] }
    },
  }
  const result = await runAgentLoop({
    client,
    tools: createWorkspaceTools({ workspaceRoot: root }),
    model: 'mock-echo',
    userMessage: 'go',
    maxTurns: 5,
    maxElapsedMs: -1,
  })
  assert.equal(result.stopReason, 'elapsed')
  assert.match(result.text, /汇报进度/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('normalizeAssistantMessage/serializeToolResult 单元行为', () => {
  const { out, calls } = normalizeAssistantMessage({ role: 'assistant', content: null, tool_calls: [{ function: { name: 'x' } }] }, 2)
  assert.deepEqual(Object.keys(out).sort(), ['content', 'role', 'tool_calls'])
  assert.equal(out.content, null)
  assert.equal(calls[0].id, 'call_2_0')
  assert.equal(calls[0].function.arguments, '{}')
  assert.equal(serializeToolResult(undefined), '{"ok":true}')
  assert.equal(serializeToolResult({ a: 1 }), '{"a":1}')
  assert.ok(serializeToolResult('z'.repeat(30_000)).includes('已截断'))
})
