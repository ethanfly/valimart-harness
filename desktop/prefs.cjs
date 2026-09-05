/**
 * 桌面壳本机偏好：~/.company-desk/desktop.json
 * closeAction: ask（关窗询问）| minimize（后台）| quit（退出）
 */
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CLOSE_ACTIONS = ['ask', 'minimize', 'quit']

function prefsPath(home = os.homedir()) {
  return path.join(home, '.company-desk', 'desktop.json')
}

function normalize(raw) {
  const closeAction = CLOSE_ACTIONS.includes(raw?.closeAction) ? raw.closeAction : 'ask'
  return { closeAction }
}

function readDesktopPrefs({ file, home } = {}) {
  try {
    return normalize(JSON.parse(fs.readFileSync(file || prefsPath(home), 'utf8')))
  } catch {
    return normalize(null)
  }
}

function writeDesktopPrefs(patch, { file, home } = {}) {
  const dest = file || prefsPath(home)
  const next = normalize({ ...readDesktopPrefs({ file: dest }), ...patch })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

/** 自绘弹窗动作 → 与原生对话框相同的 response 编号。 */
function closePromptToResponse(action) {
  if (action === 'minimize') return 0
  if (action === 'quit') return 1
  return 2
}

/** 关窗决策。ask 时 response：0 后台 / 1 退出 / 2 取消。 */
function resolveCloseChoice(action, { response, remember } = {}) {
  if (action === 'minimize') return { do: 'minimize', save: null }
  if (action === 'quit') return { do: 'quit', save: null }
  if (response !== 0 && response !== 1) return { do: 'cancel', save: null }
  const choice = response === 0 ? 'minimize' : 'quit'
  return { do: choice, save: remember ? choice : null }
}

module.exports = { CLOSE_ACTIONS, prefsPath, readDesktopPrefs, writeDesktopPrefs, resolveCloseChoice, closePromptToResponse }
