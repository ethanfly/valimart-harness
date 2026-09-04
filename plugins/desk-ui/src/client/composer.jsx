/**
 * 输入框工具行的「文件」芯片：把本机文件放进会话工作目录（_attachments/），
 * 并像 @ 引用一样把文件塞进草稿（Agent 用文件工具直接读，不经过网关）。
 */
import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { toast } from './store.js'

const readAsBase64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(new Error(`读取 ${file.name} 失败`))
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
    r.readAsDataURL(file)
  })

const SINGLE_MAX = 32 * 1024 * 1024

/** 带上 @ 前缀的引用文本；含空格/引号的路径按官方 @ 选择器的写法加引号。 */
function mentionOf(rel) {
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(rel)) return null
  return /\s/u.test(rel) ? `@"${rel}"` : `@${rel}`
}

export function makeFileChip(ctx) {
  return function FileChip({ sessionId, useInput, inputActions, useSessions }) {
    const inputRef = useRef(null)
    const [busy, setBusy] = useState(false)
    const [count, setCount] = useState(0)
    const phase = useInput((s) => s?.phase)
    const draft = useInput((s) => s?.draft ?? '')
    const draftRef = useRef(draft)
    draftRef.current = draft
    const cwd = useSessions((s) => (sessionId === undefined ? undefined : s.byId[sessionId]?.cwd))
    const locked = phase === 'adjudicating' || phase === 'submitting'

    useEffect(() => {
      setCount(0)
    }, [sessionId])

    const insert = (files) => {
      const conversation = ctx.get('conversation')
      const shell = conversation?.input?.shell?.(sessionId)
      const refs = files.map((f) => ({ rel: f.rel, mention: mentionOf(f.rel), label: f.name })).filter((r) => r.mention)
      if (shell) {
        for (const r of refs) {
          const snap = shell.snapshot
          const draft = snap.draft
          const needGap = draft.length > 0 && !/\s$/.test(draft)
          const start = draft.length
          let ok = false
          try {
            if (needGap) shell.setDraft(`${draft} `)
            const at = shell.snapshot
            ok = shell.insertReference(
              { source: 'reference', ref: r.mention, label: r.label, appearance: 'file', clipboardText: r.mention },
              { start: needGap ? start + 1 : start, end: needGap ? start + 1 : start, draftRev: at.draftRev },
            )
          } catch {
            ok = false
          }
          if (!ok) shell.setDraft(`${shell.snapshot.draft}${/\s$/.test(shell.snapshot.draft) || !shell.snapshot.draft ? '' : ' '}${r.mention} `)
        }
        return
      }
      // 兜底：拿不到输入服务时直接改草稿文本
      const cur = draftRef.current
      inputActions?.setDraft?.(`${cur}${cur && !/\s$/.test(cur) ? ' ' : ''}${refs.map((r) => r.mention).join(' ')} `)
    }

    const onPick = async (ev) => {
      const list = [...(ev.target.files ?? [])]
      ev.target.value = ''
      if (!list.length || !sessionId) return
      const oversize = list.find((f) => f.size > SINGLE_MAX)
      if (oversize) return toast(`${oversize.name} 超过 32MB，请放到公司盘再引用`, 'error')
      setBusy(true)
      try {
        const payload = []
        for (const f of list) payload.push({ name: f.name, dataBase64: await readAsBase64(f) })
        const r = await api.attachFiles(sessionId, payload, cwd)
        insert(r.files)
        setCount((n) => n + r.files.length)
        toast(`已放入工作目录 _attachments/：${r.files.map((f) => f.name).join('、')}`)
      } catch (err) {
        toast(err.message ?? String(err), 'error')
      } finally {
        setBusy(false)
      }
    }

    return (
      <>
        <button
          type="button"
          className="dk-composer-chip"
          title={cwd ? `把本机文件放进 ${cwd}\\_attachments\\ 并在消息里引用` : '把本机文件放进会话工作目录并在消息里引用'}
          aria-label="文件"
          disabled={busy || locked || !sessionId}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => inputRef.current?.click()}
        >
          <span className="dk-composer-chip-icon" aria-hidden>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.5 4.5 5.8 9.2a1.6 1.6 0 0 0 2.3 2.3l5-5a3 3 0 0 0-4.3-4.3L3.6 7.4a4.4 4.4 0 0 0 6.2 6.2l3.4-3.4" />
            </svg>
          </span>
          <span className="dk-composer-chip-label">{busy ? '上传中…' : '文件'}</span>
          {count > 0 && !busy && <span className="dk-composer-chip-badge">{count}</span>}
        </button>
        <input ref={inputRef} type="file" multiple hidden onChange={onPick} />
      </>
    )
  }
}
