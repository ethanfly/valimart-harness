/**
 * 公司盘本机镜像：把本人可见的公司盘同步到本机，Agent 用普通文件工具即可读；个人记忆可回推网关。
 * 行为对齐 plugins/desk-host/lib/drive-mirror.js。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { assertInside } from './drive-paths.mjs'

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

export class DriveMirror {
  constructor({ root, gateway, state, log }) {
    this.root = root
    this.gateway = gateway
    this.state = state
    this.log = log ?? (() => {})
    this.index = new Map()
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
      /* ignore */
    }
  }

  abs(rel) {
    return assertInside(this.root, rel)
  }

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

  async pull() {
    return this.runExclusive(() => this.pullNow())
  }

  async pullNow() {
    const snap = await this.gateway.get('/api/drive/snapshot')
    let downloaded = 0
    const remote = new Set()
    for (const f of snap.files ?? []) {
      remote.add(f.path)
      const full = this.abs(f.path)
      let localSha
      try {
        localSha = sha256(fs.readFileSync(full))
      } catch {
        localSha = undefined
      }
      if (localSha === f.sha256) {
        this.index.set(f.path, f.sha256)
        continue
      }
      if (localSha !== undefined && this.index.get(f.path) === f.sha256) continue
      const buf = await this.gateway.get(`/api/drive/file?path=${encodeURIComponent(f.path)}`)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, buf)
      this.index.set(f.path, f.sha256)
      downloaded++
    }
    const me = this.state.data.user?.username
    const myPrefix = `_office/${me}/`
    for (const rel of [...this.index.keys()]) {
      if (remote.has(rel)) {
        if (this.tomb.delete(rel)) this.saveTomb()
        continue
      }
      if (me && rel.startsWith(myPrefix)) {
        this.tomb.add(rel)
        this.saveTomb()
      }
      this.index.delete(rel)
    }
    this.ensureLayout(snap)
    if (downloaded || !this.everSynced) this.log(`公司盘同步完成：${(snap.files ?? []).length} 个文件，下载 ${downloaded} 个`)
    this.everSynced = true
    return { files: (snap.files ?? []).length, downloaded }
  }

  async pushPersonal() {
    return this.runExclusive(() => this.pushPersonalNow())
  }

  async pushPersonalNow() {
    const me = this.state.data.user?.username
    if (!me) return { pushed: 0 }
    const base = `_office/${me}`
    const dir = this.abs(base)
    if (!fs.existsSync(dir)) return { pushed: 0 }
    let pushed = 0
    const pending = []
    const walk = (rel, tomb) => {
      for (const d of fs.readdirSync(this.abs(rel), { withFileTypes: true })) {
        if (d.name.startsWith('.')) continue
        const childRel = `${rel}/${d.name}`
        if (d.isDirectory()) walk(childRel, tomb)
        else {
          if (tomb.has(childRel)) continue
          const buf = fs.readFileSync(this.abs(childRel))
          if (buf.length > 20 * 1024 * 1024) continue
          const sha = sha256(buf)
          if (this.index.get(childRel) === sha) continue
          pushed++
          pending.push({ rel: childRel, buf, sha })
        }
      }
    }
    const liveTomb = new Set([...this.tomb].filter((r) => r.startsWith(`${base}/`)))
    walk(base, liveTomb)
    for (const p of pending) {
      await this.gateway.put(`/api/drive/file?path=${encodeURIComponent(p.rel)}`, p.buf, {
        raw: true,
        headers: { 'content-type': 'application/octet-stream' },
      })
      this.index.set(p.rel, p.sha)
      if (this.tomb.delete(p.rel)) this.saveTomb()
    }
    if (pushed) this.log(`个人记忆回推 ${pushed} 个文件`)
    return { pushed }
  }

  async sync() {
    return this.runExclusive(async () => {
      const { pushed } = await this.pushPersonalNow()
      const r = await this.pullNow()
      this.state.data.lastSyncAt = new Date().toISOString()
      this.state.save()
      return { ...r, pulled: r.downloaded, pushed }
    })
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
          '本目录由 valimart pi desk 与公司网关同步。Agent 用 company_memory_write 写记忆，用 company_task_attach 把产物挂到任务卡。',
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
