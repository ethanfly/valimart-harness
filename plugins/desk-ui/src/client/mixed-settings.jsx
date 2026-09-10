/**
 * 设置 → Mixed 混合模式：三模型选择器 + 能力/冲突诊断 + 持久化 + 保存冲突横幅 + 无模型提示。
 * 保存只改「下一次运行」的模型路由；进行中的 run 用创建时的快照（计划 §3.3/§7.2）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import { toast, useStoreValue, deskStore } from './store.js'
import { refreshMixedSessions } from './mixed-store.js'

const ROLE_LABEL = { planner: '规划器', executor: '执行器', reviewer: '审核器' }
const ROLE_DESC = {
  planner: '把目标拆成任务 DAG',
  executor: '逐任务实施并产出证据',
  reviewer: '逐项核验验收与证据',
}

function useFetch(fn, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: null })
  const seq = useRef(0)
  const reload = async () => {
    const my = ++seq.current
    try {
      const data = await fn()
      if (seq.current === my) setState({ loading: false, data, error: null })
    } catch (err) {
      if (seq.current === my) setState({ loading: false, data: null, error: err.message })
    }
  }
  useEffect(() => {
    reload()
  }, deps)
  return [state, reload]
}

function conflictedModelIds(conflicts) {
  const ids = new Set()
  for (const c of conflicts) {
    if (c.modelId) ids.add(c.modelId)
    if (c.kind === 'duplicate-modelId' && c.key) ids.add(c.key)
    if (Array.isArray(c.models)) for (const id of c.models) if (id) ids.add(id)
  }
  return ids
}

function Head({ title, desc, right }) {
  return (
    <div className="dk-row between" style={{ alignItems: 'flex-start' }}>
      <div>
        <h3>{title}</h3>
        {desc && <div className="lead" style={{ marginTop: 4 }}>{desc}</div>}
      </div>
      {right}
    </div>
  )
}

const KEY = (p, m) => `${p}|${m}`

export function MixedSection({ close }) {
  const desk = useStoreValue(deskStore, (s) => s.desk)
  const [state, reload] = useFetch(() => api.mixed.config(), [desk?.loggedIn])
  const data = state.data
  const models = data?.catalog?.models ?? []
  const conflicts = data?.catalog?.conflicts ?? []
  const prefs = data?.preferences ?? null
  const problems = data?.diagnostics?.problems ?? []
  const conflictModelIds = conflictedModelIds(conflicts)

  const grouped = useMemo(() => {
    const g = new Map()
    for (const m of models) {
      const p = m.provider ?? m.catalogProvider ?? 'default'
      if (!g.has(p)) g.set(p, { label: m.providerLabel ?? p, models: [] })
      g.get(p).models.push(m)
    }
    return [...g.values()]
  }, [models])

  const [sel, setSel] = useState(null) // {planner: 'prov|model', executor, reviewer}
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(null)
  const [saveNote, setSaveNote] = useState(null)
  useEffect(() => {
    if (prefs && !sel) {
      setSel({
        planner: KEY(prefs.planner.catalogProvider, prefs.planner.modelId),
        executor: KEY(prefs.executor.catalogProvider, prefs.executor.modelId),
        reviewer: KEY(prefs.reviewer.catalogProvider, prefs.reviewer.modelId),
      })
    }
  }, [prefs, sel])
  useEffect(() => {
    setConflict(null)
    setSaveNote(null)
  }, [state.data])

  if (!desk?.loggedIn) return <div className="dk-settings"><Head title="Mixed 混合模式" desc="尚未登录公司网关。" /></div>

  const curKey = (r) => (prefs?.[r] ? KEY(prefs[r].catalogProvider, prefs[r].modelId) : '')
  const dirty = !!sel && (sel.planner !== curKey('planner') || sel.executor !== curKey('executor') || sel.reviewer !== curKey('reviewer'))

  const save = async () => {
    if (!sel || Object.values(sel).some((v) => !v)) return toast('三个角色都要选模型', 'error')
    setBusy(true)
    setSaveNote(null)
    try {
      const body = {}
      for (const role of ['planner', 'executor', 'reviewer']) {
        const [catalogProvider, modelId] = sel[role].split('|')
        body[role] = { catalogProvider, modelId }
      }
      if (prefs) body.expectedRevision = prefs.revision
      await api.mixed.saveConfig(body)
      toast('已保存，下一次运行生效', 'success')
      await reload()
      // 立即同步被 watch 的会话状态（芯片的 configured 不等 5s 空闲轮询）
      refreshMixedSessions()
    } catch (err) {
      if (err.code === 'config_revision_conflict') setConflict('配置版本冲突：另一个窗口已保存过。已为你加载最新配置，改动需重做。')
      else toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dk-settings">
      <Head title="Mixed 混合模式" desc="规划 → 实施 → 审核 → 返修 → 再审：三个角色都从公司模型目录里选，宿主负责调度、验证与交付。" />

      {!state.loading && data && (
        <>
          {conflict && (
            <div className="dk-mixed-banner warn">
              <span>{conflict}</span>
              <button type="button" className="dk-btn sm" onClick={() => { setConflict(null); reload() }}>重新加载</button>
            </div>
          )}
          {saveNote && <div className="dk-mixed-banner ok"><span>{saveNote}</span></div>}
          {state.error && <div className="dk-mixed-banner err"><span>加载失败：{state.error}</span></div>}
          {!state.error && models.length === 0 && (
            <div className="dk-mixed-banner warn">
              <span>公司目录还没有可用模型（{data.catalogError ? data.catalogError : '目录为空'}）。Mixed 需要先有模型才能配置。</span>
            </div>
          )}
        </>
      )}

      <div className="dk-card">
        {state.loading && <div className="dk-muted">加载中…</div>}
        {models.length === 0 && !state.loading && <div className="dk-muted">（无可选模型）</div>}
        {['planner', 'executor', 'reviewer'].map((role) => {
          const cur = sel?.[role] ?? ''
          const saved = prefs?.[role]
          const savedKey = saved ? KEY(saved.catalogProvider, saved.modelId) : ''
          return (
            <div key={role} className="dk-mixed-role">
              <div className="dk-mixed-role-head">
                <span className="k">{ROLE_LABEL[role]}</span>
                <span className="dk-muted dk-xs">{ROLE_DESC[role]}</span>
              </div>
              <select
                className="dk-select"
                value={cur}
                disabled={!models.length}
                onChange={(e) => setSel((s) => ({ ...(s ?? { planner: '', executor: '', reviewer: '' }), [role]: e.target.value }))}
              >
                <option value="" disabled>选择模型…</option>
                {grouped.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.models.map((m) => {
                      const key = KEY(m.provider ?? m.catalogProvider, m.id ?? m.modelId)
                      const conflicted = conflictModelIds.has(m.id ?? m.modelId)
                      return (
                        <option key={key} value={key} disabled={conflicted}>
                          {m.name ?? m.id ?? m.modelId}
                          {conflicted ? '（目录冲突，已禁用）' : ''}
                          {savedKey === key ? ' ✓' : ''}
                        </option>
                      )
                    })}
                  </optgroup>
                ))}
              </select>
              {saved && (
                <div className="dk-muted dk-xs">当前生效：{saved.catalogProvider}/{saved.modelId}（revision {saved.capabilitiesRevision ?? '—'}）</div>
              )}
            </div>
          )
        })}
      </div>

      {problems.length > 0 && (
        <div className="dk-card">
          <div className="k" style={{ marginBottom: 6 }}>配置诊断</div>
          {problems.map((p, i) => (
            <div key={i} className="dk-mixed-problem">{ROLE_LABEL[p.role] ?? p.role}：{p.reason}</div>
          ))}
        </div>
      )}

      <div className="dk-row" style={{ marginTop: 10 }}>
        <button type="button" className="dk-btn primary" onClick={save} disabled={busy || !dirty || !sel || Object.values(sel).some((v) => !v)}>
          {busy ? '保存中…' : dirty ? '保存（下一次运行生效）' : '已保存'}
        </button>
        <span className="dk-muted dk-xs">进行中的运行仍使用创建时的模型快照；保存只影响下一次运行。</span>
      </div>
    </div>
  )
}
