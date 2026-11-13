/**
 * 公司盘本机镜像：把本人可见的公司盘同步到 ~/.valimart/valimart-drive，Agent 用普通文件工具就能读；个人记忆回推网关。
 * 同步与索引落盘走共用的 scripts/lib/drive-mirror-index.mjs（pi、桌面端、VS Code 同一份）：
 * valimart 每次启动都是新进程，MCP 服务也随会话起停，内存索引一清空，本机旧副本就会被当成「本地新改」回推。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { persistedIndexMethods, writeFileAtomic } from './drive-mirror-index.mjs'
import { assertInside } from './drive-paths.mjs'

export { writeFileAtomic }

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

export class DriveMirror {
  constructor({ root, gateway, state, log }) {
    this.root = root
    this.gateway = gateway
    this.state = state
    this.log = log ?? (() => {})
    fs.mkdirSync(root, { recursive: true })
    this.initPersistedIndex()
    this.tombPath = path.join(root, '.deleted-remote.json')
    this.tomb = new Set(this.loadTomb())
  }

  /** 排队门闩：push / pull / sync 共享 index 与 tomb，并发会双写。后到的操作等当前结束再跑。 */
  async runExclusive(fn) {
    const prev = this.syncBusy ?? Promise.resolve()
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const next = prev.then(() => gate)
    this.syncBusy = next
    await prev.catch(() => {})
    try {
      return await fn()
    } finally {
      release()
      if (this.syncBusy === next) this.syncBusy = null
    }
  }

  loadTomb() {
    try {
      return JSON.parse(fs.readFileSync(this.tombPath, 'utf8'))
    } catch {
      return []
    }
  }

  saveTomb() {
    try {
      fs.writeFileSync(this.tombPath, JSON.stringify([...this.tomb]))
    } catch {
      /* ignore */
    }
  }

  abs(rel) {
    return assertInside(this.root, rel)
  }

  /** 本进程刚把这份内容写进了远端：记为已同步，下一轮就不会再回推。 */
  markSynced(rel, buf) {
    this.index.set(rel, sha256(buf))
    this.saveIndex()
  }

  /** 本机文件仍是上次同步的那一份（没被本地改过）。 */
  isInSync(rel) {
    try {
      return this.index.get(rel) === sha256(fs.readFileSync(this.abs(rel)))
    } catch {
      return false
    }
  }

  ensureLayout(snap) {
    const layers = snap?.memoryLayers ?? []
    const me = this.state.data.user?.username
    for (const l of layers) {
      fs.mkdirSync(this.abs(`_shared/_memory/${l.dir}`), { recursive: true })
      if (me) fs.mkdirSync(this.abs(`_office/${me}/_memory/${l.dir}`), { recursive: true })
    }
    fs.mkdirSync(this.abs('projects/inbox'), { recursive: true })
    const readme = this.abs('README.md')
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(
        readme,
        [
          '# 公司盘（本机镜像）',
          '',
          '- `_shared/_memory/` 共享经验（全员只读；总监/管理员可写；05-logs 可追加）',
          '- `_shared/handbook/` 岗位手册 / 公司技能',
          `- \`_office/${me ?? '<账号>'}/_memory/\` 个人记忆（跟人走，换电脑还在）`,
          '- `projects/inbox/<任务ID>/` 任务交付物（`_task-card.md` 任务卡，`_worklog.md` 工作日志）',
          '',
          '本目录由 valimart code 与公司网关同步。Agent 用 company_memory_write 写记忆，用 company_task_attach 把产物挂到任务卡。',
          '',
        ].join('\n'),
      )
    }
  }

  taskDir(taskId) {
    return this.abs(`projects/inbox/${taskId}`)
  }

  writeTaskCard(task) {
    const dir = this.abs(`projects/inbox/${task.id}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '_task-card.json'), JSON.stringify(task, null, 2))
    const who = (p) => (p ? `${p.displayName || p.username}（${p.username}）` : '—')
    const md = [
      `# 任务卡 ${task.id}：${task.title}`,
      '',
      `- 状态：${task.statusLabel ?? task.status}`,
      `- 派单人：${who(task.assigner)}`,
      `- 提交人：${who(task.assignee)}`,
      `- 部门：${task.department ?? '—'}　项目：${task.project || '—'}`,
      `- 审核人：${who(task.reviewer)}　终审人：${who(task.finalReviewer)}`,
      `- 创建：${task.createdAt}　提交：${task.submittedAt ?? '—'}`,
      '',
      '## 任务内容',
      '',
      task.content || '（空）',
      '',
      '## 提交内容',
      '',
      task.submission || '（空）',
      '',
      '## 交付物',
      '',
      ...(Array.isArray(task.deliverables) && task.deliverables.length
        ? task.deliverables.map((d) => `- ${d.name}（${d.size} B，${d.source}${d.sessionId ? `，来自进程 ${d.sessionId}` : ''}）`)
        : ['（尚无交付物 —— 口头完成不算完成）']),
      '',
      '## 关联进程',
      '',
      ...(Array.isArray(task.sessions) && task.sessions.length
        ? task.sessions.map((s) => `- ${s.sessionId}${s.title ? `「${s.title}」` : ''} 绑定于 ${s.boundAt}`)
        : ['（无）']),
      '',
    ].join('\n')
    fs.writeFileSync(path.join(dir, '_task-card.md'), md)
    const logLines = Array.isArray(task.log) ? task.log : []
    const log = ['# 工作日志', '', ...logLines.map((l) => `- ${l.ts} ${l.actorName} [${l.kind}] ${l.text}${l.sessionId ? `（进程 ${l.sessionId}）` : ''}`), ''].join('\n')
    fs.writeFileSync(path.join(dir, '_worklog.md'), log)
    return dir
  }
}

Object.assign(DriveMirror.prototype, persistedIndexMethods)
