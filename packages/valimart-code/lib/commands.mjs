/**
 * valimart code 自带的斜杠命令（/desk-*）。
 *
 * 由 scripts/patches.mjs 的 valimart-desk-commands 补丁在 Qwen Code 的 BuiltinCommandLoader 里加载：
 * 环境变量 VALIMART_CODE_COMMANDS 指向打包后的 commands.mjs，loadDeskCommands() 返回 SlashCommand 对象。
 * 形状按 Qwen Code packages/cli/src/ui/commands/types.ts：action 返回 {type:'message'}，直接显示、不发模型请求；
 * completion 给参数补全（任务卡号、审核人账号）。
 *
 * 选列表、填表这类交互 Qwen Code 的命令接口给不了：要选的东西做成 Tab 补全，密码只认环境变量 DESK_GATEWAY_PASSWORD
 * （与 pi 包同一条规矩，密码不进输入框和历史），没有就让人退出后跑 valimart login。
 */
import { discoverGateways } from './discover.mjs'
import { gatewayOptions } from './gateway-choice.mjs'
import {
  createTask,
  fetchMe,
  getTask,
  GatewayError,
  listPeople,
  listTasks,
  login,
  logout,
  normalizeGatewayUrl,
  taskAction,
} from './gateway.mjs'
import { getMirror, setDriveLogSink, syncDrive } from './drive-runtime.mjs'
import { formatTaskCard } from './people-options.mjs'
import { isLoggedIn, loadState, saveState } from './state.mjs'
import { statusText } from './status.mjs'
import { assertDecision, canFinalize, canReview, canSubmit, hasDeliverables, reviewerOptions, TASK_STATUS, workflowHint } from './task-workflow.mjs'

const RESTART_HINT = '模型令牌和目录在启动时注入：/quit 后重新运行 valimart 生效（/resume 可以接着刚才的会话）。'

const info = (content) => ({ type: 'message', messageType: 'info', content })
const warn = (content) => ({ type: 'message', messageType: 'warning', content })
const error = (content) => ({ type: 'message', messageType: 'error', content })
const errText = (err) => (err instanceof Error ? err.message : String(err))

/** 任务卡接口失败时统一回一条错误；401 说明登录失效。 */
function failed(err) {
  if (err instanceof GatewayError && err.status === 401 && err.code !== 'not_logged_in') {
    saveState({ needsRelogin: true, lastError: `公司网关登录已失效：${err.message}` })
    return error(`${err.message}\n公司网关登录已失效：/quit 后运行 valimart login。`)
  }
  return error(errText(err))
}

const words = (args) => String(args ?? '').trim().split(/\s+/).filter(Boolean)

async function persistTask(r) {
  const task = r?.task ?? r
  getMirror().writeTaskCard(task)
  return task
}

async function boundTask() {
  const id = loadState().currentTaskId
  if (!id) throw new Error('当前没有绑定任务卡：/desk-task <任务ID> 绑定（Tab 补全可选）')
  return persistTask(await getTask(id))
}

async function taskCompletions(partial) {
  if (!isLoggedIn()) return []
  try {
    const r = await listTasks()
    const p = String(partial ?? '').trim().toLowerCase()
    return (r.tasks ?? [])
      .filter((t) => !p || String(t.id).toLowerCase().startsWith(p) || String(t.title ?? '').toLowerCase().includes(p))
      .map((t) => ({ value: t.id, label: t.id, description: `[${t.statusLabel ?? TASK_STATUS[t.status] ?? t.status}] ${t.title ?? ''}` }))
  } catch {
    return []
  }
}

async function reviewerCompletions(partial) {
  if (!isLoggedIn()) return []
  try {
    const people = await listPeople()
    const p = String(partial ?? '').trim().toLowerCase()
    return reviewerOptions(people.users ?? [], loadState().user)
      .filter((o) => !p || o.username.toLowerCase().startsWith(p) || o.label.toLowerCase().includes(p))
      .map((o) => ({ value: o.username, label: o.username, description: o.label }))
  } catch {
    return []
  }
}

function decisionCompletions(partial) {
  const p = String(partial ?? '').trim()
  return ['pass', 'reject'].filter((d) => d.startsWith(p)).map((d) => ({ value: d, label: d, description: d === 'pass' ? '通过' : '驳回' }))
}

const base = {
  kind: 'built-in',
  sourceLabel: 'valimart',
  supportedModes: ['interactive', 'non_interactive'],
}

export function deskCommands() {
  return [
    {
      ...base,
      name: 'desk-status',
      description: 'valimart：公司网关登录、额度、模型目录、公司盘与绑定的任务卡',
      canRunDuringStreaming: true,
      action: async () => {
        let note = ''
        if (isLoggedIn()) {
          try {
            await fetchMe({ timeoutMs: 8_000 })
          } catch (err) {
            note = `\n（刷新失败，显示的是本机记录：${errText(err)}）`
          }
        }
        const state = loadState()
        return (isLoggedIn(state) ? info : warn)(`${statusText(state)}${note}`)
      },
    },
    {
      ...base,
      name: 'desk-login',
      description: 'valimart：登录公司网关（/desk-login [网关地址] [账号]，密码只从 DESK_GATEWAY_PASSWORD 读）',
      argumentHint: '[网关地址] [账号]',
      action: async (_context, args) => {
        const [urlArg, userArg] = words(args)
        const state = loadState()
        const url = normalizeGatewayUrl(urlArg || process.env.DESK_GATEWAY_URL || state.gatewayUrl)
        const username = userArg || process.env.DESK_GATEWAY_USER || state.user?.username || ''
        const password = process.env.DESK_GATEWAY_PASSWORD || ''
        if (!url || !username || !password) {
          return warn(
            [
              '密码不进输入框。两种登录方式：',
              '1. /quit 退出，在终端运行 valimart login（会自动找网关、提示输入密码），再运行 valimart；',
              '2. 启动前设置环境变量 DESK_GATEWAY_PASSWORD，然后 /desk-login <网关地址> <账号>。',
            ].join('\n'),
          )
        }
        try {
          const next = await login({ gatewayUrl: url, username, password })
          const sync = await syncDrive().catch(() => null)
          return info(`已登录 ${next.user?.displayName || next.user?.username} @${next.company?.name ?? url} · ${next.models?.length ?? 0} 个模型${sync ? ` · 公司盘 ${sync.files} 个文件` : ''}\n${RESTART_HINT}`)
        } catch (err) {
          return error(errText(err))
        }
      },
    },
    {
      ...base,
      name: 'desk-logout',
      description: 'valimart：登出公司网关（本机网关令牌随之作废）',
      action: async () => {
        await logout()
        return info('已登出公司网关。本次会话后续的模型请求会被网关拒绝；/quit 后运行 valimart 重新登录。')
      },
    },
    {
      ...base,
      name: 'desk-discover',
      description: 'valimart：在本机与局域网找公司网关（/desk-discover <地址> 记下它）',
      argumentHint: '[网关地址]',
      canRunDuringStreaming: true,
      completion: async () => gatewayOptions(await discoverGateways(), { manual: '' }).map((o) => ({ value: o.url, label: o.url, description: o.label })),
      action: async (_context, args) => {
        const [urlArg] = words(args)
        if (urlArg) {
          const url = normalizeGatewayUrl(urlArg)
          if (!url) return error(`网关地址无效：${urlArg}`)
          saveState({ gatewayUrl: url })
          return info(`已记下网关 ${url}。下次 valimart login 默认用它。`)
        }
        const options = gatewayOptions(await discoverGateways(), { manual: '', withSource: true })
        if (!options.length) return warn('没有发现公司网关。网关在别的网段时广播到不了：直接 valimart login <网关地址>。')
        return info(`发现的公司网关：\n${options.map((o) => `- ${o.label}`).join('\n')}\n/desk-discover <地址> 记下其中一个。`)
      },
    },
    {
      ...base,
      name: 'desk-sync',
      description: 'valimart：立刻同步公司盘镜像（回推个人记忆 + 拉取可见文件）',
      canRunDuringStreaming: true,
      action: async () => {
        try {
          const r = await syncDrive()
          return info(`公司盘已同步：远端 ${r.files} 个，下载 ${r.pulled}，回推 ${r.pushed}\n本机镜像 ${loadState().driveDir}`)
        } catch (err) {
          return failed(err)
        }
      },
    },
    {
      ...base,
      name: 'desk-tasks',
      description: 'valimart：列出可见的任务卡（/desk-tasks [draft|pending_review|pending_final|approved|rejected]）',
      argumentHint: '[状态]',
      canRunDuringStreaming: true,
      completion: async (_context, partial) => Object.keys(TASK_STATUS).filter((s) => s.startsWith(String(partial ?? '').trim())).map((s) => ({ value: s, label: s, description: TASK_STATUS[s] })),
      action: async (_context, args) => {
        try {
          const [status] = words(args)
          const r = await listTasks()
          const tasks = (r.tasks ?? []).filter((t) => !status || t.status === status)
          if (!tasks.length) return info(status ? `没有「${TASK_STATUS[status] ?? status}」的任务卡` : '没有可见任务卡。/desk-task-new <标题> 新建。')
          const bound = loadState().currentTaskId
          const rows = tasks.map((t) => `${t.id === bound ? '▶' : '-'} ${t.id}  [${t.statusLabel ?? TASK_STATUS[t.status] ?? t.status}]  ${t.title ?? ''}`)
          return info(`${rows.join('\n')}\n/desk-task <任务ID> 绑定（Tab 补全）。`)
        } catch (err) {
          return failed(err)
        }
      },
    },
    {
      ...base,
      name: 'desk-task',
      description: 'valimart：查看 / 绑定 / 解绑任务卡（/desk-task [任务ID|off]）',
      argumentHint: '[任务ID|off]',
      completion: async (_context, partial) => [{ value: 'off', label: 'off', description: '解绑当前任务卡' }, ...(await taskCompletions(partial))],
      action: async (_context, args) => {
        const [id] = words(args)
        try {
          if (!id) {
            const task = await boundTask()
            return info(`${formatTaskCard(task)}\n下一步：${workflowHint(task)}`)
          }
          if (id === 'off') {
            saveState({ currentTaskId: null })
            return info('已解绑任务卡，按普通会话继续。')
          }
          const task = await persistTask(await getTask(id))
          saveState({ currentTaskId: task.id })
          return info(
            `已绑定\n${formatTaskCard(task)}\n本机任务格子 ${getMirror().taskDir(task.id)}\n下一步：${workflowHint(task)}\n` +
              'company_task_* 工具默认作用于这张卡；任务卡全文在下次 /clear 或新会话时进入上下文，现在也可以让 Agent 用 company_task_read 读。',
          )
        } catch (err) {
          return failed(err)
        }
      },
    },
    {
      ...base,
      name: 'desk-task-new',
      description: 'valimart：新建任务卡并绑定（/desk-task-new <标题> [@指派账号]，默认派给自己）',
      argumentHint: '<标题> [@账号]',
      action: async (_context, args) => {
        const parts = words(args)
        const at = parts.findIndex((p) => p.startsWith('@'))
        const assigneeName = at >= 0 ? parts.splice(at, 1)[0].slice(1) : ''
        const title = parts.join(' ').trim()
        if (!title) return warn('用法：/desk-task-new <标题> [@账号]')
        try {
          const me = loadState().user
          let assigneeId = me?.id
          if (assigneeName && assigneeName !== me?.username) {
            const people = await listPeople()
            const person = (people.users ?? []).find((u) => u.username === assigneeName && !u.disabled)
            if (!person) return error(`没有这个同事：${assigneeName}`)
            if (me?.role === 'employee') return error('员工只能把任务卡派给自己')
            assigneeId = person.id
          }
          const task = await persistTask(await createTask({ title, content: '', project: '', assigneeId }))
          saveState({ currentTaskId: task.id })
          getMirror().pull().catch(() => {})
          return info(`已创建并绑定 ${task.id}「${task.title}」\n${formatTaskCard(task)}\n本机任务格子 ${getMirror().taskDir(task.id)}`)
        } catch (err) {
          return failed(err)
        }
      },
    },
    {
      ...base,
      name: 'desk-task-submit',
      description: 'valimart：绑定的任务卡提交验收（/desk-task-submit <审核人账号>，必须先有交付物）',
      argumentHint: '<审核人账号>',
      completion: async (_context, partial) => reviewerCompletions(partial),
      action: async (_context, args) => {
        try {
          const task = await boundTask()
          const me = loadState().user
          if (!canSubmit(task, me)) return warn(workflowHint(task))
          if (!hasDeliverables(task)) return error('口头完成不算完成：先让 Agent 用 company_task_attach 把交付物挂到任务卡，再提交验收。')
          const people = await listPeople()
          const options = reviewerOptions(people.users ?? [], me)
          if (!options.length) return error('没有可选审核人（不能是自己；停用账号不可选）')
          const [name] = words(args)
          const picked = options.find((o) => o.username === name || o.id === name)
          if (!picked) return warn(`选一位审核人（任意同事，不能是自己）：/desk-task-submit <账号>\n${options.map((o) => `- ${o.username}  ${o.label}`).join('\n')}`)
          const next = await persistTask(await taskAction(task.id, 'submit', { reviewerId: picked.id }))
          return info(`已提交验收，审核人 ${picked.label}\n${formatTaskCard(next)}\n${workflowHint(next)}`)
        } catch (err) {
          return failed(err)
        }
      },
    },
    {
      ...base,
      name: 'desk-task-review',
      description: 'valimart：初审绑定的任务卡（/desk-task-review pass|reject [意见]）',
      argumentHint: 'pass|reject [意见]',
      completion: async (_context, partial) => decisionCompletions(partial),
      action: async (_context, args) => {
        try {
          const [decisionArg, ...rest] = words(args)
          const decision = assertDecision(decisionArg)
          const task = await boundTask()
          if (!canReview(task, loadState().user)) return warn(workflowHint(task))
          const next = await persistTask(await taskAction(task.id, 'review', { decision, comment: rest.join(' ') }))
          return info(`${decision === 'pass' ? '初审通过 → 待终审' : '初审驳回'}\n${formatTaskCard(next)}`)
        } catch (err) {
          return failed(err)
        }
      },
    },
    {
      ...base,
      name: 'desk-task-final',
      description: 'valimart：终审绑定的任务卡（/desk-task-final pass|reject [意见]，管理员或派单总监）',
      argumentHint: 'pass|reject [意见]',
      completion: async (_context, partial) => decisionCompletions(partial),
      action: async (_context, args) => {
        try {
          const [decisionArg, ...rest] = words(args)
          const decision = assertDecision(decisionArg)
          const task = await boundTask()
          if (!canFinalize(task, loadState().user)) return warn(workflowHint(task))
          const next = await persistTask(await taskAction(task.id, 'final', { decision, comment: rest.join(' ') }))
          return info(`${decision === 'pass' ? '终审通过' : '终审驳回'}\n${formatTaskCard(next)}`)
        } catch (err) {
          return failed(err)
        }
      },
    },
  ]
}

/** 补丁调用的入口（Qwen Code 传进它的 Config，这里用不上）。跑在 TUI 进程里：同步日志不许写 stderr，否则会花屏。 */
export function loadDeskCommands() {
  setDriveLogSink(() => {})
  return deskCommands()
}
