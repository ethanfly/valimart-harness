/**
 * MCP 工具：公司知识 / 任务卡四格 / 公司盘记忆与同步。
 * 从 pi 包 extensions/index.ts + drive-tools.ts 移植，语义保持一致；
 * 这里只做「定义 + 处理器」，stdio 协议壳在 scripts/mcp-server.mjs。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  addDeliverables,
  fetchMe,
  getTask,
  listPeople,
  listTasks,
  patchTask,
  searchKnowledge,
  taskAction,
} from './gateway.mjs'
import { assertDecision, canFinalize, canReview, canSubmit, hasDeliverables, reviewerOptions, workflowHint } from './task-workflow.mjs'
import { zoneRoot } from './drive-paths.mjs'
import { writeFileAtomic } from './drive-mirror.mjs'
import { getMirror, syncDrive } from './drive-runtime.mjs'
import { loadState, publicView, saveState } from './state.mjs'

const errText = (err) => (err instanceof Error ? err.message : String(err))

function ok(text, details) {
  return { content: [{ type: 'text', text }], ...(details === undefined ? {} : { details }) }
}

function fail(err) {
  let text = errText(err)
  // 本地没令牌时 sessionAuth 自己就会提示登录；这里只管网关拒收（令牌被吊销 / 过期）
  if (err?.status === 401 && !['not_logged_in', 'no_gateway_token'].includes(err.code)) {
    try {
      saveState({ needsRelogin: true, lastError: `公司网关登录已失效：${text}` })
    } catch {
      /* 登录态写不进也照样把错误交回去 */
    }
    text += '（公司网关登录已失效，请运行 /valimart-desk:desk-login 重新登录）'
  }
  return { content: [{ type: 'text', text }], details: { error: text }, isError: true }
}

function username() {
  const u = loadState().user?.username
  if (!u) throw new Error('未登录公司网关')
  return u
}

/** 分区内的相对路径；带 .. 跳出分区直接拒绝（网关也会按权限拦，这里先挡住写错地方）。 */
function zonePath(zone, p) {
  const base = zoneRoot(zone, username())
  const sub = String(p ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!sub) return base
  const rel = path.posix.normalize(`${base}/${sub}`)
  if (!rel.startsWith(`${base}/`)) throw new Error(`路径越出 ${zone} 分区：${p}`)
  return rel
}

function resolveTaskId(explicit) {
  if (explicit) return explicit
  const bound = loadState().currentTaskId
  if (!bound) throw new Error('当前没有绑定任务卡：用 /valimart-desk:desk-task <id> 绑定，或显式传 taskId')
  return bound
}

async function fetchAndCard(taskId) {
  const r = await getTask(taskId)
  const task = r.task ?? r
  getMirror().writeTaskCard(task)
  return task
}

async function persistTask(r) {
  const task = r?.task ?? r
  getMirror().writeTaskCard(task)
  return task
}

const personName = (p) => (p && typeof p === 'object' ? p.displayName || p.username : p) ?? null

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const num = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })
const enumOf = (values, description) => ({ type: 'string', enum: values, description })

export const TOOLS = [
  {
    name: 'company_whoami',
    readOnly: true,
    description: '查看当前公司网关登录账号、公司名和本周额度。密钥不会返回。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      try {
        const next = await fetchMe()
        const view = publicView(next)
        return ok(JSON.stringify(view, null, 2), view)
      } catch (err) {
        return fail(err)
      }
    },
  },
  {
    name: 'company_knowledge',
    readOnly: true,
    description:
      '企业知识库第四层通道。开工前先问「公司里有没有人做过」。在岗位手册 / 共享经验 / 个人记忆 / 相关任务格子和任务卡里按关键词搜，只返回谁、什么时候、在哪、一小段上下文；不拷贝会话。细节用 company_task_read 或读公司盘文件。',
    inputSchema: {
      type: 'object',
      properties: {
        q: str('检索词'),
        query: str('检索词（与 q 相同）'),
        limit: num('最多条数，默认 20'),
        kinds: str('可选过滤：handbook,shared,personal,task,skills，逗号分隔'),
      },
    },
    async run(args = {}) {
      try {
        const q = String(args.query || args.q || '').trim()
        const result = await searchKnowledge(q, { limit: args.limit, kinds: args.kinds })
        const hits = Array.isArray(result?.hits) ? result.hits : []
        if (!hits.length) {
          return ok(`公司里没有人做过「${result.query ?? q}」（扫描了 ${result.scanned?.files ?? 0} 个文件、${result.scanned?.tasks ?? 0} 张任务卡）。`)
        }
        const lines = hits.map((h, i) => {
          const head = `${i + 1}. [${h.kindLabel ?? h.kind}] ${h.title ?? ''}${h.statusLabel ? `（${h.statusLabel}）` : ''}`
          const meta = [h.who ? `谁：${h.who}` : null, `何时：${h.when}`, `在哪：${h.path}`, h.taskId ? `任务卡：${h.taskId}` : null].filter(Boolean).join(' · ')
          return `${head}\n   ${meta}\n   ${h.snippet ?? ''}`
        })
        const text = `公司里做过「${result.query}」的记录 ${hits.length} 条（扫描 ${result.scanned?.files ?? 0} 个文件、${result.scanned?.tasks ?? 0} 张任务卡）：\n${lines.join('\n')}`
        return ok(text, result)
      } catch (err) {
        return fail(err)
      }
    },
  },
  {
    name: 'company_tasks',
    readOnly: true,
    description: '列出或查看公司任务卡（进行中 / 待审 / 待终审 / 通过 / 驳回）。只读。交活用 company_task_submit，初审 company_task_review，终审 company_task_final。',
    inputSchema: {
      type: 'object',
      properties: {
        action: enumOf(['list', 'get'], 'list 列出可见任务；get 查看一张'),
        id: str('get 时的任务 id'),
        status: enumOf(['draft', 'pending_review', 'pending_final', 'approved', 'rejected'], 'list 时按状态过滤'),
      },
      required: ['action'],
    },
    async run(args = {}) {
      try {
        if (args.action === 'get') {
          if (!args.id) return fail(new Error('get 需要任务 id'))
          const result = await getTask(args.id)
          const task = result.task ?? result
          return ok(JSON.stringify(task, null, 2), task)
        }
        const result = await listTasks()
        let tasks = Array.isArray(result.tasks) ? result.tasks : []
        if (args.status) tasks = tasks.filter((t) => t.status === args.status)
        const rows = tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          assignee: personName(t.assignee) ?? t.assigneeName ?? null,
          reviewer: personName(t.reviewer),
          updatedAt: t.updatedAt ?? t.updated_at,
        }))
        const text = rows.length ? rows.map((t) => `- ${t.id}  [${t.status}]  ${t.title}${t.assignee ? `（${t.assignee}）` : ''}`).join('\n') : '没有可见任务卡'
        return ok(text, { tasks: rows, statuses: result.statuses })
      } catch (err) {
        return fail(err)
      }
    },
  },
  {
    name: 'company_task_read',
    readOnly: true,
    description: '读取任务卡：派单人/提交人/状态/任务内容/提交内容/交付物/关联进程/工作日志。不传 taskId 时读绑定的任务。',
    inputSchema: { type: 'object', properties: { taskId: str('任务 ID，如 tk-…；缺省为当前绑定任务') } },
    async run(args = {}) {
      try {
        const task = await fetchAndCard(resolveTaskId(args.taskId))
        return ok(JSON.stringify(task, null, 2), task)
      } catch (err) {
        return fail(err)
      }
    },
  },
  {
    name: 'company_task_log',
    description: '往任务卡工作日志追加一条。不传 taskId 时写当前绑定任务。',
    inputSchema: { type: 'object', properties: { text: str('日志正文（一两句话）'), taskId: str('任务 ID') }, required: ['text'] },
    async run(args = {}) {
      try {
        const id = resolveTaskId(args.taskId)
        const r = await taskAction(id, 'log', { text: args.text, kind: 'agent', sessionId: null })
        getMirror().writeTaskCard(r.task)
        return ok(`已记录到任务 ${id} 的工作日志（共 ${r.task?.log?.length ?? '?'} 条）`)
      } catch (err) {
        return fail(err)
      }
    },
  },
  {
    name: 'company_task_update',
    description: '更新任务卡文本：submission 提交内容，content 任务内容。不传 taskId 时写当前绑定任务。',
    inputSchema: {
      type: 'object',
      properties: {
        submission: str('提交内容（做了什么、交了什么）'),
        content: str('任务内容'),
        taskId: str('任务 ID'),
      },
    },
    async run(args = {}) {
      try {
        const id = resolveTaskId(args.taskId)
        const patch = { sessionId: null }
        if (args.submission !== undefined) Object.assign(patch, { submission: args.submission, adopt: 'submission' })
        if (args.content !== undefined) Object.assign(patch, { content: args.content, adopt: patch.adopt ?? 'content' })
        const r = await patchTask(id, patch)
        getMirror().writeTaskCard(r.task)
        return ok(`任务 ${id} 已更新（状态 ${r.task?.statusLabel ?? r.task?.status}）`)
      } catch (err) {
        return fail(err)
      }
    },
  },
  {
    name: 'company_task_attach',
    description: '把本机文件作为交付物挂到任务卡（上传到公司盘 projects/inbox/<任务ID>/）。口头完成不算完成。路径建议用绝对路径。不传 taskId 时挂到当前绑定任务。',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: str('本机文件路径'), description: '本机文件路径（建议绝对路径；相对路径按当前工作目录解析）' },
        taskId: str('任务 ID'),
      },
      required: ['paths'],
    },
    async run(args = {}) {
      try {
        const id = resolveTaskId(args.taskId)
        const baseDir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
        const files = []
        for (const p of args.paths ?? []) {
          const full = path.resolve(baseDir, p)
          let st
          try {
            st = fs.statSync(full)
          } catch {
            throw new Error(`找不到文件 ${full}（建议传绝对路径）`)
          }
          if (!st.isFile()) throw new Error(`${p} 不是文件`)
          if (st.size > 50 * 1024 * 1024) throw new Error(`${p} 超过 50MB`)
          files.push({
            name: path.basename(full),
            dataBase64: fs.readFileSync(full).toString('base64'),
            source: 'agent',
            sessionId: null,
            localPath: full,
          })
        }
        if (!files.length) throw new Error('paths 为空：至少给一个本机文件')
        const r = await addDeliverables(id, files)
        getMirror().writeTaskCard(r.task)
        getMirror().pull().catch(() => {})
        return ok(`已挂载 ${files.length} 个交付物到任务 ${id}：${(r.task?.deliverables ?? []).map((d) => d.name).join('、')}。下一步：写提交内容（company_task_update）后 company_task_submit 选审核人提交验收。`)
      } catch (err) {
        return fail(err)
      }
    },
  },
  {
    name: 'company_task_submit',
    description:
      '把任务卡提交验收，进入待审。必须先有交付物。审核人可以是任意同事，不限总监或管理员，不能是自己。不传 reviewerId 时返回可选审核人列表，再带 reviewerId 调一次。不传 taskId 时用绑定的任务。',
    inputSchema: { type: 'object', properties: { reviewerId: str('审核人用户 id（任意同事，不能是自己）；省略则先列出候选人'), taskId: str('任务 ID') } },
    async run(args = {}) {
      try {
        const id = resolveTaskId(args.taskId)
        const task = await fetchAndCard(id)
        const me = loadState().user
        if (!canSubmit(task, me)) throw new Error(workflowHint(task))
        if (!hasDeliverables(task)) throw new Error('口头完成不算完成：请先 company_task_attach 挂交付物再提交验收')
        const people = await listPeople()
        const options = reviewerOptions(people.users ?? [], me)
        if (!options.length) throw new Error('没有可选审核人（不能是自己；停用账号不可选）')
        if (!args.reviewerId) {
          const text = `请选择审核人后再次调用 company_task_submit，传入 reviewerId：\n${options.map((o) => `- ${o.id}  ${o.label}`).join('\n')}`
          return ok(text, { taskId: id, reviewers: options })
        }
        const next = await persistTask(await taskAction(id, 'submit', { reviewerId: args.reviewerId }))
        saveState({ currentTaskId: next.id })
        return ok(`已提交验收 ${next.id}「${next.title}」（${next.statusLabel ?? next.status}）。${workflowHint(next)}`, next)
      } catch (err) {
        return fail(err)
      }
    },
  },
  {
    name: 'company_task_review',
    description: '初审任务卡。decision=pass 进入待终审，reject 驳回。仅指定审核人或管理员。不传 taskId 时用绑定的任务。',
    inputSchema: {
      type: 'object',
      properties: { decision: enumOf(['pass', 'reject'], 'pass 通过 → 待终审；reject 驳回'), comment: str('审核意见'), taskId: str('任务 ID') },
      required: ['decision'],
    },
    async run(args = {}) {
      try {
        const decision = assertDecision(args.decision)
        const id = resolveTaskId(args.taskId)
        const task = await fetchAndCard(id)
        if (!canReview(task, loadState().user)) throw new Error(workflowHint(task))
        const next = await persistTask(await taskAction(id, 'review', { decision, comment: args.comment ?? '' }))
        return ok(`${decision === 'pass' ? '初审通过 → 待终审' : '初审驳回'} ${next.id}「${next.title}」`, next)
      } catch (err) {
        return fail(err)
      }
    },
  },
  {
    name: 'company_task_final',
    description: '终审任务卡。decision=pass 通过，reject 驳回。仅管理员或派单的总监。不传 taskId 时用绑定的任务。',
    inputSchema: {
      type: 'object',
      properties: { decision: enumOf(['pass', 'reject'], 'pass 通过；reject 驳回'), comment: str('终审意见'), taskId: str('任务 ID') },
      required: ['decision'],
    },
    async run(args = {}) {
      try {
        const decision = assertDecision(args.decision)
        const id = resolveTaskId(args.taskId)
        const task = await fetchAndCard(id)
        if (!canFinalize(task, loadState().user)) throw new Error(workflowHint(task))
        const next = await persistTask(await taskAction(id, 'final', { decision, comment: args.comment ?? '' }))
        return ok(`${decision === 'pass' ? '终审通过' : '终审驳回'} ${next.id}「${next.title}」`, next)
      } catch (err) {
        return fail(err)
      }
    },
  },
  {
    name: 'company_memory_write',
    description:
      '把经验/方法/证据/复盘写进公司盘记忆（Markdown）。zone=personal 写到 _office/<账号>/_memory；zone=shared 写到 _shared/_memory（员工只能追加 05-logs）。path 相对 _memory：01-projects / 02-methods / 03-evidence / 04-reviews / 05-logs / 90-system。',
    inputSchema: {
      type: 'object',
      properties: {
        zone: enumOf(['personal', 'shared'], 'personal 个人记忆；shared 公司共享'),
        path: str('相对 _memory 的路径，如 02-methods/详情页模块顺序.md'),
        content: str('Markdown 正文'),
        append: bool('追加而不是覆盖（05-logs / 90-system 必须追加）'),
      },
      required: ['zone', 'path', 'content'],
    },
    async run(args = {}) {
      try {
        if (!['personal', 'shared'].includes(args.zone)) throw new Error('zone 只能是 personal 或 shared')
        const base = zoneRoot(args.zone, username())
        const rel = zonePath(args.zone, args.path)
        if (rel === base) throw new Error('path 要指到具体文件，如 02-methods/xxx.md')
        const append = !!args.append || /^(05-logs|90-system)\//.test(rel.slice(base.length + 1))
        const buf = Buffer.from(String(args.content ?? ''), 'utf8')
        const mirror = getMirror()
        const r = await mirror.gateway.put(`/api/drive/file?path=${encodeURIComponent(rel)}${append ? '&append=1' : ''}`, buf, {
          raw: true,
          headers: { 'content-type': 'application/octet-stream' },
        })
        // 本机镜像跟着更新并记为已同步，否则下一轮会把它当成本地新改再推一次
        const local = mirror.abs(rel)
        let where = `本机镜像 ${local}`
        if (!append) {
          writeFileAtomic(local, buf)
          mirror.markSynced(rel, buf)
        } else if (mirror.isInSync(rel)) {
          fs.appendFileSync(local, buf)
          mirror.markSynced(rel, fs.readFileSync(local))
        } else {
          // 本机没有这份或已被本地改过：不在本机拼半截，交给下一次拉取
          mirror.pull().catch(() => {})
          where = `本机镜像稍后同步到 ${local}`
        }
        const file = r?.file ?? {}
        return ok(`已写入公司盘 ${file.path ?? rel}（${file.size ?? ''} 字节）${append ? '（追加）' : ''}；${where}`)
      } catch (err) {
        return fail(err)
      }
    },
  },
  {
    name: 'company_memory_read',
    readOnly: true,
    description: '读取公司盘记忆文件。zone=personal / shared / handbook。',
    inputSchema: {
      type: 'object',
      properties: { zone: enumOf(['personal', 'shared', 'handbook'], '公司盘分区'), path: str('相对该区的文件路径') },
      required: ['zone', 'path'],
    },
    async run(args = {}) {
      try {
        const rel = zonePath(args.zone, args.path)
        const buf = await getMirror().gateway.get(`/api/drive/file?path=${encodeURIComponent(rel)}`)
        const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : JSON.stringify(buf)
        return ok(text)
      } catch (err) {
        return fail(err)
      }
    },
  },
  {
    name: 'company_memory_list',
    readOnly: true,
    description: '列出公司盘记忆目录（personal / shared / handbook）。',
    inputSchema: {
      type: 'object',
      properties: { zone: enumOf(['personal', 'shared', 'handbook'], '公司盘分区'), path: str('相对该区的子目录，默认根') },
      required: ['zone'],
    },
    async run(args = {}) {
      try {
        const rel = zonePath(args.zone, args.path)
        const r = await getMirror().gateway.get(`/api/drive/list?path=${encodeURIComponent(rel)}`)
        const items = Array.isArray(r?.items) ? r.items : []
        if (!items.length) return ok(`${rel}/ 为空`)
        const text = items.map((it) => `${it.isDir ? 'dir' : 'file'} ${it.path}${it.isDir ? '' : ` (${it.size} B, ${it.mtime})`}`).join('\n')
        return ok(text, r)
      } catch (err) {
        return fail(err)
      }
    },
  },
  {
    name: 'company_drive_sync',
    description: '手动同步公司盘本机镜像：回推个人记忆 + 拉取可见文件。会话开始后后台每 30 秒也会自动同步一次。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      try {
        const r = await syncDrive()
        return ok(`公司盘已同步：远端 ${r.files} 个，下载 ${r.pulled}，回推 ${r.pushed}；本机镜像 ${getMirror().root}`, r)
      } catch (err) {
        return fail(err)
      }
    },
  },
]

/** tools/list 的形状：去掉处理器和内部标记。 */
export function listTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.readOnly ? { annotations: { readOnlyHint: true } } : {}),
  }))
}

export function findTool(name) {
  return TOOLS.find((t) => t.name === name) ?? null
}

export async function callTool(name, args) {
  const tool = findTool(name)
  if (!tool) return fail(new Error(`未知工具 ${name}`))
  return tool.run(args ?? {})
}
