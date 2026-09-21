/**
 * 任务卡四格：draft → pending_review → pending_final → approved | rejected
 * 口头完成不算：提交验收必须先有交付物。
 */
import { peopleOptions } from './people-options.mjs'

export const TASK_STATUS = {
  draft: '进行中',
  pending_review: '待审',
  pending_final: '待终审',
  approved: '通过',
  rejected: '驳回',
}

/** 审核人：总监或管理员，且不能是自己。 */
export function reviewerOptions(users, me) {
  const list = Array.isArray(users) ? users.filter((u) => u && !u.disabled && u.role !== 'employee') : []
  const mineId = me?.id
  const mineName = me?.username
  const pool = list.filter((u) => u.id !== mineId && u.username !== mineName)
  return peopleOptions(pool, me, { employeesSelfOnly: false })
}

export function canSubmit(task, me) {
  if (!task || !me) return false
  if (!['draft', 'rejected'].includes(task.status)) return false
  return task.assigneeId === me.id || me.role === 'admin'
}

export function canReview(task, me) {
  if (!task || !me) return false
  if (task.status !== 'pending_review') return false
  return task.reviewerId === me.id || me.role === 'admin'
}

export function canFinalize(task, me) {
  if (!task || !me) return false
  if (task.status !== 'pending_final') return false
  return me.role === 'admin' || (task.assignerId === me.id && me.role !== 'employee')
}

export function hasDeliverables(task) {
  return Array.isArray(task?.deliverables) && task.deliverables.length > 0
}

export function assertDecision(decision) {
  if (decision !== 'pass' && decision !== 'reject') {
    throw new Error('decision 必须是 pass 或 reject')
  }
  return decision
}

/** 给 Agent / 状态栏看的下一步，不要说「本通道不能提交」。 */
export function workflowHint(task) {
  if (!task) return '没有任务卡。用 /desk-tasks 查看或 /desk-task-new 新建。'
  const n = hasDeliverables(task) ? task.deliverables.length : 0
  const st = task.statusLabel ?? TASK_STATUS[task.status] ?? task.status
  switch (task.status) {
    case 'draft':
    case 'rejected':
      if (!n) return `状态「${st}」。口头完成不算完成：先 company_task_attach 挂交付物，再 company_task_submit 选审核人提交验收。`
      if (!String(task.submission ?? '').trim()) {
        return `已有 ${n} 个交付物。把结论写入提交内容（company_task_update），再用 company_task_submit 提交验收。`
      }
      return `可以提交验收：company_task_submit（审核人必须是总监或管理员，不能发给自己）。`
    case 'pending_review':
      return `已在待审。指定审核人用 company_task_review（decision=pass 通过 / reject 驳回）。`
    case 'pending_final':
      return `已在待终审。管理员或派单总监用 company_task_final（decision=pass / reject）。`
    case 'approved':
      return '已通过，无需再交。'
    default:
      return `状态「${st}」。`
  }
}
