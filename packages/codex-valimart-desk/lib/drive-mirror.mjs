/** 公司盘本机镜像；同步索引落盘，多个 Codex 会话/MCP 进程不会把旧副本误判成本地修改。 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { assertInside } from './drive-paths.mjs'

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

export function writeFileAtomic(full, data) {
  fs.mkdirSync(path.dirname(full), { recursive: true })
  const tmp = path.join(path.dirname(full), `.${path.basename(full)}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, data)
  try { fs.renameSync(tmp, full) } catch {
    fs.rmSync(tmp, { force: true })
    fs.writeFileSync(full, data)
  }
}

export class DriveMirror {
  constructor({ root, gateway, state, log }) {
    this.root = root
    this.gateway = gateway
    this.state = state
    this.log = log ?? (() => {})
    fs.mkdirSync(root, { recursive: true })
    this.indexPath = path.join(root, '.sync-index.json')
    this.index = this.loadIndex() ?? new Map()
    this.tombPath = path.join(root, '.deleted-remote.json')
    this.tomb = new Set(this.loadTomb())
  }

  loadIndex() {
    try { return new Map(Object.entries(JSON.parse(fs.readFileSync(this.indexPath, 'utf8')))) } catch { return null }
  }

  saveIndex() { try { writeFileAtomic(this.indexPath, JSON.stringify(Object.fromEntries(this.index))) } catch { /* 只在本进程生效 */ } }
  reloadIndex() { const disk = this.loadIndex(); if (disk) this.index = disk }
  markSynced(rel, buf) { this.index.set(rel, sha256(buf)); this.saveIndex() }
  isInSync(rel) { try { return this.index.get(rel) === sha256(fs.readFileSync(this.abs(rel))) } catch { return false } }
  loadTomb() { try { return JSON.parse(fs.readFileSync(this.tombPath, 'utf8')) } catch { return [] } }
  saveTomb() { try { fs.writeFileSync(this.tombPath, JSON.stringify([...this.tomb])) } catch { /* ignore */ } }
  abs(rel) { return assertInside(this.root, rel) }

  async runExclusive(fn) {
    const prev = this.syncBusy ?? Promise.resolve()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const next = prev.then(() => gate)
    this.syncBusy = next
    await prev.catch(() => {})
    try { return await fn() } finally { release(); if (this.syncBusy === next) this.syncBusy = null }
  }

  pull() { return this.runExclusive(() => { this.reloadIndex(); return this.pullNow() }) }

  async pullNow() {
    const snap = await this.gateway.get('/api/drive/snapshot')
    let downloaded = 0
    const remote = new Set()
    for (const file of snap.files ?? []) {
      remote.add(file.path)
      const full = this.abs(file.path)
      let localSha
      try { localSha = sha256(fs.readFileSync(full)) } catch { localSha = undefined }
      if (localSha === file.sha256) { this.index.set(file.path, file.sha256); continue }
      if (localSha !== undefined && this.index.get(file.path) === file.sha256) continue
      writeFileAtomic(full, await this.gateway.get(`/api/drive/file?path=${encodeURIComponent(file.path)}`))
      this.index.set(file.path, file.sha256)
      downloaded++
    }
    const username = this.state.data.user?.username
    const personalPrefix = `_office/${username}/`
    for (const rel of [...this.index.keys()]) {
      if (remote.has(rel)) { if (this.tomb.delete(rel)) this.saveTomb(); continue }
      if (username && rel.startsWith(personalPrefix)) { this.tomb.add(rel); this.saveTomb() }
      this.index.delete(rel)
    }
    this.saveIndex()
    this.ensureLayout(snap)
    return { files: (snap.files ?? []).length, downloaded }
  }

  pushPersonal() { return this.runExclusive(() => { this.reloadIndex(); return this.pushPersonalNow() }) }

  async pushPersonalNow() {
    const username = this.state.data.user?.username
    if (!username || !fs.existsSync(this.abs(`_office/${username}`))) return { pushed: 0 }
    const base = `_office/${username}`
    const pending = []
    const walk = (rel, tomb) => {
      for (const item of fs.readdirSync(this.abs(rel), { withFileTypes: true })) {
        if (item.name.startsWith('.')) continue
        const child = `${rel}/${item.name}`
        if (item.isDirectory()) walk(child, tomb)
        else if (!tomb.has(child)) {
          const buf = fs.readFileSync(this.abs(child))
          if (buf.length <= 20 * 1024 * 1024 && this.index.get(child) !== sha256(buf)) pending.push({ rel: child, buf, sha: sha256(buf) })
        }
      }
    }
    walk(base, new Set([...this.tomb].filter((rel) => rel.startsWith(`${base}/`))))
    for (const item of pending) {
      await this.gateway.put(`/api/drive/file?path=${encodeURIComponent(item.rel)}`, item.buf, { raw: true, headers: { 'content-type': 'application/octet-stream' } })
      this.index.set(item.rel, item.sha)
      if (this.tomb.delete(item.rel)) this.saveTomb()
    }
    if (pending.length) this.saveIndex()
    return { pushed: pending.length }
  }

  async sync() {
    return this.runExclusive(async () => {
      this.reloadIndex()
      let result
      let pushed
      if (this.index.size === 0) { result = await this.pullNow(); ({ pushed } = await this.pushPersonalNow()) }
      else { ({ pushed } = await this.pushPersonalNow()); result = await this.pullNow() }
      this.state.data.lastSyncAt = new Date().toISOString()
      this.state.save()
      return { ...result, pulled: result.downloaded, pushed }
    })
  }

  ensureLayout(snap) {
    const username = this.state.data.user?.username
    for (const layer of snap?.memoryLayers ?? []) {
      fs.mkdirSync(this.abs(`_shared/_memory/${layer.dir}`), { recursive: true })
      if (username) fs.mkdirSync(this.abs(`_office/${username}/_memory/${layer.dir}`), { recursive: true })
    }
    fs.mkdirSync(this.abs('projects/inbox'), { recursive: true })
  }

  writeTaskCard(task) {
    const dir = this.abs(`projects/inbox/${task.id}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '_task-card.json'), JSON.stringify(task, null, 2))
    const who = (person) => (person ? `${person.displayName || person.username}（${person.username}）` : '—')
    const md = [
      `# 任务卡 ${task.id}：${task.title}`, '', `- 状态：${task.statusLabel ?? task.status}`,
      `- 派单人：${who(task.assigner)}`, `- 提交人：${who(task.assignee)}`, `- 审核人：${who(task.reviewer)}　终审人：${who(task.finalReviewer)}`, '',
      '## 任务内容', '', task.content || '（空）', '', '## 提交内容', '', task.submission || '（空）', '',
      '## 交付物', '', ...(task.deliverables?.length ? task.deliverables.map((item) => `- ${item.name}（${item.size} B）`) : ['（尚无交付物 —— 口头完成不算完成）']), '',
    ].join('\n')
    fs.writeFileSync(path.join(dir, '_task-card.md'), md)
    const log = ['# 工作日志', '', ...(task.log ?? []).map((item) => `- ${item.ts} ${item.actorName} [${item.kind}] ${item.text}`), ''].join('\n')
    fs.writeFileSync(path.join(dir, '_worklog.md'), log)
    return dir
  }
}
