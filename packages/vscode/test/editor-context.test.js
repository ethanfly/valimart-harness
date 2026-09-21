import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { buildEditorContext, buildChatMessages } from '../src/lib/editor-context.js'

test('context builder includes current file and selection in /v1 payload', () => {
  const workspaceRoot = path.join('E:', 'ws', 'demo')
  const currentFile = path.join(workspaceRoot, 'src', 'app.js')
  const selection = 'UNIQUE_SELECTION_TOKEN_xyz'
  const ctx = buildEditorContext({ currentFile, selection, workspaceRoot })
  assert.equal(ctx.hasSelection, true)
  assert.ok(ctx.text.includes(selection))
  assert.match(ctx.relativePath.replaceAll('\\', '/'), /src\/app\.js/)

  const messages = buildChatMessages({ userPrompt: 'refactor this selection', editorContext: ctx })
  const payload = { model: 'mock-echo', messages }
  const serialized = JSON.stringify(payload)
  assert.ok(serialized.includes(selection))
  assert.ok(payload.messages.some((m) => typeof m.content === 'string' && m.content.includes(selection)))
  assert.ok(payload.messages.some((m) => typeof m.content === 'string' && m.content.includes('app.js')))
  assert.equal(payload.messages[payload.messages.length - 1].role, 'user')
})
