/**
 * 会话视图「生图 / 视频」：本工作目录的历史，加一个新建任务的表单。
 * 历史由 desk-image 写在 <cwd>/.desk-media/history.json，两个插件共用。
 */
import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { toast } from './store.js'

const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4']
const MAX_REFS = 5

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function timeOf(at) {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function useMedia(sessionId, key) {
  const [state, setState] = useState({ loading: true, cfg: null, items: [], imageItems: [] })
  const reload = async () => {
    const [cfg, history] = await Promise.all([
      key === 'image' ? api.image.config() : api.video.config(),
      api.image.history(sessionId),
    ])
    setState({ loading: false, cfg, items: history?.[key] ?? [], imageItems: history?.image ?? [] })
    return cfg
  }
  useEffect(() => {
    let dead = false
    reload().catch((err) => { if (!dead) { toast(err.message, 'error'); setState((s) => ({ ...s, loading: false })) } })
    return () => { dead = true }
  }, [sessionId])
  return { ...state, reload }
}

function History({ sessionId, items, kind }) {
  if (!items.length) return <div className="dk-empty">还没有{kind === 'image' ? '生图' : '生视频'}记录。点右上角新建。</div>
  return (
    <div className="dk-media-grid">
      {items.map((item, i) => (
        <article className="dk-card" key={`${item.at}-${i}`}>
          <div className="dk-row between">
            <span className="dk-mono dk-small">{item.model}</span>
            <span className="dk-small dk-muted">{timeOf(item.at)}</span>
          </div>
          <div className="dk-media-prompt">{item.prompt}</div>
          <div className="dk-small dk-muted">
            {item.aspectRatio}{item.duration ? ` · ${item.duration}s` : ''}{item.segments?.length > 1 ? ` · ${item.segments.length} 段` : ''}
          </div>
          <div className="dk-media-files">
            {(item.files ?? []).map((f) => {
              const src = `/desk/api/sessions/${encodeURIComponent(sessionId)}/${kind === 'image' ? 'image' : 'video'}?path=${encodeURIComponent(f.rel)}`
              return kind === 'image'
                ? <img key={f.rel} src={src} alt={f.rel} />
                : (
                  <div key={f.rel} className="dk-media-clip">
                    <video src={src} controls preload="metadata" />
                    <a className="dk-mono dk-small" href={src} download={f.rel.split('/').pop()}>{f.rel}</a>
                  </div>
                )
            })}
          </div>
        </article>
      ))}
    </div>
  )
}

export function ImageTab({ sessionId }) {
  const { loading, cfg, items, reload } = useMedia(sessionId, 'image')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [ratio, setRatio] = useState('1:1')
  useEffect(() => { if (cfg) { setModel((v) => v || cfg.defaultModel || 'grok'); setRatio(cfg.aspectRatio || '1:1') } }, [cfg])
  const submit = async () => {
    setBusy(true)
    try {
      await api.image.generate({ sessionId, prompt: prompt.trim(), model: model.trim() || undefined, aspectRatio: ratio })
      setPrompt('')
      setOpen(false)
      await reload()
      toast('生图完成', 'success')
    } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
  }
  return (
    <div className="dk-media-tab">
      <div className="dk-row between">
        <h3>生图</h3>
        <button className="dk-btn sm primary" onClick={() => setOpen((v) => !v)}>{open ? '收起' : '新建生图'}</button>
      </div>
      {open && (
        <form className="dk-card dk-media-form" onSubmit={(e) => { e.preventDefault(); submit() }}>
          <label className="dk-media-field">
            <span>提示词</span>
            <textarea className="dk-textarea" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="主体 → 姿态 → 场景 → 风格 → 构图" autoFocus />
          </label>
          <div className="dk-media-form-row">
            <label className="dk-media-field">
              <span>模型</span>
              <input className="dk-input" list="dk-tab-image-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt / qwen / grok" />
              <datalist id="dk-tab-image-models">{['gpt', 'qwen', 'grok', ...(cfg?.models ?? []).map((m) => m.id)].map((id) => <option key={id} value={id} />)}</datalist>
            </label>
            <label className="dk-media-field dk-media-field-short">
              <span>构图</span>
              <select className="dk-select" value={ratio} onChange={(e) => setRatio(e.target.value)}>{RATIOS.map((r) => <option key={r}>{r}</option>)}</select>
            </label>
          </div>
          <div className="dk-media-form-actions">
            <button type="button" className="dk-btn sm" disabled={busy} onClick={() => setOpen(false)}>取消</button>
            <button type="submit" className="dk-btn sm primary" disabled={busy || !prompt.trim()}>{busy ? '出图中…' : '生成'}</button>
          </div>
        </form>
      )}
      {loading ? <div className="dk-empty">加载中…</div> : <History sessionId={sessionId} items={items} kind="image" />}
    </div>
  )
}

export function VideoTab({ sessionId }) {
  const { loading, cfg, items, imageItems, reload } = useMedia(sessionId, 'video')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [ratio, setRatio] = useState('16:9')
  const [duration, setDuration] = useState(6)
  const [refs, setRefs] = useState([])
  const fileRef = useRef(null)
  useEffect(() => { if (cfg) { setModel((v) => v || cfg.resolvedDefault || cfg.defaultModel || 'grok'); setRatio(cfg.aspectRatio || '16:9'); setDuration(cfg.duration || 6) } }, [cfg])
  const addRef = (rel) => setRefs((cur) => (cur.includes(rel) || cur.length >= MAX_REFS ? cur : [...cur, rel]))
  const onUpload = async (ev) => {
    const list = [...(ev.target.files ?? [])].slice(0, MAX_REFS - refs.length)
    ev.target.value = ''
    if (!list.length) return
    setBusy(true)
    try {
      const payload = []
      for (const f of list) payload.push({ name: f.name, dataBase64: await readAsBase64(f) })
      const r = await api.attachFiles(sessionId, payload)
      for (const f of r.files ?? []) addRef(f.rel)
    } catch (err) { toast(err.message ?? String(err), 'error') } finally { setBusy(false) }
  }
  const submit = async () => {
    setBusy(true)
    try {
      await api.video.generate({ sessionId, prompt: prompt.trim(), model: model.trim() || undefined, aspectRatio: ratio, duration: Number(duration) || undefined, images: refs })
      setPrompt('')
      setRefs([])
      setOpen(false)
      await reload()
      toast('生视频完成', 'success')
    } catch (err) { toast(err.message, 'error') } finally { setBusy(false) }
  }
  return (
    <div className="dk-media-tab">
      <div className="dk-row between">
        <h3>视频</h3>
        <button className="dk-btn sm primary" onClick={() => setOpen((v) => !v)}>{open ? '收起' : '新建生视频'}</button>
      </div>
      {open && (
        <form className="dk-card dk-media-form" onSubmit={(e) => { e.preventDefault(); submit() }}>
          <label className="dk-media-field">
            <span>提示词</span>
            <textarea className="dk-textarea" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="主体 → 动作 → 场景 → 镜头 → 光影" autoFocus />
          </label>
          <div className="dk-media-field">
            <span>参考图（最多 {MAX_REFS} 张）</span>
            <div className="dk-media-refs">
              {refs.map((rel) => (
                <button type="button" key={rel} className="dk-media-ref on" title="移除" onClick={() => setRefs((cur) => cur.filter((x) => x !== rel))}>
                  <img src={`/desk/api/sessions/${encodeURIComponent(sessionId)}/image?path=${encodeURIComponent(rel)}`} alt="" />
                </button>
              ))}
              {refs.length < MAX_REFS && <button type="button" className="dk-media-ref add" onClick={() => fileRef.current?.click()}>上传</button>}
              <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onUpload} />
            </div>
            {imageItems.length > 0 && (
              <div className="dk-media-picks">
                {imageItems.flatMap((item) => (item.files ?? []).map((f) => f.rel)).filter((rel, i, all) => all.indexOf(rel) === i).slice(0, 24).map((rel) => (
                  <button type="button" key={rel} className={`dk-media-ref${refs.includes(rel) ? ' on' : ''}`} disabled={!refs.includes(rel) && refs.length >= MAX_REFS} onClick={() => (refs.includes(rel) ? setRefs((cur) => cur.filter((x) => x !== rel)) : addRef(rel))}>
                    <img src={`/desk/api/sessions/${encodeURIComponent(sessionId)}/image?path=${encodeURIComponent(rel)}`} alt="" />
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="dk-media-form-row">
            <label className="dk-media-field">
              <span>模型</span>
              <input className="dk-input" list="dk-tab-video-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="wan / grok / seedance" />
              <datalist id="dk-tab-video-models">{['wan', 'minimax', 'grok', 'gpt', 'qwen', 'seedance', ...(cfg?.models ?? []).map((m) => m.id)].map((id) => <option key={id} value={id} />)}</datalist>
            </label>
            <label className="dk-media-field dk-media-field-short">
              <span>画幅</span>
              <select className="dk-select" value={ratio} onChange={(e) => setRatio(e.target.value)}>{RATIOS.map((r) => <option key={r}>{r}</option>)}</select>
            </label>
            <label className="dk-media-field dk-media-field-short">
              <span>时长（秒）</span>
              <input className="dk-input" type="number" min="1" max={cfg?.maxDuration ?? 120} value={duration} onChange={(e) => setDuration(e.target.value)} />
            </label>
          </div>
          <div className="dk-media-form-actions">
            <button type="button" className="dk-btn sm" disabled={busy} onClick={() => setOpen(false)}>取消</button>
            <button type="submit" className="dk-btn sm primary" disabled={busy || !prompt.trim()}>{busy ? '出片中…' : '生成'}</button>
          </div>
        </form>
      )}
      {loading ? <div className="dk-empty">加载中…</div> : <History sessionId={sessionId} items={items} kind="video" />}
    </div>
  )
}
