/**
 * 输入框工具行的「生图」芯片：打开对话框，经公司网关出图，把文件放进工作目录并插入 Markdown。
 */
import { useEffect, useState } from 'react'
import { api } from './api.js'
import { toast } from './store.js'

const RATIOS = [
  { id: '1:1', label: '1:1 头像' },
  { id: '16:9', label: '16:9 横图' },
  { id: '9:16', label: '9:16 竖图' },
  { id: '4:3', label: '4:3' },
  { id: '3:4', label: '3:4' },
]

export function ImageGenSection() {
  const [q, setQ] = useState({ loading: true, data: null, error: null })
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState(null)
  const reload = async () => {
    try {
      const data = await api.image.config()
      setQ({ loading: false, data, error: null })
      setDraft({
        defaultModel: data.defaultModel ?? 'grok',
        aspectRatio: data.aspectRatio ?? '1:1',
        customModels: (data.customModels ?? []).join(', '),
      })
    } catch (err) {
      setQ({ loading: false, data: null, error: err.message })
    }
  }
  useEffect(() => {
    reload()
  }, [])
  if (q.error) return <div className="dk-settings"><h3>生图</h3><div className="dk-alert error">{q.error}</div></div>
  if (!q.data || !draft) return <div className="dk-settings"><h3>生图</h3><div className="dk-empty">加载中…</div></div>
  const models = q.data.models ?? []
  const save = async () => {
    setBusy(true)
    try {
      await api.image.saveConfig({
        defaultModel: draft.defaultModel.trim() || 'grok',
        aspectRatio: draft.aspectRatio,
        customModels: draft.customModels,
      })
      toast('生图设置已保存', 'success')
      await reload()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="dk-settings">
      <div className="dk-row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h3>生图</h3>
          <div className="lead" style={{ marginTop: 4 }}>
            走公司网关 <span className="dk-mono">/v1/images/*</span>，密钥不落本机。短名 <b>gpt</b> / <b>qwen</b> / <b>grok</b> 会自动对到目录里已接入的模型。
          </div>
        </div>
        <button className="dk-btn sm" onClick={reload}>刷新</button>
      </div>
      <div className="dk-card">
        <div className="dk-card-title">默认模型</div>
        <div className="dk-field">
          <label>短名或模型 id</label>
          <input className="dk-input" value={draft.defaultModel} onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })} placeholder="grok / gpt / qwen / grok-imagine-image-2.0" />
          <div className="hint">当前解析为 {q.data.resolvedDefault ?? '（目录里还没有生图模型）'}</div>
        </div>
        <div className="dk-field">
          <label>默认构图</label>
          <select className="dk-select" value={draft.aspectRatio} onChange={(e) => setDraft({ ...draft, aspectRatio: e.target.value })}>
            {RATIOS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </div>
        <div className="dk-field">
          <label>额外模型 id（逗号分隔）</label>
          <input className="dk-input" value={draft.customModels} onChange={(e) => setDraft({ ...draft, customModels: e.target.value })} placeholder="gpt-image-1, qwen-image" />
          <div className="hint">目录还没同步到、但网关已经能转发的 id 可以写在这里。</div>
        </div>
        <button className="dk-btn sm primary" disabled={busy} onClick={save}>保存</button>
      </div>
      <div className="dk-card">
        <div className="dk-card-title">公司目录里的生图模型</div>
        {models.length === 0 ? (
          <div className="dk-small dk-muted">还没有。管理员在「同事 → 通道」接入 GPT Image / 通义万相 / Grok Imagine 后会出现在这里。</div>
        ) : (
          <ul className="dk-small" style={{ margin: 0, paddingLeft: 18 }}>
            {models.map((m) => (
              <li key={m.id}>
                <span className="dk-mono">{m.id}</span>
                {m.name && m.name !== m.id ? <span className="dk-muted"> · {m.name}</span> : null}
                {m.providerLabel ? <span className="dk-muted"> · {m.providerLabel}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export function makeImageChip(ctx) {
  return function ImageChip({ sessionId, useInput, inputActions, useSessions }) {
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [prompt, setPrompt] = useState('')
    const [model, setModel] = useState('')
    const [ratio, setRatio] = useState('1:1')
    const [cfg, setCfg] = useState(null)
    const phase = useInput((s) => s?.phase)
    const draftText = useInput((s) => s?.draft ?? '')
    const cwd = useSessions((s) => (sessionId === undefined ? undefined : s.byId[sessionId]?.cwd))
    const locked = phase === 'adjudicating' || phase === 'submitting'

    useEffect(() => {
      if (!open) return
      api.image.config().then((data) => {
        setCfg(data)
        setModel((cur) => cur || data.defaultModel || data.resolvedDefault || 'grok')
        setRatio((cur) => (cur === '1:1' ? data.aspectRatio || '1:1' : cur))
      }).catch((err) => toast(err.message, 'error'))
    }, [open])

    const insert = (rel) => {
      const md = `![${rel.split(/[\\/]/).pop()}](${rel})`
      const conversation = ctx.get('conversation')
      const shell = conversation?.input?.shell?.(sessionId)
      if (shell) {
        const draft = shell.snapshot.draft
        const gap = draft.length > 0 && !/\s$/.test(draft) ? ' ' : ''
        shell.setDraft(`${draft}${gap}${md}\n`)
        return
      }
      const cur = draftText || ''
      inputActions?.setDraft?.(`${cur}${cur && !/\s$/.test(cur) ? ' ' : ''}${md}\n`)
    }

    const submit = async () => {
      if (!prompt.trim() || !sessionId) return
      setBusy(true)
      try {
        const r = await api.image.generate({ sessionId, cwd, prompt: prompt.trim(), model: model.trim() || undefined, aspectRatio: ratio })
        const files = r.written ?? []
        for (const f of files) insert(f.rel)
        toast(files.length ? `已生成 ${files.map((f) => f.rel).join('、')}` : '生图完成', 'success')
        setPrompt('')
        setOpen(false)
      } catch (err) {
        toast(err.message ?? String(err), 'error')
      } finally {
        setBusy(false)
      }
    }

    const models = cfg?.models ?? []
    return (
      <>
        <button
          type="button"
          className="dk-composer-chip"
          title="通过公司网关生图，不切换当前对话模型"
          aria-label="生图"
          disabled={busy || locked || !sessionId}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen(true)}
        >
          <span className="dk-composer-chip-icon" aria-hidden>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
              <circle cx="6" cy="7" r="1.1" />
              <path d="M4.5 11.2 7.2 8.6l2 1.7 2.3-2.6 2 2.5" />
            </svg>
          </span>
          <span className="dk-composer-chip-label">{busy ? '出图中…' : '生图'}</span>
        </button>
        {open && (
          <div className="dk-overlay" onClick={() => !busy && setOpen(false)}>
            <div className="dk-dialog" onClick={(e) => e.stopPropagation()}>
              <h2>生图</h2>
              <div className="sub">走公司网关，可选 GPT / Qwen / Grok。图片写入当前工作目录。</div>
              <div className="dk-field">
                <label>提示词</label>
                <textarea className="dk-textarea" rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="主体 → 姿态 → 场景 → 风格 → 构图 → 光影" autoFocus />
              </div>
              <div className="dk-form-grid">
                <div className="dk-field">
                  <label>模型</label>
                  <input className="dk-input" list="dk-image-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="grok / gpt / qwen" />
                  <datalist id="dk-image-models">
                    {['gpt', 'qwen', 'grok', ...models.map((m) => m.id)].map((id) => <option key={id} value={id} />)}
                  </datalist>
                </div>
                <div className="dk-field">
                  <label>构图</label>
                  <select className="dk-select" value={ratio} onChange={(e) => setRatio(e.target.value)}>
                    {RATIOS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="dk-row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
                <button className="dk-btn" disabled={busy} onClick={() => setOpen(false)}>取消</button>
                <button className="dk-btn primary" disabled={busy || !prompt.trim()} onClick={submit}>{busy ? '出图中…' : '生成'}</button>
              </div>
            </div>
          </div>
        )}
      </>
    )
  }
}
