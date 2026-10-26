/**
 * 斜杠命令背后的一次性 CLI。打印给人看的中文，退出码非 0 表示没做成。
 * 不改 ~/.claude/settings.json。
 */
import { discoverGateways, gatewayChoices } from '../lib/discover.mjs'
import { GatewayError, getTask, listTasks, login, logout, taskAction } from '../lib/gateway.mjs'
import { DEFAULT_GATEWAY_URL, parseDeskLoginArgs } from '../lib/login-args.mjs'
import { loadState, saveState } from '../lib/state.mjs'
import { listenPort } from '../lib/bridge-server.mjs'
import { hudLine, statusText, userLine } from '../lib/whoami.mjs'

const [cmd, ...rest] = process.argv.slice(2)
const arg = rest.join(' ').trim()

function die(err) {
  const message = err instanceof Error ? err.message : String(err)
  console.error(message)
  process.exit(1)
}

function tasksOf(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.tasks)) return payload.tasks
  if (Array.isArray(payload?.items)) return payload.items
  return []
}

function printTask(task) {
  if (!task) return
  console.log(`${task.id || task.taskId}\t${task.status || ''}\t${task.title || ''}`)
}

async function doLogin() {
  const parsed = parseDeskLoginArgs(arg)
  let url = parsed.url
  if (!url) {
    const found = gatewayChoices(await discoverGateways())
    if (found.length === 1) url = found[0].url
    else if (found.length > 1) {
      console.log('找到多个公司网关，请指定一个：')
      for (const item of found) console.log(`- ${item.label}`)
      process.exit(2)
    } else url = DEFAULT_GATEWAY_URL
  }
  if (!parsed.username || !parsed.password) {
    console.error('缺少账号或密码。用法：login [网关URL] [账号]，密码放 DESK_GATEWAY_PASSWORD。')
    process.exit(2)
  }
  const next = await login({ gatewayUrl: url, username: parsed.username, password: parsed.password })
  console.log('已登录')
  console.log(userLine(next))
}

async function doTasks() {
  const payload = await listTasks()
  const tasks = tasksOf(payload)
  if (!tasks.length) {
    console.log('没有可见的任务卡')
    return
  }
  for (const task of tasks) printTask(task)
}

async function doTask() {
  if (!arg) {
    const id = loadState().currentTaskId
    if (!id) {
      console.log('还没有绑定任务。用法：task <任务ID>')
      return
    }
    printTask(await getTask(id))
    return
  }
  const task = await getTask(arg.split(/\s+/)[0])
  saveState({ currentTaskId: task.id || arg.split(/\s+/)[0] })
  console.log('已绑定')
  printTask(task)
}

async function doAction(action) {
  const [idOrDecision, ...noteParts] = arg.split(/\s+/).filter(Boolean)
  const state = loadState()
  let id = state.currentTaskId
  let decision = idOrDecision
  if (action === 'submit') {
    const reviewerId = idOrDecision
    if (!id) die(new Error('先用 task <任务ID> 绑定'))
    if (!reviewerId) die(new Error('要给出审核人用户 ID'))
    const result = await taskAction(id, 'submit', { reviewerId })
    printTask(result.task || result)
    return
  }
  if (!decision || !['pass', 'reject'].includes(decision)) die(new Error('第一段必须是 pass 或 reject'))
  if (!id) die(new Error('先用 task <任务ID> 绑定'))
  const result = await taskAction(id, action, { decision, comment: noteParts.join(' ') })
  printTask(result.task || result)
}

async function doRoute() {
  const state = loadState()
  if (!state.gatewayToken || !state.user) die(new Error('未登录。先运行 login'))
  const port = listenPort() || 8799
  console.log('先在另一个终端跑 serve，再在开 Claude Code 的终端执行下面几行。')
  console.log('占位符不是密钥，真令牌留在本机登录态。不要写进 settings.json。')
  console.log(`export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`)
  console.log('export ANTHROPIC_API_KEY=valimart-gateway')
  if (state.defaultModel) console.log(`export ANTHROPIC_MODEL=${state.defaultModel}`)
}

async function doServe() {
  const { startBridge } = await import('../lib/bridge-server.mjs')
  const port = listenPort() || 8799
  const started = await startBridge({ port })
  console.log(`公司网关转发已听在 ${started.baseUrl}`)
  await new Promise(() => {})
}

try {
  if (cmd === 'login') await doLogin()
  else if (cmd === 'logout') {
    await logout()
    console.log(userLine(loadState()))
  } else if (cmd === 'status') console.log(statusText(loadState()))
  else if (cmd === 'whoami' || cmd === 'hud') console.log(cmd === 'hud' ? hudLine(loadState()) : userLine(loadState()))
  else if (cmd === 'discover') {
    const found = gatewayChoices(await discoverGateways())
    if (!found.length) console.log('没有发现公司网关')
    for (const item of found) console.log(item.label)
  } else if (cmd === 'tasks') await doTasks()
  else if (cmd === 'task') await doTask()
  else if (cmd === 'task-submit') await doAction('submit')
  else if (cmd === 'task-review') await doAction('review')
  else if (cmd === 'task-final') await doAction('final')
  else if (cmd === 'route') await doRoute()
  else if (cmd === 'serve') await doServe()
  else {
    console.error('用法：login | logout | status | whoami | hud | discover | tasks | task | task-submit | task-review | task-final | route | serve')
    process.exit(2)
  }
} catch (err) {
  die(err instanceof GatewayError ? err : err)
}
