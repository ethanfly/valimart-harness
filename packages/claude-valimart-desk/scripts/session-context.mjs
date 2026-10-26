/**
 * SessionStart：把当前登录用户附加到本会话上下文。
 * 不写 settings.json，不碰 OMC 的 hook。超时由 hooks.json 限在 5 秒。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { statuslineOwner } from '../lib/omc.mjs'
import { claudeHome, loadState } from '../lib/state.mjs'
import { statusText, userLine } from '../lib/whoami.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const state = loadState()
const owner = statuslineOwner(claudeHome())
const lines = [
  'valimart claude desk 已加载。',
  statusText(state),
]
if (owner.owner === 'omc') {
  lines.push('oh-my-claudecode 已安装：保持它的状态栏。当前用户用 /valimart-desk:desk-hud 接一行到它的 HUD，不要替换 statusLine。')
} else if (owner.owner === 'other') {
  lines.push('已有别人的状态栏，本插件不覆盖。要看登录用户，把 scripts/statusline.mjs 的输出拼到那个脚本末尾，或运行 /valimart-desk:desk-status。')
} else if (owner.owner === 'none') {
  lines.push(`状态栏还空着。可把 command 指到 node "${root.replace(/\\/g, '/')}/scripts/statusline.mjs"（只在没有 OMC 时）。`)
}
if (!state.sessionToken) lines.push('尚未登录公司网关。用 /valimart-desk:desk-login。')

process.stdout.write(`${JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: lines.join('\n'),
  },
  systemMessage: userLine(state),
})}\n`)
