/**
 * 公司盘本机镜像：把本人可见的公司盘（共享经验 / 个人记忆 / 相关任务收件箱）同步到本机目录，
 * 让本机 Agent 用普通文件工具就能读到；个人记忆区的本地修改可回推网关。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

export class DriveMirror {
  constructor({ root, gateway, state, log }) {
    this.root = root
    this.gateway = gateway
    this.state = state
    this.log = log ?? (() => {})
    this.index = new Map() // rel -> sha256（上次同步时远端状态）
    this.syncing = null
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

  /** 拉取：远端快照 → 下载变更文件；返回统计。 */
  async pull() {
    if (this.syncing) return this.syncing
    this.syncing = (async () => {
      const snap = await this.gateway.get('/api/drive/snapshot')
      let downloaded = 0
      const remote = new Set()
      for (const f of snap.files) {
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
        // 本地被改过且远端没变：属于待回推，不覆盖
        if (localSha !== undefined && this.index.get(f.path) === f.sha256) continue
        const buf = await this.gateway.get(`/api/drive/file?path=${encodeURIComponent(f.path)}`)
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, buf)
        this.index.set(f.path, f.sha256)
        downloaded++
      }
      // 远端删除：本地保留副本（避免误删用户文件），但不再跟踪。个人区的删除要记墓碑 ——
      // 不记的话下一轮 pushPersonal 会把这个旧副本当成“本地新增”传回去，删除永远无法收敛。
      const me = this.state.data.user?.username
      const myPrefix = `_office/${me}/`
      for (const rel of [...this.index.keys()]) {
        if (remote.has(rel)) {
          if (this.tomb.delete(rel)) this.saveTomb() // 远端重现（恢复/重新上传）：取消墓碑
          continue
        }
        if (me && rel.startsWith(myPrefix)) {
          this.tomb.add(rel)
          this.saveTomb()
        }
        this.index.delete(rel)
      }
      this.ensureLayout(snap)
      // 只在有变化或首次同步时打日志，避免心跳把日志刷屏
      if (downloaded || !this.everSynced) this.log(`公司盘同步完成：${snap.files.length} 个文件，下载 ${downloaded} 个`)
      this.everSynced = true
      return { files: snap.files.length, downloaded }
    })().finally(() => {
      this.syncing = null
    })
    return this.syncing
  }

  /** 回推：个人记忆区内本地新增/修改的文件写回网关。 */
  async pushPersonal() {
    const me = this.state.data.user?.username
    if (!me) return { pushed: 0 }
    const base = `_office/${me}`
    const dir = this.abs(base)
    if (!fs.existsSync(dir)) return { pushed: 0 }
    let pushed = 0
    const walk = (rel, tomb) => {
      for (const d of fs.readdirSync(this.abs(rel), { withFileTypes: true })) {
        if (d.name.startsWith('.')) continue
        const childRel = `${rel}/${d.name}`
        if (d.isDirectory()) walk(childRel, tomb)
        else {
          // 墓碑 = 网关那边已删除、我们不回推的旧副本（先于读盘/哈希拦截）
          if (tomb.includes(childRel)) continue
          const buf = fs.readFileSync(this.abs(childRel))
          if (buf.length > 20 * 1024 * 1024) continue
          const sha = sha256(buf)
          if (this.index.get(childRel) === sha) continue
          pushed++
          this.pending.push({ rel: childRel, buf, sha })
        }
      }
    }
    this.pending = []
    const liveTomb = new Set([...this.tomb].filter((r) => r.startsWith(base + '/')))
    walk(base, liveTomb)
    for (const p of this.pending) {
      await this.gateway.put(`/api/drive/file?path=${encodeURIComponent(p.rel)}`, p.buf, { raw: true, headers: { 'content-type': 'application/octet-stream' } })
      this.index.set(p.rel, p.sha)
      if (this.tomb.delete(p.rel)) this.saveTomb()
    }
    if (pushed) this.log(`个人记忆回推 ${pushed} 个文件`)
    return { pushed }
  }

  async sync() {
    // 整体串行化：pushPersonal 与 pull 共享 this.index/this.tomb，心跳与手动/attach 并发会双写同一批判定
    if (this.syncBusy) return this.syncBusy
    this.syncBusy = (async () => {
      const { pushed } = await this.pushPersonal()
      const r = await this.pull()
      this.state.data.lastSyncAt = new Date().toISOString()
      this.state.save()
      return { ...r, pulled: r.downloaded, pushed }
    })().finally(() => {
      this.syncBusy = null
    })
    return this.syncBusy
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
