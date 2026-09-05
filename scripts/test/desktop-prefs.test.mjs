import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { readDesktopPrefs, writeDesktopPrefs, resolveCloseChoice, closePromptToResponse } = require('../../desktop/prefs.cjs')

test('readDesktopPrefs：缺文件或坏 JSON 都是 ask', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-prefs-'))
  const file = path.join(dir, 'desktop.json')
  assert.deepEqual(readDesktopPrefs({ file }), { closeAction: 'ask' })
  fs.writeFileSync(file, '{')
  assert.deepEqual(readDesktopPrefs({ file }), { closeAction: 'ask' })
  fs.writeFileSync(file, JSON.stringify({ closeAction: 'nope' }))
  assert.deepEqual(readDesktopPrefs({ file }), { closeAction: 'ask' })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('writeDesktopPrefs：只接受 ask / minimize / quit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-prefs-'))
  const file = path.join(dir, 'desktop.json')
  assert.deepEqual(writeDesktopPrefs({ closeAction: 'minimize' }, { file }), { closeAction: 'minimize' })
  assert.deepEqual(readDesktopPrefs({ file }), { closeAction: 'minimize' })
  assert.deepEqual(writeDesktopPrefs({ closeAction: 'boom' }, { file }), { closeAction: 'ask' })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('resolveCloseChoice：已记住的策略不再问', () => {
  assert.deepEqual(resolveCloseChoice('minimize'), { do: 'minimize', save: null })
  assert.deepEqual(resolveCloseChoice('quit'), { do: 'quit', save: null })
})

test('closePromptToResponse：自绘弹窗动作对齐 ask 编号', () => {
  assert.equal(closePromptToResponse('minimize'), 0)
  assert.equal(closePromptToResponse('quit'), 1)
  assert.equal(closePromptToResponse('cancel'), 2)
  assert.equal(closePromptToResponse('nope'), 2)
})

test('resolveCloseChoice：询问时可记住', () => {
  assert.deepEqual(resolveCloseChoice('ask', { response: 0, remember: false }), { do: 'minimize', save: null })
  assert.deepEqual(resolveCloseChoice('ask', { response: 1, remember: true }), { do: 'quit', save: 'quit' })
  assert.deepEqual(resolveCloseChoice('ask', { response: 2 }), { do: 'cancel', save: null })
  assert.deepEqual(resolveCloseChoice('ask', {}), { do: 'cancel', save: null })
})
