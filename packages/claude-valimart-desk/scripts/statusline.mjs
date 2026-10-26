/**
 * Claude Code 状态栏命令。
 * stdin 是会话 JSON（模型、上下文占用）；登录用户来自本机登录态，不进 stdin。
 * 只打一行到 stdout。调用方没把它配进 settings.json 时，它什么都不改。
 */
import { loadState } from '../lib/state.mjs'
import { hudLine } from '../lib/whoami.mjs'

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

const session = await readStdin()
const model = session?.model?.display_name || session?.model?.id || ''
const used = session?.context_window?.used_percentage
const ctx = used == null ? '' : ` · 上下文 ${used}%`
const modelPart = model ? ` · ${model}` : ''
process.stdout.write(`${hudLine(loadState())}${modelPart}${ctx}\n`)
