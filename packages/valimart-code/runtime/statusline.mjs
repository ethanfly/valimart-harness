/**
 * Qwen Code 状态栏命令（ui.statusLine）：stdin 是会话 JSON（模型、上下文占用），登录用户来自本机登录态。
 * 只打一行；上下文占用 Qwen Code 自己在右侧显示，这里不重复。
 */
import { loadState } from '../lib/state.mjs'
import { userLine } from '../lib/status.mjs'

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8').trim() || '{}')
  } catch {
    return {}
  }
}

const session = await readStdin()
const state = loadState()
const parts = [userLine(state)]
const model = session?.model?.display_name
if (model) parts.push(model)
if (state.currentTaskId) parts.push(`任务 ${state.currentTaskId}`)
process.stdout.write(`${parts.join(' · ')}\n`)
