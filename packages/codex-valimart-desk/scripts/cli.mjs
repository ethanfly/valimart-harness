/** 登录 / 状态 / 同步 / 任务绑定的一次性 CLI。密码只从 DESK_GATEWAY_PASSWORD 读取。 */
import { discoverGateways, gatewayChoices } from '../lib/discover.mjs'
import { GatewayError, getTask, listTasks, login, logout, taskAction } from '../lib/gateway.mjs'
import { DEFAULT_GATEWAY_URL, parseDeskLoginArgs } from '../lib/login-args.mjs'
import { loadState, saveState } from '../lib/state.mjs'
import { statusText, userLine } from '../lib/whoami.mjs'

const [command, ...rest] = process.argv.slice(2)
const arg = rest.join(' ').trim()
const die = (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1) }
const printTask = (task) => console.log(`${task.id || task.taskId}\t${task.status || ''}\t${task.title || ''}`)

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
  const state = await login({ gatewayUrl: url, username: parsed.username, password: parsed.password })
  console.log('已登录')
  console.log(userLine(state))
}

async function doTask() {
  if (!arg) {
    const id = loadState().currentTaskId
    if (!id) { console.log('还没有绑定任务。用法：task <任务ID>'); return }
    printTask(await getTask(id))
    return
  }
  const id = arg.split(/\s+/)[0]
  const result = await getTask(id)
  saveState({ currentTaskId: result.task?.id ?? id })
  console.log('已绑定')
  printTask(result.task ?? result)
}

async function doAction(action) {
  const [first, ...notes] = arg.split(/\s+/).filter(Boolean)
  const id = loadState().currentTaskId
  if (!id) die(new Error('先用 task <任务ID> 绑定'))
  if (action === 'submit') {
    if (!first) die(new Error('要给出审核人用户 ID'))
    printTask((await taskAction(id, 'submit', { reviewerId: first })).task)
    return
  }
  if (!['pass', 'reject'].includes(first)) die(new Error('第一段必须是 pass 或 reject'))
  printTask((await taskAction(id, action, { decision: first, comment: notes.join(' ') })).task)
}

try {
  if (command === 'login') await doLogin()
  else if (command === 'logout') { await logout(); console.log(userLine(loadState())) }
  else if (command === 'status') console.log(statusText(loadState()))
  else if (command === 'sync') {
    const { syncDrive } = await import('../lib/drive-runtime.mjs')
    const result = await syncDrive()
    console.log(`公司盘已同步：远端 ${result.files} 个，下载 ${result.pulled}，回推 ${result.pushed}`)
    console.log(`本机镜像 ${loadState().driveDir}`)
  } else if (command === 'whoami' || command === 'hud') console.log(userLine(loadState()))
  else if (command === 'discover') {
    const found = gatewayChoices(await discoverGateways())
    if (!found.length) console.log('没有发现公司网关')
    for (const item of found) console.log(item.label)
  } else if (command === 'tasks') {
    const payload = await listTasks()
    const tasks = Array.isArray(payload) ? payload : payload.tasks ?? payload.items ?? []
    if (!tasks.length) console.log('没有可见的任务卡')
    for (const task of tasks) printTask(task)
  } else if (command === 'task') await doTask()
  else if (command === 'task-submit') await doAction('submit')
  else if (command === 'task-review') await doAction('review')
  else if (command === 'task-final') await doAction('final')
  else {
    console.error('用法：login | logout | status | sync | whoami | hud | discover | tasks | task | task-submit | task-review | task-final')
    process.exit(2)
  }
} catch (err) { die(err instanceof GatewayError ? err : err) }
