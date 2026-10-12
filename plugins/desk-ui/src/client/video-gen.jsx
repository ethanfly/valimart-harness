/**
 * 输入框工具行的「生视频」芯片：选公司目录里的视频模型，多张参考图 + 提示词，经网关出片。
 */
import { useEffect, useState } from 'react'
import { api } from './api.js'
import { toast } from './store.js'

const RATIOS = [
  { id: '16:9', label: '16:9 横屏' },
  { id: '9:16', label: '9:16 竖屏' },
  { id: '1:1', label: '1:1' },
  { id: '4:3', label: '4:3' },
  { id: '3:4', label: '3:4' },
]
const SHORT = ['wan', 'minimax', 'grok', 'gpt', 'qwen', 'seedance']

export function VideoGenSection() {
  const [q, setQ] = useState({ loading: true, data: null, error: null })
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState(null)
  const reload = async () => {
    try {
      const data = await api.video.config()
      setQ({ loading: false, data, error: null })
      setDraft({
        defaultModel: data.defaultModel ?? 'grok',
        aspectRatio: data.aspectRatio ?? '16:9',
        duration: data.duration ?? 6,
        longForm: data.longForm !== false,
        customModels: (data.customModels ?? []).join(', '),
      })
    } catch (err) {
      setQ({ loading: false, data: null, error: err.message })
    }
  }
  useEffect(() => { reload() }, [])
  if (q.error) return <div className="dk-settings"><h3>生视频</h3><div className="dk-alert error">{q.error}</div></div>
  if (!q.data || !draft) return <div className="dk-settings"><h3>生视频</h3><div className="dk-empty">加载中…</div></div>
  const models = q.data.models ?? []
  const save = async () => {
    setBusy(true)
    try {
      await api.video.saveConfig({
        defaultModel: draft.defaultModel.trim() || 'grok',
        aspectRatio: draft.aspectRatio,
        duration: Number(draft.duration) || 6,
        longForm: draft.longForm,
        customModels: draft.customModels,
      })
      toast('生视频设置已保存', 'success')
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
          <h3>生视频</h3>
          <div className="lead" style={{ marginTop: 4 }}>
            走公司网关 <span className="dk-mono">/v1/videos/generations</span>，密钥不落本机。短名 <b>wan</b> / <b>minimax</b> / <b>grok</b> / <b>gpt</b> / <b>qwen</b> / <b>seedance</b> 对到目录里已接入的模型。
          </div>
        </div>
        <button className="dk-btn sm" onClick={reload}>刷新</button>
      </div>
      <div className="dk-card">
        <div className="dk-card-title">默认模型</div>
        <div className="dk-field">
          <label>从公司目录选择</label>
          <select className="dk-select" value={models.some((m) => m.id === draft.defaultModel) ? draft.defaultModel : ''} onChange={(e) => e.target.value && setDraft({ ...draft, defaultModel: e.target.value })}>
            <option value="">{models.length ? '（用下面的短名）' : '目录里还没有视频模型'}</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.name && m.name !== m.id ? `${m.name} · ${m.id}` : m.id}</option>)}
          </select>
        </div>
        <div className="dk-field">
          <label>短名或模型 id</label>
          <input className="dk-input" list="dk-video-short" value={draft.defaultModel} onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })} placeholder="grok / wan / seedance" />
          <datalist id="dk-video-short">{SHORT.map((id) => <option key={id} value={id} />)}</datalist>
          <div className="hint">当前解析为 {q.data.resolvedDefault ?? '（目录里还没有视频模型）'}，单段上限约 {q.data.segmentCap ?? 8} 秒</div>
        </div>
        <div className="dk-form-grid">
          <div className="dk-field">
            <label>默认画幅</label>
            <select className="dk-select" value={draft.aspectRatio} onChange={(e) => setDraft({ ...draft, aspectRatio: e.target.value })}>
              {RATIOS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </div>
          <div className="dk-field">
            <label>默认时长（秒）</label>
            <input className="dk-input" type="number" min="1" max={q.data.maxDuration ?? 120} value={draft.duration} onChange={(e) => setDraft({ ...draft, duration: e.target.value })} />
          </div>
        </div>
        <div className="dk-field">
          <label><input type="checkbox" checked={draft.longForm} onChange={(e) => setDraft({ ...draft, longForm: e.target.checked })} /> 长视频：超过单段上限时分段生成并用 ffmpeg 拼接</label>
        </div>
        <div className="dk-field">
          <label>额外模型 id（逗号分隔）</label>
          <input className="dk-input" value={draft.customModels} onChange={(e) => setDraft({ ...draft, customModels: e.target.value })} placeholder="wan2.6-t2v, sora-2" />
        </div>
        <button className="dk-btn sm primary" disabled={busy} onClick={save}>保存</button>
      </div>
      <div className="dk-card">
        <div className="dk-card-title">公司目录里的视频模型</div>
        {models.length === 0 ? (
          <div className="dk-small dk-muted">还没有。管理员在通道里接入万相 / MiniMax 海螺 / Grok / Sora / Seedance 后会出现在这里。</div>
        ) : (
          <ul className="dk-small" style={{ margin: 0, paddingLeft: 18 }}>
            {models.map((m) => (
              <li key={m.id}>
                <span className="dk-mono">{m.id}</span>
                {m.providerLabel ? <span className="dk-muted"> · {m.providerLabel}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export function makeVideoChip(ctx) {
  return function VideoChip({ sessionId, useInput, inputActions, useSessions }) {
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [prompt, setPrompt] = useState('')
    const [model, setModel] = useState('')
    const [ratio, setRatio] = useState('16:9')
    const [duration, setDuration] = useState(6)
    const [images, setImages] = useState('')
    const [cfg, setCfg] = useState(null)
    const phase = useInput((s) => s?.phase)
    const draftText = useInput((s) => s?.draft ?? '')
    const cwd = useSessions((s) => (sessionId === undefined ? undefined : s.byId[sessionId]?.cwd))
    const locked = phase === 'adjudicating' || phase === 'submitting'

    useEffect(() => {
      if (!open) return
      api.video.config().then((data) => {
        setCfg(data)
        setModel((cur) => cur || data.resolvedDefault || data.defaultModel || 'grok')
        setRatio((cur) => cur || data.aspectRatio || '16:9')
        setDuration((cur) => cur || data.duration || 6)
      }).catch((err) => toast(err.message, 'error'))
    }, [open])

    const insert = (rel) => {
      const md = `[${rel.split(/[\\/]/).pop()}](${rel})`
      const shell = ctx.get('conversation')?.input?.shell?.(sessionId)
      if (shell) {
        const draft = shell.snapshot.draft
        shell.setDraft(`${draft}${draft.length && !/\s$/.test(draft) ? ' ' : ''}${md}\n`)
        return
      }
      const cur = draftText || ''
      inputActions?.setDraft?.(`${cur}${cur && !/\s$/.test(cur) ? ' ' : ''}${md}\n`)
    }

    const submit = async () => {
      if (!prompt.trim() || !sessionId) return
      setBusy(true)
      try {
        const refs = images.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)
        const r = await api.video.generate({
          sessionId, cwd, prompt: prompt.trim(), model: model.trim() || undefined, aspectRatio: ratio, duration: Number(duration) || undefined, images: refs,
        })
        for (const f of r.written ?? []) insert(f.rel)
        const seg = r.segments?.length > 1 ? `（${r.segments.length} 段拼接）` : ''
        toast(`已生成 ${(r.written ?? []).map((f) => f.rel).join('、')}${seg}`, 'success')
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
        <button type="button" className="dk-composer-chip" title="通过公司网关生视频，不切换当前对话模型" aria-label="生视频" disabled={busy || locked || !sessionId} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(true)}>
          <span className="dk-composer-chip-icon" aria-hidden>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="9" height="8" rx="1.4" />
              <path d="m11 7 3-1.6v5.2L11 9" />
            </svg>
          </span>
          <span className="dk-composer-chip-label">{busy ? '出片中…' : '生视频'}</span>
        </button>
        {open && (
          <div className="dk-overlay" onClick={() => !busy && setOpen(false)}>
            <div className="dk-dialog" onClick={(e) => e.stopPropagation()}>
              <h2>生视频</h2>
              <div className="sub">走公司网关。可选万相 / MiniMax / Grok / Sora / Qwen / Seedance。超过单段上限会分段拼接。</div>
              <div className="dk-field">
                <label>提示词</label>
                <textarea className="dk-textarea" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="主体 → 动作 → 场景 → 镜头 → 光影" autoFocus />
              </div>
              <div className="dk-field">
                <label>参考图（工作目录相对路径，逗号分隔，最多 {cfg?.maxImages ?? 5} 张）</label>
                <input className="dk-input" value={images} onChange={(e) => setImages(e.target.value)} placeholder="refs/a.png, refs/b.png" />
              </div>
              <div className="dk-form-grid">
                <div className="dk-field">
                  <label>模型</label>
                  <input className="dk-input" list="dk-video-models" value={model} onChange={(e) => setModel(e.target.value)} />
                  <datalist id="dk-video-models">{[...SHORT, ...models.map((m) => m.id)].map((id) => <option key={id} value={id} />)}</datalist>
                </div>
                <div className="dk-field">
                  <label>画幅</label>
                  <select className="dk-select" value={ratio} onChange={(e) => setRatio(e.target.value)}>
                    {RATIOS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                </div>
                <div className="dk-field">
                  <label>时长（秒，最长 {cfg?.maxDuration ?? 120}）</label>
                  <input className="dk-input" type="number" min="1" max={cfg?.maxDuration ?? 120} value={duration} onChange={(e) => setDuration(e.target.value)} />
                </div>
              </div>
              <div className="dk-row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
                <button className="dk-btn" disabled={busy} onClick={() => setOpen(false)}>取消</button>
                <button className="dk-btn primary" disabled={busy || !prompt.trim()} onClick={submit}>{busy ? '出片中…' : '生成'}</button>
              </div>
            </div>
          </div>
        )}
      </>
    )
  }
}
