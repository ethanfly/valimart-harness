/**
 * 任务卡：概览（提交信息 / 任务内容 / 提交内容 / 交付物 / 四格验收）+ 工作日志；任务进程列；新建任务。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, applyTask, loadTask, loadTasks, loadPeople, fmtDateTime, fmtTime, fmtBytes } from './api.js'
import { deskStore, useStoreValue, toast } from './store.js'
import { layoutActions } from './layout.jsx'
import { safeOpenSession } from './safe-open-session.js'
import { Logotype } from './login.jsx'
import { IconClose, IconRefresh, IconLayout, IconChat, IconPlus, IconFolder, IconSend, IconTrash, IconLink, IconCheck } from './icons.jsx'

export const STATUS_LABEL = { draft: '进行中', pending_review: '待审', pending_final: '待终审', approved: '通过', rejected: '驳回' }
const ROLE = { admin: '管理员', director: '总监', employee: '员工' }
const KIND_LABEL = { created: '创建', edit: '修改', adopt: '采用', note: '备注', session: '进程', file: '交付物', submit: '提交', review: '初审', final: '终审', assign: '改派', agent: 'Agent' }

const who = (p) => (p ? p.displayName || p.username : '—')
/** 会话 id 的短形式：去掉 session- 前缀后取前 8 位。 */
const shortSid = (sid) => String(sid ?? '').replace(/^session-/, '').slice(0, 8)
const whoFull = (p) => (p ? `${p.displayName || p.username}（${p.username}${p.role ? ' · ' + (ROLE[p.role] ?? p.role) : ''}）` : '—')

function useTask(taskId) {
  const detail = useStoreValue(deskStore, (s) => s.taskDetail)
  const fromList = useStoreValue(deskStore, (s) => s.tasks.find((t) => t.id === taskId))
  useEffect(() => {
    if (!taskId) return
    loadTask(taskId).catch((err) => toast(err.message, 'error'))
  }, [taskId])
  return detail?.id === taskId ? detail : fromList ?? null
}

async function run(fn, ok) {
  try {
    const r = await fn()
    if (r?.task) applyTask(r.task)
    if (ok) toast(ok, 'success')
    return r
  } catch (err) {
    toast(err.message, 'error')
    return null
  }
}

/** 等待某个工作区出现在浏览器端投影里（Host 刚创建时列表可能还没刷新）。 */
function waitForWorkspace(ctx, workspaceId, timeoutMs = 4000) {
  const store = ctx.workspaces?.list
  if (!store?.getSnapshot) return Promise.resolve(false)
  const has = () => store.getSnapshot().items.some((w) => w.workspaceId === workspaceId)
  if (has()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsub()
      resolve(has())
    }, timeoutMs)
    const unsub = store.subscribe(() => {
      if (!has()) return
      clearTimeout(timer)
      unsub()
      resolve(true)
    })
  })
}

/**
 * 打开一个新的任务进程：Host 准备任务格子（projects/inbox/<任务ID>/）并确认「团队」工作区 →
 * 浏览器在团队工作区里新建一个会话 → 绑定到任务卡（Agent 的系统提示里就会带上这张任务卡）。
 */
export async function openTaskProcess(ctx, task) {
  try {
    const r = await api.openProcess(task.id)
    let sessionId
    if (r.workspaceId && (await waitForWorkspace(ctx, r.workspaceId))) {
      // 每次“打开进程”都新开一个会话，而不是复用团队工作区里的空白会话（空白会话可能已绑定别的任务）
      sessionId = await ctx.sessions.create({ workspaceId: r.workspaceId })
    } else if (r.dir) {
      sessionId = await ctx.sessions.create({ cwd: r.dir })
    }
    if (!sessionId) throw new Error('无法创建任务进程会话')
    const title = `任务 · ${task.title}`
    const res = await api.bindSession(task.id, sessionId, title)
    if (res?.task) applyTask(res.task)
    try {
      await ctx.sessions.binding?.(sessionId)?.session?.rename?.(title)
    } catch {
      /* 标题由首条消息自动生成也可以 */
    }
    safeOpenSession(ctx, sessionId)
    layoutActions.openTaskChat()
    return sessionId
  } catch (err) {
    toast(err.message, 'error')
    return null
  }
}

export function TaskPanel({ ctx, taskId, useSessions, chatOpen }) {
  const task = useTask(taskId)
  const desk = useStoreValue(deskStore, (s) => s.desk)
  const [tab, setTab] = useState('overview')
  const current = useSessions((s) => s.current)
  const me = desk?.user
  if (!taskId || !task) {
    return (
      <div className="dk-task">
        <div className="dk-task-placeholder">
          <Logotype />
          <div>从左侧「任务」列表选择一张任务卡，或新建任务。</div>
          <button className="dk-btn" onClick={() => layoutActions.setMode('chat')}>
            返回会话
          </button>
        </div>
      </div>
    )
  }
  const editable = me && (me.role === 'admin' || task.assigneeId === me.id || task.assignerId === me.id)
  return (
    <div className="dk-task">
      <div className="dk-task-head">
        <div className="dk-row between" style={{ alignItems: 'flex-start' }}>
          <div className="dk-grow">
            <TitleEditor task={task} editable={editable} />
            <div className="meta">
              <span className={`dk-badge ${task.status}`}>
                <i className="dot" />
                {STATUS_LABEL[task.status]}
              </span>
              <span title={`下达人 ${whoFull(task.assigner)}`}>{task.assigner?.username ?? '—'}</span>
              <span className="sep">·</span>
              <span title={`上交人 ${whoFull(task.assignee)}`}>上交 {task.assignee?.username ?? '—'}</span>
              <span className="sep">·</span>
              <span>{task.department || '未分部门'}</span>
              {task.project && (
                <>
                  <span className="sep">·</span>
                  <span>{task.project}</span>
                </>
              )}
              <span className="sep">·</span>
              <span title={`创建 ${fmtDateTime(task.createdAt)}${task.submittedAt ? `，提交 ${fmtDateTime(task.submittedAt)}` : ''}`}>{fmtTime(task.updatedAt ?? task.createdAt)}</span>
              <span className="sep">·</span>
              <span className="dk-mono dk-xs" title="任务卡编号">
                {task.id}
              </span>
            </div>
          </div>
          <div className="dk-row" style={{ gap: 4, flex: 'none' }}>
            <button className={`dk-btn sm${chatOpen ? '' : ' ghost'}`} title="任务进程（对话）" onClick={() => layoutActions.toggleTaskChat()}>
              <IconLayout size={14} /> {chatOpen ? '收起进程' : '任务进程'}
            </button>
            <button className="dk-iconbtn" title="刷新" onClick={() => loadTask(task.id).catch((e) => toast(e.message, 'error'))}>
              <IconRefresh size={14} />
            </button>
            <button className="dk-iconbtn" title="关闭任务，回到会话" onClick={() => layoutActions.setMode('chat')}>
              <IconClose size={14} />
            </button>
          </div>
        </div>
        <div className="dk-tabs">
          <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>
            概览
          </button>
          <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>
            工作日志 {task.log?.length > 0 && <span className="dk-muted">({task.log.length})</span>}
          </button>
        </div>
      </div>
      <div className={`dk-task-body${chatOpen ? ' narrow' : ''}`}>
        {tab === 'overview' ? <Overview key={task.id} ctx={ctx} task={task} me={me} editable={editable} currentSession={current} /> : <WorkLog key={task.id} ctx={ctx} task={task} me={me} useSessions={useSessions} />}
      </div>
    </div>
  )
}

function TitleEditor({ task, editable }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(task.title)
  useEffect(() => setV(task.title), [task.title])
  if (!editing)
    return (
      <h1 onDoubleClick={() => editable && setEditing(true)} title={editable ? '双击修改标题' : undefined}>
        <span className="dk-ellipsis">{task.title}</span>
      </h1>
    )
  const save = async () => {
    setEditing(false)
    if (v.trim() && v.trim() !== task.title) await run(() => api.gw.patch(`/tasks/${task.id}`, { title: v.trim() }), '标题已更新')
  }
  return (
    <h1>
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && save()} />
    </h1>
  )
}

function Steps({ task }) {
  // 驳回发生在哪一格：初审驳回停在「待审」，终审驳回停在「待终审」——不要把没走到的格子画成已完成
  const reviewRejected = task.status === 'rejected' && !task.final && task.review?.decision === 'reject'
  const finalRejected = task.status === 'rejected' && task.final?.decision === 'reject'
  const pendingIdx = { draft: 0, pending_review: 1, pending_final: 2 }[task.status] ?? 0
  const steps = [
    { n: '01', l: '提交验收', d: task.submittedAt ? fmtTime(task.submittedAt) : '进行中' },
    {
      n: '02',
      l: '待审',
      d: reviewRejected ? `初审驳回 · ${fmtTime(task.reviewedAt)}` : task.reviewedAt ? `${fmtTime(task.reviewedAt)} · ${who(task.reviewer)}` : task.reviewer ? `审核人 ${who(task.reviewer)}` : '未指定审核人',
    },
    {
      n: '03',
      l: '待终审',
      d: finalRejected ? `终审驳回 · ${fmtTime(task.finalizedAt)}` : task.finalizedAt ? `${fmtTime(task.finalizedAt)} · ${who(task.finalReviewer)}` : task.status === 'pending_final' ? '等待管理员终审' : '—',
    },
    {
      n: '04',
      l: task.status === 'rejected' ? '驳回' : '通过',
      d: task.status === 'approved' ? `通过 · ${fmtTime(task.finalizedAt)}` : task.status === 'rejected' ? `驳回 · ${(task.final ?? task.review)?.comment || '无说明'}` : '—',
    },
  ]
  const stateOf = (i) => {
    if (task.status === 'approved') return 'done'
    if (reviewRejected) return i === 0 ? 'done' : i === 1 ? 'rejected' : ''
    if (finalRejected) return i < 2 ? 'done' : i === 2 ? 'rejected' : ''
    if (i < pendingIdx) return 'done'
    if (i === pendingIdx) return 'current'
    return ''
  }
  return (
    <div className="dk-steps">
      {steps.map((s, i) => {
        let cls = 'dk-step'
        const st = stateOf(i)
        if (st) cls += ' ' + st
        return (
          <div key={s.n} className={cls}>
            <div className="n">{s.n}</div>
            <div className="l">{s.l}</div>
            <div className="dk-xs dk-ellipsis" title={s.d}>
              {s.d}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Overview({ ctx, task, me, editable, currentSession }) {
  const desk = useStoreValue(deskStore, (s) => s.desk)
  const boundHere = task.sessions?.some((s) => s.sessionId === currentSession)
  const adoptSession = boundHere ? currentSession : task.sessions?.at(-1)?.sessionId ?? currentSession
  const canSubmit = me && (task.assigneeId === me.id || me.role === 'admin') && ['draft', 'rejected'].includes(task.status)
  const canReview = me && task.status === 'pending_review' && (task.reviewerId === me.id || me.role === 'admin')
  const canFinal = me && task.status === 'pending_final' && (me.role === 'admin' || (task.assignerId === me.id && me.role !== 'employee'))
  return (
    <>
      <div className="dk-card">
        <div className="dk-card-title">验收进度</div>
        <Steps task={task} />
        {(task.review || task.final) && (
          <div className="dk-small dk-dim" style={{ marginTop: 10, lineHeight: 1.7 }}>
            {task.review && (
              <div>
                初审：{task.review.decision === 'pass' ? '通过' : '驳回'} · {who(task.reviewer)} · {fmtDateTime(task.review.at)}
                {task.review.comment ? ` · ${task.review.comment}` : ''}
              </div>
            )}
            {task.final && (
              <div>
                终审：{task.final.decision === 'pass' ? '通过' : '驳回'} · {who(task.finalReviewer)} · {fmtDateTime(task.final.at)}
                {task.final.comment ? ` · ${task.final.comment}` : ''}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="dk-card">
        <div className="dk-card-title">
          <span className="dk-row" style={{ gap: 8 }}>
            提交
            <span className="dk-chip">{task.assigner?.username ?? '—'}</span>
            <span className="dk-tag">{task.department || '未分部门'}</span>
          </span>
          <span className="dk-xs dk-muted">{task.submittedAt ? `提交于 ${fmtTime(task.submittedAt)}` : '尚未提交验收'}</span>
        </div>
        <div className="dk-kv">
          <div>
            <div className="k">下达人</div>
            <div className="v">{whoFull(task.assigner)}</div>
          </div>
          <div>
            <div className="k">上交人</div>
            <div className="v">{whoFull(task.assignee)}</div>
          </div>
          <div>
            <div className="k">项目</div>
            <div className="v">
              <InlineField task={task} field="project" editable={editable} placeholder="（未填写项目）" />
              <span className="dk-muted dk-mono dk-xs" style={{ marginLeft: 6 }}>
                · projects/inbox/{task.id}/
              </span>
            </div>
          </div>
          <div>
            <div className="k">部门</div>
            <div className="v">{task.department || '—'}</div>
          </div>
          <div>
            <div className="k">审核人</div>
            <div className="v">{whoFull(task.reviewer)}</div>
          </div>
          <div>
            <div className="k">终审人</div>
            <div className="v">{whoFull(task.finalReviewer)}</div>
          </div>
          <div>
            <div className="k">创建时间</div>
            <div className="v">{fmtDateTime(task.createdAt)}</div>
          </div>
          <div>
            <div className="k">提交时间</div>
            <div className="v">{task.submittedAt ? fmtDateTime(task.submittedAt) : '尚未提交'}</div>
          </div>
        </div>
      </div>

      <TextSection task={task} field="content" title="任务内容" editable={editable} adoptSession={adoptSession} placeholder="任务要做什么、验收标准是什么。可以把 Agent 窗口里的最新回复「采用进任务内容」。" />
      <TextSection task={task} field="submission" title="提交内容" editable={editable} adoptSession={adoptSession} placeholder="提交说明：做了什么、结论是什么。可以把 Agent 窗口里的最新回复「采用进提交内容」。" />

      <Deliverables ctx={ctx} task={task} editable={editable} currentSession={adoptSession} driveDir={desk?.driveDir} />

      <div className="dk-card">
        <div className="dk-card-title">验收</div>
        {canSubmit ? (
          <SubmitBox task={task} me={me} />
        ) : task.status === 'pending_review' || task.status === 'pending_final' ? (
          <div className="dk-small dk-dim">
            {task.status === 'pending_review' ? `已发给 ${who(task.reviewer)} 审核，等待初审。` : `初审已通过，等待管理员终审。`}
          </div>
        ) : task.status === 'approved' ? (
          <div className="dk-alert success">该任务已通过终审。</div>
        ) : (
          <div className="dk-small dk-dim">只有提交人可以提交验收。</div>
        )}
        {(canReview || canFinal) && <ReviewBox key={`${task.id}:${canReview ? 'review' : 'final'}`} task={task} stage={canReview ? 'review' : 'final'} />}
      </div>
    </>
  )
}

function InlineField({ task, field, editable, placeholder }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(task[field] ?? '')
  useEffect(() => setV(task[field] ?? ''), [task[field]])
  if (!editing)
    return (
      <span onClick={() => editable && setEditing(true)} style={{ cursor: editable ? 'text' : undefined }} className={task[field] ? '' : 'dk-muted'}>
        {task[field] || placeholder}
      </span>
    )
  const save = async () => {
    setEditing(false)
    if (v !== (task[field] ?? '')) await run(() => api.gw.patch(`/tasks/${task.id}`, { [field]: v }))
  }
  return <input className="dk-input sm" autoFocus value={v} onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && save()} />
}

function TextSection({ task, field, title, editable, adoptSession, placeholder }) {
  const [v, setV] = useState(task[field] ?? '')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const skipBlurSave = useRef(false)
  useEffect(() => {
    if (!dirty) setV(task[field] ?? '')
  }, [task[field], dirty])
  // 失焦即静默保存：切 tab / 切任务 / 点别处时输入不再白白丢掉；点「保存 / 采用」这类
  // 会自己写库的按钮时先在 onMouseDown 置 skip，避免旧草稿把刚采用的新内容覆盖掉。
  const saveNow = async ({ toastOk = true } = {}) => {
    setBusy(true)
    const r = await run(() => api.gw.patch(`/tasks/${task.id}`, { [field]: v }), toastOk ? `${title}已保存` : null)
    setBusy(false)
    if (r) setDirty(false)
  }
  const save = () => saveNow()
  const onBlur = () => {
    if (!dirty || !editable) return
    if (skipBlurSave.current) {
      skipBlurSave.current = false
      return
    }
    saveNow({ toastOk: false })
  }
  const adopt = async () => {
    if (!adoptSession) {
      toast('没有可采用的窗口：请先打开任务进程并让 Agent 产出内容', 'error')
      return
    }
    setBusy(true)
    try {
      const r = await api.lastAssistant(adoptSession)
      if (!r.text) {
        toast(r.reason === 'session_not_live' ? '该进程当前未在本机运行，无法读取窗口内容' : '窗口里还没有 Agent 的回复', 'error')
        return
      }
      const res = await api.gw.patch(`/tasks/${task.id}`, { [field]: r.text, adopt: field, sessionId: adoptSession })
      applyTask(res.task)
      setDirty(false)
      setV(r.text)
      toast(`已把窗口内容采用进${title}`, 'success')
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="dk-card">
      <div className="dk-card-title">
        <span>{title}</span>
        {editable && (
          <div className="dk-row" style={{ gap: 6 }}>
            <button
              className="dk-btn sm"
              disabled={busy}
              onMouseDown={() => { skipBlurSave.current = true }}
              onClick={adopt}
              title="把任务进程窗口里 Agent 的最新回复填进来"
            >
              <IconChat size={13} /> 采用进{title}
            </button>
            {dirty && (
              <button
                className="dk-btn sm primary"
                disabled={busy}
                onMouseDown={() => { skipBlurSave.current = true }}
                onClick={save}
              >
                保存
              </button>
            )}
          </div>
        )}
      </div>
      <textarea
        className="dk-textarea"
        value={v}
        readOnly={!editable}
        placeholder={placeholder}
        onBlur={onBlur}
        onChange={(e) => {
          setV(e.target.value)
          setDirty(true)
        }}
      />
    </div>
  )
}

function Deliverables({ ctx, task, editable, currentSession, driveDir }) {
  const [picking, setPicking] = useState(false)
  const [produced, setProduced] = useState([])
  const [checked, setChecked] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const fileInput = useRef(null)
  const inboxDir = driveDir ? `${driveDir.replace(/[\\/]+$/, '')}${driveDir.includes('\\') ? '\\' : '/'}projects${driveDir.includes('\\') ? '\\' : '/'}inbox${driveDir.includes('\\') ? '\\' : '/'}${task.id}` : null

  const openPick = async () => {
    if (!currentSession) {
      toast('没有绑定的任务进程；先打开任务进程让 Agent 产出文件', 'error')
      return
    }
    try {
      const r = await api.produced(currentSession)
      setProduced(r.files ?? [])
      setChecked(new Set((r.files ?? []).map((f) => f.path)))
      setPicking(true)
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  const attachChecked = async () => {
    const paths = [...checked]
    if (paths.length === 0) return
    setBusy(true)
    const r = await run(() => api.attachLocal(task.id, paths, currentSession, 'session'), `已附带 ${paths.length} 个窗口产物`)
    setBusy(false)
    if (r) setPicking(false)
  }
  const attachPath = async () => {
    const p = window.prompt('输入本机文件的绝对路径（可多个，用换行分隔）')
    if (!p) return
    const paths = p
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    setBusy(true)
    await run(() => api.attachLocal(task.id, paths, currentSession ?? null, 'manual'), '已添加交付物')
    setBusy(false)
  }
  const upload = async (files) => {
    if (!files?.length) return
    setBusy(true)
    try {
      const payload = []
      for (const f of files) {
        if (f.size > 20 * 1024 * 1024) throw new Error(`${f.name} 超过 20MB`)
        const buf = new Uint8Array(await f.arrayBuffer())
        let bin = ''
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
        payload.push({ name: f.name, dataBase64: btoa(bin), source: 'upload', sessionId: currentSession ?? null })
      }
      const r = await api.gw.post(`/tasks/${task.id}/deliverables`, { files: payload })
      applyTask(r.task)
      toast(`已上传 ${payload.length} 个文件到公司盘`, 'success')
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }
  return (
    <div className="dk-card">
      <div className="dk-card-title" style={{ flexWrap: 'wrap' }}>
        <span>
          交付物 <span className="dk-muted dk-small">公司盘 projects/inbox/{task.id}/</span>
        </span>
        {editable && (
          <div className="dk-row wrap" style={{ gap: 6 }}>
            <button className="dk-btn sm" disabled={busy} onClick={openPick} title="把任务进程中 Agent 写出的文件挂到任务卡">
              <IconLink size={13} /> 附带窗口产物
            </button>
            <button className="dk-btn sm" disabled={busy} onClick={() => fileInput.current?.click()}>
              <IconPlus size={13} /> 添加文件
            </button>
            <button className="dk-btn sm ghost" disabled={busy} onClick={attachPath} title="按本机路径添加">
              本机路径…
            </button>
            <input ref={fileInput} type="file" multiple style={{ display: 'none' }} onChange={(e) => upload([...e.target.files])} />
          </div>
        )}
      </div>
      {task.deliverables?.length === 0 && <div className="dk-alert warn">口头完成不算完成：提交验收前，至少要有一个交付物放进任务卡。</div>}
      {task.deliverables?.map((d) => (
        <div key={d.name} className="dk-deliverable">
          <span className="icon">{ext(d.name)}</span>
          <div className="info">
            <div className="n">{d.name}</div>
            <div className="s">
              {fmtBytes(d.size)} · {sourceLabel(d.source)} · {fmtTime(d.addedAt)}
              {d.sessionId ? ` · 来自进程 ${shortSid(d.sessionId)}` : ''}
              {d.localPath ? ` · ${d.localPath}` : ''}
            </div>
          </div>
          <a className="dk-btn sm ghost" href={`/desk/api/gw/tasks/${encodeURIComponent(task.id)}/deliverables/${encodeURIComponent(d.name)}`} target="_blank" rel="noreferrer" title="下载">
            下载
          </a>
          {editable && (
            <button className="dk-iconbtn" title="移除" onClick={() => window.confirm(`移除交付物 ${d.name}？`) && run(() => api.gw.delete(`/tasks/${task.id}/deliverables/${encodeURIComponent(d.name)}`), '已移除')}>
              <IconTrash size={14} />
            </button>
          )}
        </div>
      ))}
      {inboxDir && (
        <div className="dk-row" style={{ marginTop: 10 }}>
          <button className="dk-btn sm ghost" onClick={() => api.openPath(inboxDir).catch((e) => toast(e.message, 'error'))}>
            <IconFolder size={13} /> 打开本机镜像目录
          </button>
          <span className="dk-xs dk-muted dk-ellipsis">{inboxDir}</span>
        </div>
      )}
      {picking && (
        <div className="dk-overlay" onClick={() => setPicking(false)}>
          <div className="dk-dialog wide" onClick={(e) => e.stopPropagation()}>
            <h2>附带窗口产物</h2>
            <div className="sub">任务进程 {currentSession} 中 Agent 写出的文件（勾选后上传到公司盘任务格子）</div>
            {produced.length === 0 ? (
              <div className="dk-empty">这个进程里还没有 Agent 写出的文件。</div>
            ) : (
              <div className="dk-picklist">
                {produced.map((f) => (
                  <label key={f.path}>
                    <input
                      type="checkbox"
                      checked={checked.has(f.path)}
                      onChange={(e) => {
                        const next = new Set(checked)
                        if (e.target.checked) next.add(f.path)
                        else next.delete(f.path)
                        setChecked(next)
                      }}
                    />
                    <span className="dk-grow dk-ellipsis" title={f.path}>
                      {f.path}
                    </span>
                    <span className="dk-xs dk-muted">
                      {f.exists === false ? '已不存在' : fmtBytes(f.size)} · {f.tool}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <div className="dk-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="dk-btn" onClick={() => setPicking(false)}>
                取消
              </button>
              <button className="dk-btn primary" disabled={busy || checked.size === 0} onClick={attachChecked}>
                附带 {checked.size} 个文件
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SubmitBox({ task, me }) {
  const people = useStoreValue(deskStore, (s) => s.people)
  const reviewers = people.filter((p) => p.role !== 'employee' && p.id !== me.id)
  const [reviewerId, setReviewerId] = useState(task.reviewerId ?? reviewers[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (people.length === 0) loadPeople()
  }, [people.length])
  useEffect(() => {
    if (!reviewerId && reviewers[0]) setReviewerId(reviewers[0].id)
  }, [reviewers.length])
  const reviewer = reviewers.find((r) => r.id === reviewerId)
  const submit = async () => {
    setBusy(true)
    await run(() => api.gw.post(`/tasks/${task.id}/submit`, { reviewerId }), reviewer ? `已发给 ${who(reviewer)} 验收` : '已提交验收')
    setBusy(false)
    loadTasks()
  }
  return (
    <div>
      <div className="dk-small dk-dim" style={{ marginBottom: 8 }}>
        {task.status === 'rejected' ? '任务被驳回，修改后可以重新提交验收。' : '选择审核人（总监或管理员），把任务卡发出去。提交后进入「待审」。'}
      </div>
      <div className="dk-row wrap">
        <select className="dk-select" style={{ width: 260 }} value={reviewerId} onChange={(e) => setReviewerId(e.target.value)}>
          {reviewers.length === 0 && <option value="">（没有可选的审核人）</option>}
          {reviewers.map((r) => (
            <option key={r.id} value={r.id}>
              {r.displayName}（{r.username} · {ROLE[r.role]} · {r.department || '未分组'}）{r.online ? ' · 在线' : ''}
            </option>
          ))}
        </select>
        <button className="dk-btn accent" disabled={busy || !reviewerId || task.deliverables.length === 0} onClick={submit} title={task.deliverables.length === 0 ? '没有交付物不能提交' : ''}>
          <IconSend size={14} /> 发给 {reviewer ? who(reviewer) : '审核人'} 验收
        </button>
      </div>
    </div>
  )
}

function ReviewBox({ task, stage }) {
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const act = async (decision) => {
    setBusy(true)
    await run(() => api.gw.post(`/tasks/${task.id}/${stage}`, { decision, comment }), decision === 'pass' ? (stage === 'review' ? '初审通过，已转待终审' : '终审通过') : '已驳回')
    setBusy(false)
    loadTasks()
  }
  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--dk-border-soft)' }}>
      <div className="dk-small" style={{ fontWeight: 600, marginBottom: 6 }}>
        {stage === 'review' ? '初审（你是本任务的审核人）' : '终审（管理员）'}
      </div>
      <textarea className="dk-textarea" style={{ minHeight: 64 }} placeholder="审核意见（可选）" value={comment} onChange={(e) => setComment(e.target.value)} />
      <div className="dk-row" style={{ marginTop: 8 }}>
        <button className="dk-btn success" disabled={busy} onClick={() => act('pass')}>
          <IconCheck size={14} /> {stage === 'review' ? '初审通过' : '终审通过'}
        </button>
        <button className="dk-btn danger" disabled={busy} onClick={() => act('reject')}>
          驳回
        </button>
      </div>
    </div>
  )
}

function WorkLog({ ctx, task, me, useSessions }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const current = useSessions((s) => s.current)
  const currentTitle = useSessions((s) => (s.current ? s.byId[s.current]?.displayTitle : undefined))
  const currentBound = task.sessions?.some((s) => s.sessionId === current)
  const add = async () => {
    if (!text.trim()) return
    setBusy(true)
    const r = await run(() => api.gw.post(`/tasks/${task.id}/log`, { text: text.trim(), kind: 'note', sessionId: current ?? null }), '已记录')
    setBusy(false)
    if (r) setText('')
  }
  // 「+ 关联」：把当前打开的会话（窗口）挂到这张任务卡上；「撤销」：从卡上摘下来（会话不删）
  const link = async () => {
    if (!current) return
    setBusy(true)
    const r = await run(() => api.bindSession(task.id, current, currentTitle ?? ''), '已关联当前进程')
    if (r?.task) applyTask(r.task)
    setBusy(false)
  }
  const unlink = async (sid) => {
    setBusy(true)
    const r = await run(() => api.unbindSession(task.id, sid), '已撤销关联')
    if (r?.task) applyTask(r.task)
    setBusy(false)
  }
  const logs = [...(task.log ?? [])].reverse()
  return (
    <>
      <div className="dk-card">
        <div className="dk-card-title">
          关联进程
          <span className="dk-muted dk-small" style={{ fontWeight: 400, marginLeft: 6 }}>
            {task.sessions?.length ?? 0} 个
          </span>
          <span style={{ flex: 1 }} />
          <button className="dk-btn sm ghost" disabled={busy || !current || currentBound} title={current ? (currentBound ? '当前进程已关联' : `把当前进程「${currentTitle ?? current}」关联到此任务卡`) : '先在右侧打开一个进程'} onClick={link}>
            <IconPlus size={13} /> 关联
          </button>
        </div>
        {task.sessions?.length === 0 && <div className="dk-small dk-muted">还没有关联进程。点右上角「新进程」打开，或把当前进程「+ 关联」到这张卡。</div>}
        {task.sessions?.map((s) => (
          <div key={s.sessionId} className="dk-deliverable">
            <span className="icon">
              <IconChat size={14} />
            </span>
            <div className="info">
              <div className="n">
                {s.title || '任务进程'}
                {s.user && (
                  <span className="dk-muted dk-small" style={{ marginLeft: 6, fontWeight: 400 }}>
                    {s.user.username} · {fmtTime(s.boundAt)}
                  </span>
                )}
              </div>
              <div className="s">
                {String(s.sessionId).startsWith('session-') ? s.sessionId : `session-${s.sessionId}`}
                {s.device ? ` · ${s.device}` : ''} · 最近活动 {fmtTime(s.lastActiveAt)}
                {current === s.sessionId ? ' · 当前' : ''}
              </div>
            </div>
            <button
              className="dk-btn sm"
              onClick={() => {
                if (!safeOpenSession(ctx, s.sessionId, { requireKnown: true })) {
                  toast('该进程不在本机，已无法打开', 'error')
                  return
                }
                layoutActions.openTaskChat()
              }}
            >
              打开
            </button>
            <button className="dk-btn sm ghost" disabled={busy} title="从任务卡上摘掉这个进程（会话不删）" onClick={() => unlink(s.sessionId)}>
              撤销
            </button>
          </div>
        ))}
      </div>
      <div className="dk-card">
        <div className="dk-card-title">添加日志</div>
        <div className="dk-row">
          <input className="dk-input" placeholder="记一条工作日志（会写进任务卡，Agent 也能读到）" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <button className="dk-btn primary" disabled={busy || !text.trim()} onClick={add}>
            记录
          </button>
        </div>
      </div>
      <div className="dk-card">
        <div className="dk-card-title">工作日志 · {logs.length} 条</div>
        {logs.length === 0 && <div className="dk-empty">还没有日志</div>}
        {logs.map((l) => (
          <div key={l.id} className="dk-log">
            <div className="time">{fmtDateTime(l.ts)}</div>
            <div className="body">
              <span className="kind">{KIND_LABEL[l.kind] ?? l.kind}</span>
              <span className="who">{l.actorName}</span>
              <div className="txt">
                {l.text}
                {l.sessionId && (
                  <button
                    className="dk-btn sm ghost"
                    style={{ marginLeft: 6, height: 20, padding: '0 6px' }}
                    onClick={() => {
                      if (!safeOpenSession(ctx, l.sessionId, { requireKnown: true })) {
                        toast('该进程不在本机，已无法打开', 'error')
                        return
                      }
                      layoutActions.openTaskChat()
                    }}
                  >
                    进程 {shortSid(l.sessionId)}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

/** 右侧“任务进程”列：绑定到当前任务的对话；没有则给出打开进程的入口。 */
export function TaskChatColumn({ ctx, taskId, useSessions, children }) {
  const task = useStoreValue(deskStore, (s) => (s.taskDetail?.id === taskId ? s.taskDetail : s.tasks.find((t) => t.id === taskId)))
  const current = useSessions((s) => s.current)
  const currentTitle = useSessions((s) => (s.current ? s.byId[s.current]?.displayTitle : undefined))
  const bound = task?.sessions?.some((s) => s.sessionId === current)
  const [busy, setBusy] = useState(false)
  const autoOpened = useRef(null)

  // 切到任务时自动打开它最近的进程
  useEffect(() => {
    if (!task) return
    if (autoOpened.current === task.id) return
    autoOpened.current = task.id
    const last = task.sessions?.at(-1)
    if (last && last.sessionId !== current) safeOpenSession(ctx, last.sessionId, { requireKnown: true })
  }, [task?.id])

  if (!task) return <div className="dk-task-placeholder">未选择任务</div>
  const open = async () => {
    setBusy(true)
    await openTaskProcess(ctx, task)
    setBusy(false)
  }
  const bindCurrent = async () => {
    if (!current) return
    setBusy(true)
    await run(() => api.bindSession(task.id, current, currentTitle ?? ''), '已把当前会话绑定到任务')
    setBusy(false)
  }
  return (
    <>
      <div className="dk-chat-head">
        <IconChat size={14} />
        <span className="title" title={current}>
          {bound ? currentTitle || '任务进程' : '任务进程'}
        </span>
        <button className="dk-btn sm ghost" disabled={busy} onClick={open} title="新开一个任务进程（会话工作目录 = 公司盘任务格子）">
          <IconPlus size={13} /> 新进程
        </button>
        <button className="dk-iconbtn" title="收起" onClick={() => layoutActions.toggleTaskChat()}>
          <IconClose size={14} />
        </button>
      </div>
      {bound ? (
        <div className="dk-slot-fill">{children}</div>
      ) : (
        <div className="dk-task-placeholder">
          <Logotype />
          <div>
            这张任务卡还没有任务进程。
            <br />
            打开进程后，Agent 的工作目录就是公司盘里的任务格子；产物可一键附带到任务卡。
          </div>
          <button className="dk-btn primary" disabled={busy} onClick={open}>
            打开任务进程
          </button>
          {current && (
            <button className="dk-btn ghost" disabled={busy} onClick={bindCurrent}>
              把当前会话「{currentTitle ?? current}」绑定到此任务
            </button>
          )}
        </div>
      )}
    </>
  )
}

export function NewTaskDialog({ onClose }) {
  const desk = useStoreValue(deskStore, (s) => s.desk)
  const people = useStoreValue(deskStore, (s) => s.people)
  const me = desk?.user
  const [title, setTitle] = useState('')
  const [assigneeId, setAssigneeId] = useState(me?.id ?? '')
  const [department, setDepartment] = useState(me?.department ?? '')
  const [project, setProject] = useState('')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (people.length === 0) loadPeople()
  }, [people.length])
  const candidates = me?.role === 'employee' ? people.filter((p) => p.id === me.id) : people
  useEffect(() => {
    const a = people.find((p) => p.id === assigneeId)
    if (a?.department && !project) setDepartment(a.department)
  }, [assigneeId, people])
  const create = async () => {
    if (!title.trim()) {
      toast('请填写任务标题', 'error')
      return
    }
    setBusy(true)
    try {
      const r = await api.gw.post('/tasks', { title: title.trim(), assigneeId: assigneeId || undefined, department: department || undefined, project, content })
      applyTask(r.task)
      deskStore.set({ selectedTaskId: r.task.id, taskDetail: r.task, sidebarTab: 'tasks' })
      layoutActions.setMode('task')
      toast('任务卡已创建', 'success')
      onClose()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="dk-overlay" onClick={onClose}>
      <div className="dk-dialog wide" onClick={(e) => e.stopPropagation()}>
        <h2>新建任务</h2>
        <div className="sub">任务卡会保存在公司服务器，并在公司盘 projects/inbox/ 下建一个交付格子。</div>
        <div className="dk-field">
          <label>标题</label>
          <input className="dk-input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：2026 Q3 华东区销售复盘报告" />
        </div>
        <div className="dk-form-grid">
          <div className="dk-field">
            <label>提交人（被派人）</label>
            <select className="dk-select" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}（{p.username} · {ROLE[p.role]} · {p.department || '未分组'}）
                </option>
              ))}
            </select>
            {me?.role === 'employee' && <div className="hint">员工只能给自己建任务卡；派单请找总监/管理员。</div>}
          </div>
          <div className="dk-field">
            <label>部门</label>
            <input className="dk-input" value={department} onChange={(e) => setDepartment(e.target.value)} />
          </div>
          <div className="dk-field">
            <label>项目</label>
            <input className="dk-input" value={project} onChange={(e) => setProject(e.target.value)} placeholder="（可选）" />
          </div>
        </div>
        <div className="dk-field">
          <label>任务内容</label>
          <textarea className="dk-textarea" value={content} onChange={(e) => setContent(e.target.value)} placeholder="要做什么、验收标准、交付物形式…（可稍后从 Agent 窗口采用）" />
        </div>
        <div className="dk-row" style={{ justifyContent: 'flex-end' }}>
          <button className="dk-btn" onClick={onClose}>
            取消
          </button>
          <button className="dk-btn primary" disabled={busy} onClick={create}>
            创建任务卡
          </button>
        </div>
      </div>
    </div>
  )
}

function ext(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name)
  return m ? m[1].slice(0, 4) : 'file'
}
function sourceLabel(s) {
  return { session: '窗口产物', manual: '本机文件', upload: '上传', agent: 'Agent 挂接' }[s] ?? s
}
