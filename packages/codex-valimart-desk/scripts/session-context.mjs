/**
 * Codex SessionStart：注入登录身份、公司盘位置和绑定任务卡。
 * 同时记录 hook 载荷里的 cwd，供 company_task_attach 解析相对路径。
 */
import { companyDrivePrompt } from '../lib/company-prompt.mjs'
import { loadState, saveState } from '../lib/state.mjs'
import { statusText, userLine } from '../lib/whoami.mjs'

function readHookInput() {
  return new Promise((resolve) => {
    let raw = ''
    const done = () => resolve(raw)
    process.stdin.on('data', (chunk) => { raw += chunk; if (raw.length > 1024 * 1024) done() })
    process.stdin.once('end', done)
    setTimeout(done, 250).unref()
  })
}

const raw = await readHookInput()
let payload = {}
try { payload = JSON.parse(raw) } catch { /* 旧版本可能没有 stdin */ }
const cwd = payload.cwd || payload.workspace?.cwd || payload.projectDir
if (cwd && cwd !== loadState().projectDir) saveState({ projectDir: cwd })

const state = loadState()
const lines = ['valimart codex desk 已加载。', statusText(state)]
if (!state.sessionToken) lines.push('尚未登录公司网关。退出后运行：node <插件目录>/scripts/cli.mjs login')
const drive = companyDrivePrompt(state)
if (drive) lines.push('', drive)

process.stdout.write(`${JSON.stringify({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') },
  systemMessage: userLine(state),
})}\n`, () => process.exit(0))
