/** 任务卡四格：draft → pending_review → pending_final → approved | rejected。 */
import { peopleOptions } from './people-options.mjs'

const TASK_STATUS = { draft: '进行中', pending_review: '待审', pending_final: '待终审', approved: '通过', rejected: '驳回' }

export function reviewerOptions(users, me) {
  const pool = (Array.isArray(users) ? users : []).filter((user) => user && !user.disabled && user.id !== me?.id && user.username !== me?.username)
  return peopleOptions(pool, me, { employeesSelfOnly: false })
}

export const canSubmit = (task, me) => !!task && !!me && ['draft', 'rejected'].includes(task.status) && (task.assigneeId === me.id || me.role === 'admin')
export const canReview = (task, me) => !!task && !!me && task.status === 'pending_review' && (task.reviewerId === me.id || me.role === 'admin')
export const canFinalize = (task, me) => !!task && !!me && task.status === 'pending_final' && (me.role === 'admin' || (task.assignerId === me.id && me.role !== 'employee'))
export const hasDeliverables = (task) => Array.isArray(task?.deliverables) && task.deliverables.length > 0
export function assertDecision(decision) {
  if (decision !== 'pass' && decision !== 'reject') throw new Error('decision 必须是 pass 或 reject')
  return decision
}

export function workflowHint(task) {
  if (!task) return '这次没有绑定任务卡，不走验收。用户要挂时自己手动绑定。'
  const count = hasDeliverables(task) ? task.deliverables.length : 0
  const status = task.statusLabel ?? TASK_STATUS[task.status] ?? task.status
  if (['draft', 'rejected'].includes(task.status)) {
    if (!count) return `状态「${status}」。口头完成不算完成：先 company_task_attach 挂交付物，再 company_task_submit 选审核人提交验收。`
    if (!String(task.submission ?? '').trim()) return `已有 ${count} 个交付物。把结论写入提交内容（company_task_update），再用 company_task_submit 提交验收。`
    return '可以提交验收：company_task_submit（审核人可以是任意同事，不能发给自己）。'
  }
  if (task.status === 'pending_review') return `已在待审。指定审核人用 company_task_review（decision=pass 通过 / reject 驳回）。`
  if (task.status === 'pending_final') return `已在待终审。管理员或派单总监用 company_task_final（decision=pass / reject）。`
  if (task.status === 'approved') return '已通过，无需再交。'
  return `状态「${status}」。`
}
