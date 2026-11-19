/** 指派人选择列表：自己排第一；员工只能派给自己。 */
export function peopleOptions(users, me, { employeesSelfOnly = true } = {}) {
  const list = (Array.isArray(users) ? users : []).filter((user) => user && !user.disabled)
  const mine = list.find((user) => user.id === me?.id || user.username === me?.username)
  const pool = employeesSelfOnly && me?.role === 'employee' && mine ? [mine] : list
  pool.sort((a, b) => {
    const selfDelta = (a.id === mine?.id ? 0 : 1) - (b.id === mine?.id ? 0 : 1)
    return selfDelta || String(a.displayName || a.username).localeCompare(String(b.displayName || b.username), 'zh-Hans-CN')
  })
  return pool.map((user) => ({
    id: user.id,
    username: user.username,
    label: `${user.id === mine?.id ? '我 · ' : ''}${user.displayName || user.username}（${user.username}）${user.department ? ` · ${user.department}` : ''}${user.online ? ' · 在线' : ''}`,
  }))
}

export function personIdFromChoice(choice, options) {
  return (Array.isArray(options) ? options : []).find((option) => option.label === choice)?.id ?? ''
}
