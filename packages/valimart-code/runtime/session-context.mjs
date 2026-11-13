/**
 * SessionStart hook：把登录身份、公司盘镜像和绑定的任务卡交给模型（开新会话、/resume、/clear、压缩后都会跑）。
 * 只读本机文件、不走网络；stdout 只写一份 hook JSON。
 */
import { companyDrivePrompt } from '../lib/company-prompt.mjs'
import { isLoggedIn, loadState } from '../lib/state.mjs'
import { statusText } from '../lib/status.mjs'

const state = loadState()
const lines = ['你运行在 valimart code 里：惠利玛工作交付平台的终端客户端，模型请求都经公司网关。', statusText(state)]
if (!isLoggedIn(state)) lines.push('尚未登录公司网关：让用户 /quit 后运行 valimart login。')
const drive = companyDrivePrompt(state)
if (drive) lines.push('', drive)

process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } })}\n`)
