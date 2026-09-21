import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TokenStore } from '../src/lib/token-store.js'
import { GatewayClient } from '../src/lib/gateway-client.js'
import { SessionController } from '../src/session.js'
import { startStubModelServer } from './helpers/start-gateway.js'

test('/goal loop stops because the workspace condition held', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ws-'))
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-st-'))
  const rel = 'goal-done.txt'
  const stub = await startStubModelServer({
    toolCall: {
      id: 'call_goal',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ path: rel, contents: 'ok' }) },
    },
    thenText: 'wrote the goal file',
  })
  const store = new TokenStore(stateDir)
  store.setLogin({
    gatewayUrl: stub.baseUrl,
    sessionToken: 'sess',
    gatewayToken: 'dgw',
    user: { username: 'boss' },
    company: { models: [{ id: 'mock-echo' }] },
  })
  const session = new SessionController({
    store,
    client: new GatewayClient(store),
    getWorkspaceRoot: () => root,
  })
  session.handleSlash('/goal file goal-done.txt exists')
  assert.equal(session.goal.condition, 'file goal-done.txt exists')
  const result = await session.runGoal()
  assert.equal(result.stopped, 'condition_held')
  assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), 'ok')
  await stub.close()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
})
