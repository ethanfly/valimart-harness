/**
 * DeskSidebar：THE DIVA 品牌行 + 「会话 / 任务」双 Tab 侧栏。
 *  - 会话 Tab：沿用 ui-workspace 的工作区浏览器（个人 / 团队工作区、搜索、筛选、归档）。
 *  - 任务 Tab：任务列表（按状态/更新时间）、搜索、新建任务；点击进入任务模式。
 * 底部：sidebar.footer.action 列表槽 + sidebar.settings（设置按钮）+ 当前登录人。
 */
import { useMemo, useState } from 'react'
import { deskStore, useStoreValue } from './store.js'
import { layoutActions, layoutStore } from './layout.jsx'
import { fmtTime } from './api.js'
import { Logotype } from './login.jsx'
import { IconPanel, IconPlus, IconSearch, IconChat, IconTask, IconRefresh } from './icons.jsx'
import { NewTaskDialog } from './tasks.jsx'
import { STATUS_LABEL } from './tasks.jsx'
import { loadTasks } from './api.js'

export function DeskSidebar({ collapsed, renderSlot, startSession, toggleSidebar }) {
  const tab = useStoreValue(deskStore, (s) => s.sidebarTab ?? 'sessions')
  const desk = useStoreValue(deskStore, (s) => s.desk)
  const tasks = useStoreValue(deskStore, (s) => s.tasks)
  const wide = !collapsed
  const openTasks = tasks.filter((t) => t.status !== 'approved' && t.status !== 'rejected').length

  const setTab = (next) => {
    deskStore.set({ sidebarTab: next })
    if (next === 'sessions' && layoutStore.get().mode === 'task') layoutActions.setMode('chat')
    if (next === 'tasks' && deskStore.get().selectedTaskId) layoutActions.setMode('task')
  }

  if (!wide) {
    return (
      <div className="dk-rail">
        <button className="dk-iconbtn" title="展开侧边栏" onClick={toggleSidebar} style={{ marginBottom: 4 }}>
          <IconPanel />
        </button>
        <span className="dk-monogram" title="THE DIVA">D</span>
        <button className="dk-iconbtn" title="新会话" onClick={() => startSession()}>
          <IconPlus />
        </button>
        <button className={`dk-iconbtn${tab === 'sessions' ? ' active' : ''}`} title="会话" onClick={() => setTab('sessions')}>
          <IconChat />
        </button>
        <button className={`dk-iconbtn${tab === 'tasks' ? ' active' : ''}`} title="任务" onClick={() => setTab('tasks')}>
          <IconTask />
        </button>
        <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
          {tab === 'sessions' && renderSlot('sidebar.workspaces', { wide: false, expandSidebar: toggleSidebar })}
        </div>
        {renderSlot('sidebar.footer.action', { wide: false })}
        {renderSlot('sidebar.settings', { wide: false })}
        {desk?.user && <span className="dk-avatar sm" title={`${desk.user.displayName}（${desk.user.username}）`}>{initials(desk.user)}</span>}
      </div>
    )
  }

  return (
    <>
      <div className="dk-brand">
        <Logotype tagline={desk?.company?.name && desk.company.name.toUpperCase() !== 'THE DIVA' ? desk.company.name : undefined} />
        <div className="dk-row" style={{ gap: 2 }}>
          <button className="dk-iconbtn" title="新会话" onClick={() => startSession()}>
            <IconPlus />
          </button>
          <button className="dk-iconbtn" title="收起侧边栏" onClick={toggleSidebar}>
            <IconPanel />
          </button>
        </div>
      </div>
      <div className="dk-side-tabs">
        <div className="dk-seg">
          <button className={tab === 'sessions' ? 'active' : ''} onClick={() => setTab('sessions')}>
            <IconChat size={13} /> 会话
          </button>
          <button className={tab === 'tasks' ? 'active' : ''} onClick={() => setTab('tasks')}>
            <IconTask size={13} /> 任务 {openTasks > 0 && <span className="count">{openTasks}</span>}
          </button>
        </div>
      </div>
      <div className="dk-side-body">
        <div style={{ display: tab === 'sessions' ? 'flex' : 'none', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }}>
          {renderSlot('sidebar.workspaces', { wide: true, expandSidebar: () => {} })}
        </div>
        {tab === 'tasks' && <TaskList tasks={tasks} desk={desk} />}
      </div>
      <div className="dk-side-footer">
        {renderSlot('sidebar.footer.action', { wide: true })}
        {renderSlot('sidebar.settings', { wide: true })}
        {desk?.user && (
          <div className="dk-side-user" title={`${desk.user.username} · 网关 ${desk.gatewayUrl}`}>
            <span className="dk-avatar">{initials(desk.user)}</span>
            <div className="dk-grow">
              <div className="dk-small dk-ellipsis" style={{ fontWeight: 500 }}>
                {desk.user.displayName}
              </div>
              <div className="dk-xs dk-muted dk-ellipsis">
                {roleLabel(desk.user.role)} · {desk.user.department || '未分配部门'}
              </div>
            </div>
            <span className={`dk-badge ${desk.online ? 'online' : 'offline'}`} style={{ height: 18 }}>
              {desk.online ? '在线' : '离线'}
            </span>
          </div>
        )}
      </div>
    </>
  )
}

function TaskList({ tasks, desk }) {
  const selected = useStoreValue(deskStore, (s) => s.selectedTaskId)
  const error = useStoreValue(deskStore, (s) => s.tasksError)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('open') // open | mine | all | done
  const [creating, setCreating] = useState(false)
  const me = desk?.user?.username

  const groups = useMemo(() => {
    const kw = q.trim().toLowerCase()
    let list = tasks.filter((t) => {
      if (filter === 'open' && (t.status === 'approved' || t.status === 'rejected')) return false
      if (filter === 'done' && !(t.status === 'approved' || t.status === 'rejected')) return false
      if (filter === 'mine' && t.assignee?.username !== me) return false
      if (!kw) return true
      return [t.title, t.content, t.project, t.department, t.assigner?.displayName, t.assignee?.displayName, t.id].some((x) => (x ?? '').toLowerCase().includes(kw))
    })
    list = [...list].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    const out = []
    const by = new Map()
    for (const t of list) {
      const key = t.status
      if (!by.has(key)) {
        by.set(key, [])
        out.push(key)
      }
      by.get(key).push(t)
    }
    const order = ['pending_review', 'pending_final', 'draft', 'rejected', 'approved']
    return order.filter((k) => by.has(k)).map((k) => ({ key: k, label: STATUS_LABEL[k], items: by.get(k) }))
  }, [tasks, q, filter, me])

  return (
    <div className="dk-tasklist">
      <div className="dk-tasklist-tools">
        <div className="dk-grow" style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', left: 8, top: 6, color: 'var(--dk-text-3)' }}>
            <IconSearch size={13} />
          </span>
          <input className="dk-input sm" style={{ paddingLeft: 26 }} placeholder="搜索任务" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="dk-select sm" style={{ width: 74 }} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="open">进行中</option>
          <option value="mine">我负责</option>
          <option value="done">已结束</option>
          <option value="all">全部</option>
        </select>
        <button className="dk-iconbtn" title="刷新" onClick={() => loadTasks({ silent: false })}>
          <IconRefresh size={14} />
        </button>
        <button className="dk-iconbtn" title="新建任务" onClick={() => setCreating(true)}>
          <IconPlus />
        </button>
      </div>
      <div className="dk-tasklist-scroll">
        {error && <div className="dk-alert error dk-xs">{error}</div>}
        {groups.length === 0 && <div className="dk-empty">暂无任务。点右上角「+」新建。</div>}
        {groups.map((g) => (
          <div key={g.key}>
            <div className="dk-taskgroup">
              {g.label} · {g.items.length}
            </div>
            {g.items.map((t) => (
              <button
                key={t.id}
                className={`dk-taskitem${selected === t.id ? ' active' : ''}`}
                onClick={() => {
                  deskStore.set({ selectedTaskId: t.id, taskDetail: t })
                  layoutActions.setMode('task')
                }}
              >
                <div className="t">
                  <span className={`dk-statusdot ${t.status}`} />
                  <span className="name">{t.title}</span>
                </div>
                {/* 项目 · 派给谁 · 部门 · 时间 · 状态（与任务卡列表一致） */}
                <div className="m">
                  {t.project && (
                    <>
                      <span>{t.project}</span>
                      <span className="sep">·</span>
                    </>
                  )}
                  <span title={t.assignee?.displayName}>{t.assignee?.username ?? t.assignee?.displayName ?? '—'}</span>
                  <span className="sep">·</span>
                  <span>{t.department || '未分部门'}</span>
                  <span className="sep">·</span>
                  <span>{fmtTime(t.updatedAt)}</span>
                  <span className="sep">·</span>
                  <span className={`st ${t.status}`}>{t.statusLabel ?? STATUS_LABEL[t.status] ?? t.status}</span>
                  {t.deliverables?.length > 0 && <span className="dk-muted" title={`${t.deliverables.length} 个交付物`}>{` · ${t.deliverables.length} 件`}</span>}
                </div>
              </button>
            ))}
          </div>
        ))}
      </div>
      {creating && <NewTaskDialog onClose={() => setCreating(false)} />}
    </div>
  )
}

export function initials(user) {
  const name = user?.displayName || user?.username || '?'
  const cjk = /[\u4e00-\u9fff]/.test(name)
  return cjk ? name.slice(-2) : name.slice(0, 2).toUpperCase()
}

export function roleLabel(role) {
  return { admin: '管理员', director: '总监', employee: '员工' }[role] ?? role ?? '—'
}
