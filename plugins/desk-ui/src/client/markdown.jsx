import { useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { imageMarkdownParts } from './image-markdown.js'

export function SessionMarkdown({ text, sessionId, ...props }) {
  const [failed, setFailed] = useState(() => new Set())
  const [revision, setRevision] = useState(0)
  const [preview, setPreview] = useState(null)
  const dialog = useRef(null)
  useEffect(() => { setFailed(new Set()); setPreview(null); setRevision(0) }, [sessionId])
  useEffect(() => { if (preview) dialog.current?.showModal() }, [preview])
  const rewritten = useMemo(() => imageMarkdownParts(text, { sessionId, origin: window.location.origin, failed, revision }), [text, sessionId, failed, revision])
  return <div className="dk-session-markdown"
    onError={(e) => { if (e.target.tagName === 'IMG') setFailed((s) => new Set([...s, e.target.src])) }}
    onClickCapture={(e) => {
      const link = e.target.closest?.('a')
      const img = link?.querySelector('img')
      if (img) { e.preventDefault(); e.stopPropagation(); setPreview({ src: img.src, alt: img.alt }) }
    }}>
    <MarkdownText {...props} text={rewritten.text} />
    {/* Derived previews can change while the reply streams; keep them outside its append-only parser. */}
    {rewritten.previews && <MarkdownText {...props} text={rewritten.previews} streaming={false} fileMentions={undefined} />}
    {failed.size > 0 && <button type="button" className="dk-btn sm" onClick={() => { setFailed(new Set()); setRevision((n) => n + 1) }}>重试图片（请确认文件在当前工作目录内）</button>}
    {preview && <dialog ref={dialog} className="dk-image-preview" onClose={() => setPreview(null)} onClick={(e) => { if (e.target === e.currentTarget) dialog.current.close() }}>
      <button autoFocus type="button" className="dk-btn" onClick={() => dialog.current.close()}>关闭图片</button>
      <img src={preview.src} alt={preview.alt} />
    </dialog>}
  </div>
}
