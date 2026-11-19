/** MCP 工具定义和处理器；stdio 协议壳不碰业务。 */
import fs from 'node:fs'
import path from 'node:path'
import { addDeliverables, fetchMe, getTask, listPeople, listTasks, patchTask, searchKnowledge, taskAction } from './gateway.mjs'
import { assertDecision, canFinalize, canReview, canSubmit, hasDeliverables, reviewerOptions, workflowHint } from './task-workflow.mjs'
import { zoneRoot } from './drive-paths.mjs'
import { writeFileAtomic } from './drive-mirror.mjs'
import { getMirror, syncDrive } from './drive-runtime.mjs'
import { loadState, publicView, saveState } from './state.mjs'

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const num = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })
const enumOf = (values, description) => ({ type: 'string', enum: values, description })
const ok = (text, details) => ({ content: [{ type: 'text', text }], ...(details === undefined ? {} : { details }) })
const personName = (person) => (person && typeof person === 'object' ? person.displayName || person.username : person) ?? null

function fail(err) {
  let text = err instanceof Error ? err.message : String(err)
  if (err?.status === 401 && !['not_logged_in', 'no_gateway_token'].includes(err.code)) {
    try { saveState({ needsRelogin: true, lastError: `公司网关登录已失效：${text}` }) } catch { /* 照常返回 */ }
    text += '（公司网关登录已失效，请运行 codex-valimart login 重新登录）'
  }
  return { content: [{ type: 'text', text }], details: { error: text }, isError: true }
}

function username() {
  const name = loadState().user?.username
  if (!name) throw new Error('未登录公司网关')
  return name
}

function zonePath(zone, value) {
  const base = zoneRoot(zone, username())
  const sub = String(value ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!sub) return base
  const rel = path.posix.normalize(`${base}/${sub}`)
  if (!rel.startsWith(`${base}/`)) throw new Error(`路径越出 ${zone} 分区：${value}`)
  return rel
}

function resolveTaskId(explicit) {
  const id = explicit || loadState().currentTaskId
  if (!id) throw new Error('当前没有绑定任务卡：用 codex-valimart task <id> 绑定，或显式传 taskId')
  return id
}

async function taskCard(id) {
  const result = await getTask(id)
  const task = result.task ?? result
  getMirror().writeTaskCard(task)
  return task
}

async function persistedTask(result) {
  const task = result?.task ?? result
  getMirror().writeTaskCard(task)
  return task
}

function workspaceDir() {
  return loadState().projectDir || process.env.CODEX_PROJECT_DIR || process.cwd()
}

export const TOOLS = [
  {
    name: 'company_whoami', readOnly: true, description: '查看当前公司网关登录账号、公司名和本周额度。密钥不会返回。', inputSchema: { type: 'object', properties: {} },
    async run() { try { return ok(JSON.stringify(publicView(await fetchMe()), null, 2), publicView(loadState())) } catch (err) { return fail(err) } },
  },
  {
    name: 'company_knowledge', readOnly: true, description: '企业知识检索。开工前先问「公司里有没有人做过」，只返回谁 / 何时 / 在哪和上下文片段，不拷贝别人的会话。',
    inputSchema: { type: 'object', properties: { q: str('检索词'), query: str('检索词（与 q 相同）'), limit: num('最多条数，默认 20'), kinds: str('可选过滤：handbook,shared,personal,task,skills') } },
    async run(args = {}) {
      try {
        const q = String(args.query || args.q || '').trim()
        const result = await searchKnowledge(q, { limit: args.limit, kinds: args.kinds })
        const hits = result?.hits ?? []
        if (!hits.length) return ok(`公司里没有人做过「${result.query ?? q}」（扫描 ${result.scanned?.files ?? 0} 个文件、${result.scanned?.tasks ?? 0} 张任务卡）。`)
        const lines = hits.map((hit, index) => `${index + 1}. [${hit.kindLabel ?? hit.kind}] ${hit.title ?? ''}\n   ${[hit.who && `谁：${hit.who}`, `何时：${hit.when}`, `在哪：${hit.path}`, hit.taskId && `任务卡：${hit.taskId}`].filter(Boolean).join(' · ')}\n   ${hit.snippet ?? ''}`)
        return ok(`公司里做过「${result.query}」的记录 ${hits.length} 条（扫描 ${result.scanned?.files ?? 0} 个文件、${result.scanned?.tasks ?? 0} 张任务卡）：\n${lines.join('\n')}`, result)
      } catch (err) { return fail(err) }
    },
  },
  {
    name: 'company_tasks', readOnly: true, description: '列出或查看公司任务卡。交活用 company_task_submit，初审 company_task_review，终审 company_task_final。',
    inputSchema: { type: 'object', properties: { action: enumOf(['list', 'get'], 'list 或 get'), id: str('get 的任务 id'), status: enumOf(['draft', 'pending_review', 'pending_final', 'approved', 'rejected'], '状态过滤') }, required: ['action'] },
    async run(args = {}) {
      try {
        if (args.action === 'get') {
          if (!args.id) return fail(new Error('get 需要任务 id'))
          const result = await getTask(args.id)
          return ok(JSON.stringify(result.task ?? result, null, 2), result.task ?? result)
        }
        const payload = await listTasks()
        let tasks = payload.tasks ?? []
        if (args.status) tasks = tasks.filter((task) => task.status === args.status)
        const rows = tasks.map((task) => ({ id: task.id, title: task.title, status: task.status, assignee: personName(task.assignee) ?? task.assigneeName ?? null, reviewer: personName(task.reviewer), updatedAt: task.updatedAt ?? task.updated_at }))
        return ok(rows.length ? rows.map((task) => `- ${task.id}  [${task.status}]  ${task.title}${task.assignee ? `（${task.assignee}）` : ''}`).join('\n') : '没有可见任务卡', { tasks: rows, statuses: payload.statuses })
      } catch (err) { return fail(err) }
    },
  },
  {
    name: 'company_task_read', readOnly: true, description: '读取任务卡与已同步的本机任务格子。不传 taskId 时读绑定的任务。', inputSchema: { type: 'object', properties: { taskId: str('任务 ID') } },
    async run(args = {}) { try { const task = await taskCard(resolveTaskId(args.taskId)); return ok(JSON.stringify(task, null, 2), task) } catch (err) { return fail(err) } },
  },
  {
    name: 'company_task_log', description: '往任务卡工作日志追加一条。', inputSchema: { type: 'object', properties: { text: str('日志正文'), taskId: str('任务 ID') }, required: ['text'] },
    async run(args = {}) { try { const id = resolveTaskId(args.taskId); const result = await taskAction(id, 'log', { text: args.text, kind: 'agent', sessionId: null }); getMirror().writeTaskCard(result.task); return ok(`已记录到任务 ${id} 的工作日志`) } catch (err) { return fail(err) } },
  },
  {
    name: 'company_task_update', description: '更新任务卡提交内容或任务内容。', inputSchema: { type: 'object', properties: { submission: str('提交内容'), content: str('任务内容'), taskId: str('任务 ID') } },
    async run(args = {}) {
      try {
        const id = resolveTaskId(args.taskId)
        const patch = { sessionId: null }
        if (args.submission !== undefined) Object.assign(patch, { submission: args.submission, adopt: 'submission' })
        if (args.content !== undefined) Object.assign(patch, { content: args.content, adopt: patch.adopt ?? 'content' })
        const task = await persistedTask(await patchTask(id, patch))
        return ok(`任务 ${id} 已更新（状态 ${task.statusLabel ?? task.status}）`)
      } catch (err) { return fail(err) }
    },
  },
  {
    name: 'company_task_attach', description: '把本机文件作为交付物挂到任务卡。口头完成不算完成。', inputSchema: { type: 'object', properties: { paths: { type: 'array', items: str('本机文件路径'), description: '建议绝对路径' }, taskId: str('任务 ID') }, required: ['paths'] },
    async run(args = {}) {
      try {
        const id = resolveTaskId(args.taskId)
        const files = []
        for (const value of args.paths ?? []) {
          const full = path.resolve(workspaceDir(), value)
          let stat
          try { stat = fs.statSync(full) } catch { throw new Error(`找不到文件 ${full}（建议传绝对路径）`) }
          if (!stat.isFile()) throw new Error(`${value} 不是文件`)
          if (stat.size > 50 * 1024 * 1024) throw new Error(`${value} 超过 50MB`)
          files.push({ name: path.basename(full), dataBase64: fs.readFileSync(full).toString('base64'), source: 'agent', sessionId: null, localPath: full })
        }
        if (!files.length) throw new Error('paths 为空：至少给一个本机文件')
        const task = await persistedTask(await addDeliverables(id, files))
        getMirror().pull().catch(() => {})
        return ok(`已挂载 ${files.length} 个交付物到任务 ${id}:${task.deliverables.map((item) => item.name).join('、')}。下一步：company_task_update 后 company_task_submit。`)
      } catch (err) { return fail(err) }
    },
  },
  {
    name: 'company_task_submit', description: '提交验收。必须先有交付物；不传 reviewerId 时先返回候选人。', inputSchema: { type: 'object', properties: { reviewerId: str('审核人用户 id'), taskId: str('任务 ID') } },
    async run(args = {}) {
      try {
        const id = resolveTaskId(args.taskId)
        const task = await taskCard(id)
        const me = loadState().user
        if (!canSubmit(task, me)) throw new Error(workflowHint(task))
        if (!hasDeliverables(task)) throw new Error('口头完成不算完成：请先 company_task_attach 挂交付物再提交验收')
        const options = reviewerOptions((await listPeople()).users ?? [], me)
        if (!options.length) throw new Error('没有可选审核人（不能是自己；停用账号不可选）')
        if (!args.reviewerId) return ok(`请选择审核人后再次调用 company_task_submit，传入 reviewerId：\n${options.map((item) => `- ${item.id}  ${item.label}`).join('\n')}`, { taskId: id, reviewers: options })
        const next = await persistedTask(await taskAction(id, 'submit', { reviewerId: args.reviewerId }))
        saveState({ currentTaskId: next.id })
        return ok(`已提交验收 ${next.id}「${next.title}」。${workflowHint(next)}`, next)
      } catch (err) { return fail(err) }
    },
  },
  {
    name: 'company_task_review', description: '初审任务卡：pass 进入待终审，reject 驳回。', inputSchema: { type: 'object', properties: { decision: enumOf(['pass', 'reject'], 'decision'), comment: str('审核意见'), taskId: str('任务 ID') }, required: ['decision'] },
    async run(args = {}) {
      try {
        const id = resolveTaskId(args.taskId)
        const task = await taskCard(id)
        if (!canReview(task, loadState().user)) throw new Error(workflowHint(task))
        const next = await persistedTask(await taskAction(id, 'review', { decision: assertDecision(args.decision), comment: args.comment ?? '' }))
        return ok(`${args.decision === 'pass' ? '初审通过 → 待终审' : '初审驳回'} ${next.id}「${next.title}」`, next)
      } catch (err) { return fail(err) }
    },
  },
  {
    name: 'company_task_final', description: '终审任务卡：pass 通过，reject 驳回。', inputSchema: { type: 'object', properties: { decision: enumOf(['pass', 'reject'], 'decision'), comment: str('终审意见'), taskId: str('任务 ID') }, required: ['decision'] },
    async run(args = {}) {
      try {
        const id = resolveTaskId(args.taskId)
        const task = await taskCard(id)
        if (!canFinalize(task, loadState().user)) throw new Error(workflowHint(task))
        const next = await persistedTask(await taskAction(id, 'final', { decision: assertDecision(args.decision), comment: args.comment ?? '' }))
        return ok(`${args.decision === 'pass' ? '终审通过' : '终审驳回'} ${next.id}「${next.title}」`, next)
      } catch (err) { return fail(err) }
    },
  },
  {
    name: 'company_memory_write', description: '写公司盘记忆。personal 写个人区；shared 由权限控制，员工只能追加 05-logs。', inputSchema: { type: 'object', properties: { zone: enumOf(['personal', 'shared'], '分区'), path: str('相对 _memory 的路径'), content: str('Markdown 正文'), append: bool('追加而不是覆盖') }, required: ['zone', 'path', 'content'] },
    async run(args = {}) {
      try {
        if (!['personal', 'shared'].includes(args.zone)) throw new Error('zone 只能是 personal 或 shared')
        const base = zoneRoot(args.zone, username())
        const rel = zonePath(args.zone, args.path)
        if (rel === base) throw new Error('path 要指到具体文件，如 02-methods/xxx.md')
        const append = !!args.append || /^(05-logs|90-system)\//.test(rel.slice(base.length + 1))
        const buf = Buffer.from(String(args.content ?? ''), 'utf8')
        const mirror = getMirror()
        const result = await mirror.gateway.put(`/api/drive/file?path=${encodeURIComponent(rel)}${append ? '&append=1' : ''}`, buf, { raw: true, headers: { 'content-type': 'application/octet-stream' } })
        const local = mirror.abs(rel)
        let where = `本机镜像 ${local}`
        if (!append) { writeFileAtomic(local, buf); mirror.markSynced(rel, buf) }
        else if (mirror.isInSync(rel)) { fs.appendFileSync(local, buf); mirror.markSynced(rel, fs.readFileSync(local)) }
        else { mirror.pull().catch(() => {}); where = `本机镜像稍后同步到 ${local}` }
        return ok(`已写入公司盘 ${result?.file?.path ?? rel}（${result?.file?.size ?? ''} 字节）${append ? '（追加）' : ''}；${where}`)
      } catch (err) { return fail(err) }
    },
  },
  {
    name: 'company_memory_read', readOnly: true, description: '读取公司盘记忆或手册文件。', inputSchema: { type: 'object', properties: { zone: enumOf(['personal', 'shared', 'handbook'], '分区'), path: str('相对该区的文件路径') }, required: ['zone', 'path'] },
    async run(args = {}) {
      try {
        const rel = zonePath(args.zone, args.path)
        const buf = await getMirror().gateway.get(`/api/drive/file?path=${encodeURIComponent(rel)}`)
        return ok(Buffer.isBuffer(buf) ? buf.toString('utf8') : JSON.stringify(buf))
      } catch (err) { return fail(err) }
    },
  },
  {
    name: 'company_memory_list', readOnly: true, description: '列出公司盘记忆或手册目录。', inputSchema: { type: 'object', properties: { zone: enumOf(['personal', 'shared', 'handbook'], '分区'), path: str('相对该区的子目录') }, required: ['zone'] },
    async run(args = {}) {
      try {
        const rel = zonePath(args.zone, args.path)
        const result = await getMirror().gateway.get(`/api/drive/list?path=${encodeURIComponent(rel)}`)
        const items = result?.items ?? []
        return ok(items.length ? items.map((item) => `${item.isDir ? 'dir' : 'file'} ${item.path}${item.isDir ? '' : ` (${item.size} B, ${item.mtime})`}`).join('\n') : `${rel}/ 为空`, result)
      } catch (err) { return fail(err) }
    },
  },
  {
    name: 'company_drive_sync', description: '手动同步公司盘：回推个人记忆并拉取可见文件。', inputSchema: { type: 'object', properties: {} },
    async run() { try { const result = await syncDrive(); return ok(`公司盘已同步：远端 ${result.files} 个，下载 ${result.pulled}，回推 ${result.pushed}；本机镜像 ${getMirror().root}`, result) } catch (err) { return fail(err) } },
  },
]

export const TOOL_NAMES = TOOLS.map((tool) => tool.name)
export const listTools = () => TOOLS.map(({ name, description, inputSchema, readOnly }) => ({ name, description, inputSchema, ...(readOnly ? { annotations: { readOnlyHint: true } } : {}) }))
export const findTool = (name) => TOOLS.find((tool) => tool.name === name) ?? null
export async function callTool(name, args) {
  const tool = findTool(name)
  if (!tool) return fail(new Error(`未知工具 ${name}`))
  return tool.run(args ?? {})
}
