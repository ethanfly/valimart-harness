/**
 * 指派人选择列表：自己排第一；员工只能派给自己。
 */
export function peopleOptions(users, me, { employeesSelfOnly = true } = {}) {
  const list = Array.isArray(users) ? users.filter((u) => u && !u.disabled) : []
  const mine = list.find((u) => u.id === me?.id || u.username === me?.username)
  const role = me?.role
  const pool = employeesSelfOnly && role === 'employee' && mine ? [mine] : list
  pool.sort((a, b) => {
    const aMe = a.id === mine?.id ? 0 : 1
    const bMe = b.id === mine?.id ? 0 : 1
    if (aMe !== bMe) return aMe - bMe
    return String(a.displayName || a.username).localeCompare(String(b.displayName || b.username), 'zh-Hans-CN')
  })
  return pool.map((u) => {
    const self = u.id === mine?.id ? '我 · ' : ''
    const dep = u.department ? ` · ${u.department}` : ''
    const online = u.online ? ' · 在线' : ''
    return {
      id: u.id,
      username: u.username,
      label: `${self}${u.displayName || u.username}（${u.username}）${dep}${online}`,
    }
  })
}

export function personIdFromChoice(choice, options) {
  if (!choice) return ''
  return (Array.isArray(options) ? options : []).find((o) => o.label === choice)?.id ?? ''
}

export function formatTaskCard(task) {
  if (!task) return '（无任务）'
  const who = (p) => (p ? `${p.displayName || p.username}（${p.username}）` : '—')
  return [
    `${task.id}  ${task.title}`,
    `状态：${task.statusLabel ?? task.status}`,
    `派单：${who(task.assigner)}　提交人：${who(task.assignee)}`,
    `审核：${who(task.reviewer)}　终审：${who(task.finalReviewer)}`,
    task.project ? `项目：${task.project}` : '',
    '',
    '任务内容：',
    task.content || '（空）',
    '',
    '提交内容：',
    task.submission || '（空）',
    '',
    `交付物：${Array.isArray(task.deliverables) && task.deliverables.length ? task.deliverables.map((d) => d.name).join('、') : '尚无'}`,
  ]
    .filter((l) => l !== '')
    .join('\n')
}
