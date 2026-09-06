/**
 * 任务卡与四格验收：
 *   draft(进行中) → pending_review(待审) → pending_final(待终审) → approved(通过) | rejected(驳回)
 * 口头完成不算：提交验收必须至少有一个交付物（公司盘 projects/inbox/<任务ID>/ 下的文件）。
 */
import { HttpError } from './http.js'
import { newId } from './db.js'

export const TASK_STATUS = {
  draft: '进行中',
  pending_review: '待审',
  pending_final: '待终审',
  approved: '通过',
  rejected: '驳回',
}

export class Tasks {
  constructor(db, drive) {
    this.db = db
    this.drive = drive
  }

  all() {
    return this.db.tasks.load().items
  }

  get(id) {
    return this.all().find((t) => t.id === id)
  }

  mustGet(id) {
    const t = this.get(id)
    if (!t) throw new HttpError(404, '任务不存在', 'task_not_found')
    return t
  }

  isParticipant(task, user) {
    return [task.assigneeId, task.assignerId, task.reviewerId, task.finalReviewerId].includes(user.id)
  }

  canView(task, user) {
    if (user.role === 'admin') return true
    if (user.role === 'director' && (task.department === user.department || this.isParticipant(task, user))) return true
    return this.isParticipant(task, user)
  }

  visibleTo(user) {
    return this.all()
      .filter((t) => this.canView(t, user))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  }

  log(task, actor, kind, text, extra = {}) {
    task.log.push({ id: newId('lg-', 4), ts: new Date().toISOString(), actorId: actor.id, actorName: actor.displayName || actor.username, kind, text, ...extra })
    task.updatedAt = new Date().toISOString()
  }

  create(user, input) {
    const assignee = input.assigneeId ? this.db.getUser(input.assigneeId) : user
    if (!assignee) throw new HttpError(400, '被派人不存在')
    if (assignee.id !== user.id && user.role === 'employee') throw new HttpError(403, '员工只能给自己建任务卡')
    const now = new Date().toISOString()
    const task = {
      id: newId('tk-', 5),
      title: (input.title ?? '').trim() || '未命名报告',
      content: input.content ?? '',
      submission: input.submission ?? '',
      project: input.project ?? '',
      department: input.department ?? assignee.department ?? user.department,
      assignerId: user.id,
      assigneeId: assignee.id,
      reviewerId: null,
      finalReviewerId: null,
      status: 'draft',
      deliverables: [],
      sessions: [],
      log: [],
      createdAt: now,
      updatedAt: now,
      submittedAt: null,
      reviewedAt: null,
      finalizedAt: null,
      review: null,
      final: null,
    }
    this.drive.ensureInbox(task.id)
    this.log(task, user, 'created', `创建任务卡「${task.title}」，派给 ${assignee.displayName || assignee.username}`)
    this.db.tasks.update((d) => d.items.push(task))
    return task
  }

  update(id, user, patch) {
    return this.db.tasks.update(() => {
      const task = this.mustGet(id)
      if (!this.canView(task, user)) throw new HttpError(403, '无权查看该任务')
      const editable = user.role === 'admin' || task.assigneeId === user.id || task.assignerId === user.id
      if (!editable) throw new HttpError(403, '只有派单人/提交人可以修改任务卡')
      const changes = []
      for (const key of ['title', 'content', 'submission', 'project', 'department']) {
        if (patch[key] !== undefined && patch[key] !== task[key]) {
          task[key] = patch[key]
          changes.push(key)
        }
      }
      if (patch.assigneeId && patch.assigneeId !== task.assigneeId) {
        if (user.role === 'employee') throw new HttpError(403, '员工不能改派任务')
        const a = this.db.getUser(patch.assigneeId)
        if (!a) throw new HttpError(400, '被派人不存在')
        task.assigneeId = a.id
        changes.push('assignee')
        this.log(task, user, 'assign', `改派给 ${a.displayName || a.username}`)
      }
      if (patch.adopt) {
        const label = patch.adopt === 'content' ? '任务内容' : '提交内容'
        this.log(task, user, 'adopt', `把窗口内容采用进${label}`, { sessionId: patch.sessionId ?? null, field: patch.adopt })
      } else if (changes.length > 0) {
        this.log(task, user, 'edit', `修改了 ${changes.map((c) => FIELD_LABELS[c] ?? c).join('、')}`)
      }
      return task
    })
  }

  addLog(id, user, { text, kind = 'note', sessionId = null }) {
    return this.db.tasks.update(() => {
      const task = this.mustGet(id)
      if (!this.canView(task, user)) throw new HttpError(403, '无权查看该任务')
      if (!text || !String(text).trim()) throw new HttpError(400, '日志内容不能为空')
      this.log(task, user, kind, String(text).trim(), { sessionId })
      return task
    })
  }

  bindSession(id, user, { sessionId, title, device }) {
    return this.db.tasks.update(() => {
      const task = this.mustGet(id)
      if (!this.canView(task, user)) throw new HttpError(403, '无权查看该任务')
      if (!sessionId) throw new HttpError(400, '缺少 sessionId')
      let s = task.sessions.find((x) => x.sessionId === sessionId)
      if (!s) {
        s = { sessionId, userId: user.id, title: title ?? '', device: device ?? '', boundAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() }
        task.sessions.push(s)
        this.log(task, user, 'session', `打开任务进程 ${title ? `「${title}」` : ''}`.trim(), { sessionId })
      } else {
        s.lastActiveAt = new Date().toISOString()
        if (title) s.title = title
      }
      return task
    })
  }

  /** 撤销关联：把进程从任务卡上摘下来（会话本身不删，日志里留痕）。 */
  unbindSession(id, user, sessionId) {
    return this.db.tasks.update(() => {
      const task = this.mustGet(id)
      if (!this.canView(task, user)) throw new HttpError(403, '无权查看该任务')
      const idx = task.sessions.findIndex((x) => x.sessionId === sessionId)
      if (idx < 0) throw new HttpError(404, '该进程没有关联到这张任务卡', 'session_not_bound')
      const s = task.sessions[idx]
      if (!(user.role === 'admin' || s.userId === user.id || task.assigneeId === user.id || task.assignerId === user.id)) throw new HttpError(403, '只有关联人/提交人/派单人可以撤销关联')
      task.sessions.splice(idx, 1)
      this.log(task, user, 'session', `撤销关联进程 ${s.title ? `「${s.title}」` : ''}`.trim(), { sessionId, unbound: true })
      return task
    })
  }

  addDeliverables(id, user, files) {
    return this.db.tasks.update(() => {
      const task = this.mustGet(id)
      if (!this.canView(task, user)) throw new HttpError(403, '无权查看该任务')
      if (!(user.role === 'admin' || task.assigneeId === user.id || task.assignerId === user.id)) throw new HttpError(403, '只有提交人可以添加交付物')
      if (!Array.isArray(files) || files.length === 0) throw new HttpError(400, '没有文件')
      // 三段式提交：先校验（零副作用）→ 全部写盘成功才改内存并留痕；中途失败回滚已写文件，
      // 避免“客户端收到失败、前几个交付物却已写进任务卡/盘里”的半提交。
      const planned = []
      for (const f of files) {
        const name = String(f.name ?? '').replace(/[\\/]+/g, '_').trim()
        if (!name) throw new HttpError(400, '文件名不能为空')
        const rel = `projects/inbox/${task.id}/${name}`
        planned.push({ name, rel, f, record: { name, path: rel, size: 0, addedAt: new Date().toISOString(), addedBy: user.id, source: f.source ?? 'manual', sessionId: f.sessionId ?? null, localPath: f.localPath ?? null } })
      }
      const written = []
      try {
        for (const p of planned) {
          const data = Buffer.from(p.f.dataBase64 ?? '', 'base64')
          const info = this.drive.write(p.rel, data)
          written.push({ p, info })
        }
      } catch (err) {
        for (const { p } of written) {
          try {
            this.drive.remove(p.rel)
          } catch {
            /* 尽力回滚 */
          }
        }
        throw err
      }
      const added = []
      for (const { p, info } of written) {
        p.record.size = info.size
        const existing = task.deliverables.find((d) => d.name === p.name)
        if (existing) Object.assign(existing, p.record)
        else task.deliverables.push(p.record)
        added.push(p.record)
      }
      this.log(task, user, 'file', `添加交付物：${added.map((a) => a.name).join('、')}`, { files: added.map((a) => a.name), sessionId: files[0]?.sessionId ?? null })
      return task
    })
  }

  removeDeliverable(id, user, name) {
    return this.db.tasks.update(() => {
      const task = this.mustGet(id)
      if (!(user.role === 'admin' || task.assigneeId === user.id || task.assignerId === user.id)) throw new HttpError(403, '只有提交人可以删除交付物')
      const idx = task.deliverables.findIndex((d) => d.name === name)
      if (idx < 0) throw new HttpError(404, '交付物不存在')
      const d = task.deliverables[idx]
      // 先删盘后改内存：盘删失败（IO 错）时记录还在，状态一致；盘删成功后再动内存，不会半提交
      this.drive.remove(d.path)
      task.deliverables.splice(idx, 1)
      this.log(task, user, 'file', `移除交付物：${d.name}`)
      return task
    })
  }

  submit(id, user, { reviewerId }) {
    return this.db.tasks.update(() => {
      const task = this.mustGet(id)
      if (!(task.assigneeId === user.id || user.role === 'admin')) throw new HttpError(403, '只有提交人可以提交验收')
      if (!['draft', 'rejected'].includes(task.status)) throw new HttpError(409, `当前状态「${TASK_STATUS[task.status]}」不能提交`)
      if (task.deliverables.length === 0) throw new HttpError(400, '口头完成不算完成：请先把交付物放进任务卡再提交验收', 'no_deliverables')
      const reviewer = this.db.getUser(reviewerId)
      if (!reviewer) throw new HttpError(400, '请选择审核人')
      if (reviewer.id === user.id) throw new HttpError(400, '不能把任务发给自己审核')
      if (reviewer.role === 'employee') throw new HttpError(400, '审核人必须是总监或管理员')
      task.reviewerId = reviewer.id
      task.status = 'pending_review'
      task.submittedAt = new Date().toISOString()
      task.review = null
      task.final = null
      this.log(task, user, 'submit', `提交验收，发给 ${reviewer.displayName || reviewer.username}（${reviewer.role === 'admin' ? '管理员' : '总监'}）`)
      return task
    })
  }

  review(id, user, { decision, comment }) {
    return this.db.tasks.update(() => {
      const task = this.mustGet(id)
      if (task.status !== 'pending_review') throw new HttpError(409, `当前状态「${TASK_STATUS[task.status]}」不在待审`)
      if (!(task.reviewerId === user.id || user.role === 'admin')) throw new HttpError(403, '只有指定审核人可以审核')
      task.review = { by: user.id, decision, comment: comment ?? '', at: new Date().toISOString() }
      task.reviewedAt = task.review.at
      if (decision === 'pass') {
        task.status = 'pending_final'
        this.log(task, user, 'review', `初审通过 → 待终审${comment ? `：${comment}` : ''}`)
      } else {
        task.status = 'rejected'
        this.log(task, user, 'review', `初审驳回${comment ? `：${comment}` : ''}`)
      }
      return task
    })
  }

  finalize(id, user, { decision, comment }) {
    return this.db.tasks.update(() => {
      const task = this.mustGet(id)
      if (task.status !== 'pending_final') throw new HttpError(409, `当前状态「${TASK_STATUS[task.status]}」不在待终审`)
      const allowed = user.role === 'admin' || (task.assignerId === user.id && user.role !== 'employee')
      if (!allowed) throw new HttpError(403, '终审需要管理员（或派单的总监）')
      task.finalReviewerId = user.id
      task.final = { by: user.id, decision, comment: comment ?? '', at: new Date().toISOString() }
      task.finalizedAt = task.final.at
      task.status = decision === 'pass' ? 'approved' : 'rejected'
      this.log(task, user, 'final', `${decision === 'pass' ? '终审通过' : '终审驳回'}${comment ? `：${comment}` : ''}`)
      return task
    })
  }

  /** 输出视图：补人名与状态标签。 */
  view(task) {
    const name = (id) => {
      const u = id ? this.db.getUser(id) : undefined
      return u ? { id: u.id, username: u.username, displayName: u.displayName, role: u.role, department: u.department } : null
    }
    return {
      ...task,
      statusLabel: TASK_STATUS[task.status] ?? task.status,
      assigner: name(task.assignerId),
      assignee: name(task.assigneeId),
      reviewer: name(task.reviewerId),
      finalReviewer: name(task.finalReviewerId),
      sessions: task.sessions.map((s) => ({ ...s, user: name(s.userId) })),
    }
  }
}

const FIELD_LABELS = { title: '标题', content: '任务内容', submission: '提交内容', project: '项目', department: '部门', assignee: '被派人' }
