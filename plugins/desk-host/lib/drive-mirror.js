/**
 * 公司盘本机镜像：把本人可见的公司盘（共享经验 / 个人记忆 / 相关任务收件箱）同步到本机目录，
 * 让本机 Agent 用普通文件工具就能读到；个人记忆区的本地修改可回推网关。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { persistedIndexMethods } from '../../../scripts/lib/drive-mirror-index.mjs'

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

export class DriveMirror {
  constructor({ root, gateway, state, log }) {
    this.root = root
    this.gateway = gateway
    this.state = state
    this.log = log ?? (() => {})
    this.initPersistedIndex()
    fs.mkdirSync(root, { recursive: true })
    this.tombPath = path.join(root, '.deleted-remote.json')
    this.tomb = new Set(this.loadTomb())
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
      /* 写不进就只在本会话生效 */
    }
  }

  abs(rel) {
    // 前缀必须落在整段路径分隔符上：只比较字符串前缀会让「根目录同名兄弟目录」越过防线
    const rootRes = path.resolve(this.root)
    const full = path.resolve(this.root, rel)
    if (full !== rootRes && !full.startsWith(rootRes + path.sep)) throw new Error('路径越界')
    return full
  }

  /** 排队门闩：push / pull / sync 共享 index 与 tomb，并发会双写。后到的操作等当前结束再跑（不合并，避免 attach 之后拿到过期 pull）。 */
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
          '- `_shared/handbook/` 岗位手册 / 公司技能手册',
          `- \`_office/${me ?? '<账号>'}/_memory/\` 个人记忆（跟人走，换电脑还在）`,
          '- `projects/inbox/<任务ID>/` 任务交付物（每个任务目录内的 `_task-card.md` 是任务卡，`_worklog.md` 是工作日志）',
          '',
          '本目录由 THE DIVA 客户端自动与公司网关同步；Agent 用 `company_memory_write` 写记忆，用 `company_task_attach` 把产物挂到任务卡。',
          '',
        ].join('\n'),
      )
    }
  }

  /** 任务在本机镜像里的目录（公司盘收件箱格子）。 */
  taskDir(taskId) {
    return this.abs(`projects/inbox/${taskId}`)
  }

  /** 把任务卡/工作日志写成本机可读文件（不会上传为交付物）。 */
  writeTaskCard(task) {
    const dir = this.abs(`projects/inbox/${task.id}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '_task-card.json'), JSON.stringify(task, null, 2))
    const who = (p) => (p ? `${p.displayName || p.username}（${p.username}）` : '—')
    const md = [
      `# 任务卡 ${task.id}：${task.title}`,
      '',
      `- 状态：${task.statusLabel}`,
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
      ...(task.deliverables.length ? task.deliverables.map((d) => `- ${d.name}（${d.size} B，${d.source}${d.sessionId ? `，来自进程 ${d.sessionId}` : ''}）`) : ['（尚无交付物 —— 口头完成不算完成）']),
      '',
      '## 关联进程',
      '',
      ...(task.sessions.length ? task.sessions.map((s) => `- ${s.sessionId}${s.title ? `「${s.title}」` : ''} 绑定于 ${s.boundAt}`) : ['（无）']),
      '',
    ].join('\n')
    fs.writeFileSync(path.join(dir, '_task-card.md'), md)
    const log = ['# 工作日志', '', ...task.log.map((l) => `- ${l.ts} ${l.actorName} [${l.kind}] ${l.text}${l.sessionId ? `（进程 ${l.sessionId}）` : ''}`), ''].join('\n')
    fs.writeFileSync(path.join(dir, '_worklog.md'), log)
    return dir
  }
}

Object.assign(DriveMirror.prototype, persistedIndexMethods)
