/**
 * 设置面板里的公司页：账号 / 同事 / 人员 / 快速推理 / 订阅。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, refreshDeskState, fmtCny, fmtDateTime, fmtTime, loadPeople } from './api.js'
import { clientVersionDetail, clientVersionLabel } from './version.js'
import { deskStore, useStoreValue, toast } from './store.js'

const ROLE = { admin: '管理员', director: '总监', employee: '员工' }

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

function Pct({ used, limit }) {
  if (!limit) return null
  const pct = Math.min(100, Math.round((used / limit) * 100))
  return (
    <div className={`dk-progress${pct >= 90 ? ' danger' : pct >= 70 ? ' warn' : ''}`} style={{ marginTop: 6 }}>
      <i style={{ width: `${pct}%` }} />
    </div>
  )
}

function quotaUseText(quota) {
  if (!quota) return '—'
  if (quota.kind === 'tokens') return `${quota.usedTokens ?? 0} / ${quota.limitTokens ?? quota.limit ?? 0} tokens`
  return `${fmtCny(quota.usedCny)} / ${fmtCny(quota.limitCny)}`
}

function quotaPctProps(quota) {
  if (quota?.kind === 'tokens') return { used: quota.usedTokens ?? 0, limit: quota.limitTokens ?? 0 }
  return { used: quota?.usedCny ?? 0, limit: quota?.limitCny ?? 0 }
}

/* ---------------- 账号 ---------------- */
export function AccountSection({ close }) {
  const desk = useStoreValue(deskStore, (s) => s.desk)
  const [pw, setPw] = useState({ current: '', next: '', again: '' })
  const [busy, setBusy] = useState(false)
  const [q] = useFetch(() => api.gw.get('/colleagues'), [desk?.user?.id])
  const quotas = q.data?.quota ?? []
  if (!desk?.loggedIn) return <div className="dk-settings"><Head title="账号" desc="尚未登录公司网关。" /></div>
  const u = desk.user
  const changePw = async () => {
    if (pw.next.length < 6) return toast('新密码至少 6 位', 'error')
    if (pw.next !== pw.again) return toast('两次输入的新密码不一致', 'error')
    setBusy(true)
    try {
      await api.gw.post('/auth/password', { oldPassword: pw.current, newPassword: pw.next })
      toast('密码已修改', 'success')
      setPw({ current: '', next: '', again: '' })
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const logout = async () => {
    if (!window.confirm('退出登录会清除本机的网关令牌，Agent 将无法继续调用模型。确定？')) return
    await api.logout().catch(() => {})
    await refreshDeskState()
    close?.()
  }
  const sync = async () => {
    setBusy(true)
    try {
      const r = await api.syncDrive()
      toast(`公司盘已同步：拉取 ${r.pulled ?? 0} 个文件，推送 ${r.pushed ?? 0} 个`, 'success')
      await refreshDeskState()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="dk-settings">
      <Head title="账号" desc={`${desk.company?.name ?? '公司'} · 公司账号登录。模型密钥保存在公司网关，本机只持有你个人的网关令牌。`} />
      <div className="dk-card">
        <div className="dk-kv">
          <div><div className="k">账号</div><div className="v dk-mono">{u.username}</div></div>
          <div><div className="k">姓名</div><div className="v">{u.displayName}</div></div>
          <div><div className="k">角色</div><div className="v">{ROLE[u.role] ?? u.role}</div></div>
          <div><div className="k">部门</div><div className="v">{u.department || '未分组'}</div></div>
          <div><div className="k">公司网关</div><div className="v dk-mono dk-small">{desk.gatewayUrl}</div></div>
          <div><div className="k">登录时间</div><div className="v">{fmtDateTime(desk.loginAt)}</div></div>
          <div><div className="k">网关令牌</div><div className="v">{desk.tokenHint ? <span className="dk-mono">{desk.tokenHint}</span> : '—'} <span className={`dk-badge ${desk.online ? 'online' : 'offline'}`}>{desk.online ? '有效' : '离线'}</span></div></div>
          <div><div className="k">模型路由</div><div className="v">{desk.modelCount ?? 0} 个模型经网关提供{desk.defaultModel ? ` · 默认 ${desk.defaultModel}` : ''}</div></div>
          <div>
            <div className="k">客户端版本</div>
            <div className="v">
              {clientVersionLabel(desk.client)}
              {desk.client?.buildId && desk.client.buildId !== clientVersionLabel(desk.client) ? (
                <span className="dk-muted dk-mono dk-xs" style={{ marginLeft: 8 }} title={desk.client.buildId}>
                  {clientVersionDetail(desk.client)}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      {quotas.length > 0 && (
        <div className="dk-card">
          <div className="dk-card-title">本周额度</div>
          {quotas.map((quota) => (
            <div key={quota.provider} style={{ marginBottom: 8 }}>
              <div className="dk-small">
                <b>{quota.label}</b> 本周已用 {quotaUseText(quota)}（{quota.usedPct}%），还剩 {quota.remainingPct}%；{fmtDateTime(quota.refreshAt)} 刷新
              </div>
              <Pct {...quotaPctProps(quota)} />
            </div>
          ))}
        </div>
      )}
      <div className="dk-card">
        <div className="dk-card-title">公司盘（本机镜像）</div>
        <div className="dk-small dk-mono dk-ellipsis" title={desk.driveDir}>{desk.driveDir}</div>
        <div className="dk-xs dk-muted" style={{ marginTop: 4 }}>
          共享经验 _shared/ · 个人记忆 _office/{u.username}/ · 任务格子 projects/inbox/。最近同步：{desk.lastSyncAt ? fmtTime(desk.lastSyncAt) : '—'}
        </div>
        <div className="dk-row" style={{ marginTop: 10 }}>
          <button className="dk-btn sm" disabled={busy} onClick={sync}>立即同步</button>
          <button className="dk-btn sm ghost" onClick={() => api.openPath(desk.driveDir).catch((e) => toast(e.message, 'error'))}>打开目录</button>
        </div>
      </div>
      <div className="dk-card">
        <div className="dk-card-title">修改密码</div>
        <div className="dk-form-grid">
          <div className="dk-field"><label>当前密码</label><input className="dk-input" type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></div>
          <div />
          <div className="dk-field"><label>新密码</label><input className="dk-input" type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></div>
          <div className="dk-field"><label>再输一次</label><input className="dk-input" type="password" value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} /></div>
        </div>
        <button className="dk-btn sm" disabled={busy || !pw.current || !pw.next} onClick={changePw}>修改密码</button>
      </div>
      <div className="dk-row">
        <button className="dk-btn danger" onClick={logout}>退出登录</button>
        <span className="dk-xs dk-muted">退出后需要重新用公司账号登录；管理员也可以在「人员」里吊销你的令牌。</span>
      </div>
    </div>
  )
}

/* ---------------- 同事 ---------------- */
export function ColleaguesSection() {
  const desk = useStoreValue(deskStore, (s) => s.desk)
  const [q, reload] = useFetch(() => api.gw.get('/colleagues'), [])
  useEffect(() => {
    const t = setInterval(reload, 30_000)
    return () => clearInterval(t)
  }, [])
  if (q.error) return <div className="dk-settings"><Head title="同事" /><div className="dk-alert error">{q.error}</div></div>
  if (!q.data) return <div className="dk-settings"><Head title="同事" /><div className="dk-empty">加载中…</div></div>
  const { quota: quotas, ledger7d, users, me, channels = [], canEditChannels, quickInferenceModel } = q.data
  // 服务端返回数组 [{ model, provider, requests, promptTokens, completionTokens, cachedTokens, costCny }]
  const byModel = (Array.isArray(ledger7d.byModel) ? ledger7d.byModel : Object.values(ledger7d.byModel ?? {})).slice().sort((a, b) => b.costCny - a.costCny)
  const primary = quotas[0]
  return (
    <div className="dk-settings">
      <Head title="同事" right={<button className="dk-btn sm" onClick={reload}>刷新</button>} />
      <div className="lead">
        {quotas.map((quota) => (
          <div key={quota.provider}>
            <b>{quota.label}</b> 本周已用 <b>{quota.usedPct}%</b>，还剩 <b>{quota.remainingPct}%</b>（{quotaUseText(quota)}），{fmtDateTime(quota.refreshAt)} 刷新。
          </div>
        ))}
        <div>
          办公机 <b>{desk?.device ?? '本机'}</b> {desk?.online ? '在线' : '离线'}。快速推理用 <b>{quickInferenceModel ?? '—'}</b>，开关在「快速推理」。
        </div>
        <div>
          近 7 天公司成本 <b>{fmtCny(ledger7d.totalCny)}</b>（{ledger7d.requests} 次请求，本地价目表估值，不是 {primary?.label ?? '供应商'} 账单）。
        </div>
      </div>
      {primary && <Pct {...quotaPctProps(primary)} />}
      <ChannelTable channels={channels} canEdit={!!canEditChannels} onChanged={reload} />
      <div className="dk-card dk-table-wrap">
        <table className="dk-table">
          <thead>
            <tr>
              <th>账号</th>
              <th>姓名</th>
              <th>角色</th>
              <th>部门</th>
              <th>在线</th>
              <th>最近登录</th>
              <th className="num">本周额度</th>
              <th className="num">7 日花费</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={u.id === me.id ? { background: 'var(--dk-bg-1)' } : undefined}>
                <td className="dk-mono nowrap">{u.username}</td>
                <td className="nowrap">{u.displayName}{u.id === me.id ? <span className="dk-muted dk-xs">（我）</span> : ''}</td>
                <td className="nowrap">{ROLE[u.role] ?? u.role}</td>
                <td className="nowrap">{u.department || '—'}</td>
                <td><span className={`dk-badge ${u.disabled ? 'disabled' : u.online ? 'online' : 'offline'}`}>{u.disabled ? '已停用' : u.online ? '在线' : '离线'}</span></td>
                <td className="dk-small dk-dim nowrap">{u.lastLoginAt ? fmtTime(u.lastLoginAt) : '从未'}</td>
                <td className="num">{u.quota?.kind === 'tokens' ? `${u.quota.limit} tokens` : fmtCny(u.weeklyQuotaCny)}</td>
                <td className="num">{fmtCny(u.spend7dCny)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="dk-card">
        <div className="dk-card-title">按模型（近 7 天）</div>
        {byModel.length === 0 ? (
          <div className="dk-small dk-muted">近 7 天还没有模型调用。</div>
        ) : (
          <table className="dk-table">
            <thead>
              <tr>
                <th>模型</th>
                <th className="num">请求</th>
                <th className="num">输入 tokens</th>
                <th className="num">输出 tokens</th>
                <th className="num">成本</th>
              </tr>
            </thead>
            <tbody>
              {byModel.map((m) => (
                <tr key={`${m.provider}/${m.model}`}>
                  <td className="dk-mono dk-small">
                    {m.model}
                    {m.provider ? <span className="dk-muted"> · {m.provider}</span> : null}
                  </td>
                  <td className="num">{m.requests}</td>
                  <td className="num">{(m.promptTokens ?? 0).toLocaleString()}</td>
                  <td className="num">{(m.completionTokens ?? 0).toLocaleString()}</td>
                  <td className="num">{fmtCny(m.costCny)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/* ---------------- 通道（订阅 / key）---------------- */
function ChannelTable({ channels, canEdit, onChanged }) {
  const [dialog, setDialog] = useState(null) // { channel } | { kind: 'subscription' | 'key' }
  const [busy, setBusy] = useState(null)
  const disconnect = async (c) => {
    if (!window.confirm(`断开通道「${c.label}」？其模型会从公司目录里消失。`)) return
    setBusy(c.id)
    try {
      await api.gw.post(`/channels/${c.id}/disconnect`, {})
      toast(`已断开 ${c.label}`, 'success')
      await api.gw.get('/auth/me') // 让本机 host 刷新模型路由
      onChanged?.()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="dk-card">
      <div className="dk-card-title" style={{ flexWrap: 'wrap' }}>
        <span>
          通道 <span className="dk-muted dk-small">订阅账号或 API key 都能接进来；密钥只留在公司网关，不下发到任何人的电脑。</span>
        </span>
        {canEdit && (
          <div className="dk-row" style={{ gap: 6 }}>
            <button className="dk-btn sm" onClick={() => setDialog({ kind: 'subscription' })}>
              加入订阅
            </button>
            <button className="dk-btn sm" onClick={() => setDialog({ kind: 'key' })}>
              加入模型
            </button>
            <button className="dk-btn sm" onClick={() => setDialog({ kind: 'custom' })}>
              自定义端点
            </button>
          </div>
        )}
      </div>
      <div className="dk-table-wrap">
      <table className="dk-table dk-channels">
        <thead>
          <tr>
            <th>通道</th>
            <th>种类</th>
            <th>状态</th>
            <th>模型</th>
            {canEdit && <th className="num">操作</th>}
          </tr>
        </thead>
        <tbody>
          {channels.map((c) => (
            <tr key={c.id}>
              <td title={c.label}>{c.label}</td>
              <td className="dk-mono dk-small">{c.kindLabel}</td>
              <td>
                <span className={`dk-badge ${c.connected ? 'online' : 'offline'}`}>{c.statusLabel}</span>
              </td>
              <td>
                {c.connected && c.models.length ? (
                  <>
                    <div className="dk-ch-models" title={c.models.join(', ')}>
                      {c.models.map((id) => (
                        <span key={id} className="dk-chip">{id}</span>
                      ))}
                    </div>
                    {c.accountCount > 1 ? <div className="dk-xs dk-muted">{c.accountCount} 个账号轮换</div> : null}
                  </>
                ) : (
                  <span className="dk-muted">{c.hint || '—'}</span>
                )}
              </td>
              {canEdit && (
                <td className="num">
                  {c.connected && c.source === 'runtime' ? (
                    <div className="dk-ch-actions">
                      <button className="dk-btn sm" onClick={() => setDialog({ channel: c, edit: true })}>
                        编辑
                      </button>
                      <button className="dk-btn sm" onClick={() => setDialog({ channel: c, addAccount: true })}>
                        再登录
                      </button>
                      <button className="dk-btn sm ghost" disabled={busy === c.id} onClick={() => disconnect(c)}>
                        断开
                      </button>
                    </div>
                  ) : c.connected ? (
                    <span className="dk-xs dk-muted">配置文件接入</span>
                  ) : (
                    <button className="dk-btn sm" onClick={() => setDialog({ channel: c })}>
                      接入
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {dialog?.kind === 'custom' && <CustomEndpointDialog onClose={() => setDialog(null)} onDone={onChanged} />}
      {dialog && dialog.kind !== 'custom' && <ConnectChannelDialog channels={channels} initial={dialog} onClose={() => setDialog(null)} onDone={onChanged} />}
    </div>
  )
}

function ctxText(v) {
  return v != null && v !== '' ? String(v) : ''
}

function sharedModelField(details, key) {
  const vals = [...new Set((details || []).map((d) => {
    const v = d?.[key]
    if (v == null || v === '' || v === false) return ''
    return Array.isArray(v) ? v.join(',') : String(v)
  }).filter(Boolean))]
  return vals.length === 1 ? vals[0] : ''
}

function modelEntriesFrom(list, prev = []) {
  const prevById = new Map(prev.map((m) => [m.id, m]))
  return (list || []).map((m) => {
    const id = typeof m === 'string' ? m : m?.id
    if (!id) return null
    const fromList = typeof m === 'object' && m ? ctxText(m.contextWindow) : ''
    return { id, contextWindow: fromList || prevById.get(id)?.contextWindow || '' }
  }).filter(Boolean)
}

function parseModelEntries(raw, prev = []) {
  return modelEntriesFrom(String(raw || '').split(/[,\n，]/).map((s) => s.trim()).filter(Boolean), prev)
}

function modelsPayload(entries) {
  return entries.map((m) => {
    const n = Number(m.contextWindow)
    return Number.isFinite(n) && n > 0 ? { id: m.id, contextWindow: n } : { id: m.id }
  })
}

function entriesFromChannel(ch) {
  if (!ch) return []
  if (ch.modelDetails?.length) {
    const shared = sharedModelField(ch.modelDetails, 'contextWindow')
    return ch.modelDetails.map((m) => ({ id: m.id, contextWindow: shared ? '' : ctxText(m.contextWindow) }))
  }
  return (ch.models || []).map((id) => ({ id, contextWindow: '' }))
}

function ModelPickList({ models, onRemove, onContext }) {
  if (!models.length) return <span className="hint">至少留一个模型</span>
  return (
    <div className="dk-model-pick">
      {models.map((m) => (
        <span key={m.id} className="dk-model-tag">
          <span className="dk-mono">{m.id}</span>
          <input
            className="dk-input sm"
            value={m.contextWindow}
            onChange={(e) => onContext(m.id, e.target.value)}
            placeholder="上下文"
            title="该模型的上下文长度"
          />
          <button type="button" className="dk-model-tag-x" onClick={() => onRemove(m.id)} title="去掉">×</button>
        </span>
      ))}
    </div>
  )
}

function ConnectChannelDialog({ channels, initial, onClose, onDone }) {
  const isEdit = !!initial.edit
  const candidates = channels.filter((c) => (initial.channel ? c.id === initial.channel.id : c.kind === initial.kind && (initial.addAccount || !c.connected)))
  const [channelId, setChannelId] = useState(initial.channel?.id ?? candidates[0]?.id ?? '')
  const channel = channels.find((c) => c.id === channelId)
  const [label, setLabel] = useState(channel?.label ?? '')
  const [credential, setCredential] = useState('')
  const [baseUrl, setBaseUrl] = useState(channel?.baseUrl ?? '')
  const [models, setModels] = useState(isEdit && channel?.models?.length ? channel.models.join(', ') : (channel?.hint ?? ''))
  const [contextWindow, setContextWindow] = useState(
    (isEdit && sharedModelField(channel?.modelDetails, 'contextWindow')) || (channel?.contextWindow ? String(channel.contextWindow) : ''),
  )
  const [maxTokens, setMaxTokens] = useState(
    (isEdit && sharedModelField(channel?.modelDetails, 'maxTokens')) || (channel?.maxTokens ? String(channel.maxTokens) : ''),
  )
  const [reasoning, setReasoning] = useState(
    (isEdit && sharedModelField(channel?.modelDetails, 'reasoningEfforts')) || (Array.isArray(channel?.reasoningEfforts) ? channel.reasoningEfforts.join(',') : ''),
  )
  const [busy, setBusy] = useState(false)
  const [oauthNote, setOauthNote] = useState('')
  const [showPaste, setShowPaste] = useState(false)
  const [oauthState, setOauthState] = useState('')
  const [deviceCode, setDeviceCode] = useState('')
  const [pasteCode, setPasteCode] = useState('')
  const [needPasteCode, setNeedPasteCode] = useState(false)
  const [oauthOpenUrl, setOauthOpenUrl] = useState('')
  const [pickModels, setPickModels] = useState(isEdit ? entriesFromChannel(channel) : [])
  const [catalogReady, setCatalogReady] = useState(!!(isEdit && channel?.models?.length))
  const pollRef = useRef(null)
  useEffect(() => {
    setLabel(channel?.label ?? '')
    setBaseUrl(channel?.baseUrl ?? '')
    if (isEdit && channel) {
      const entries = entriesFromChannel(channel)
      setModels(entries.map((m) => m.id).join(', '))
      setPickModels(entries)
      setCatalogReady(entries.length > 0)
      setContextWindow(sharedModelField(channel.modelDetails, 'contextWindow') || (channel.contextWindow ? String(channel.contextWindow) : ''))
      setMaxTokens(sharedModelField(channel.modelDetails, 'maxTokens') || (channel.maxTokens ? String(channel.maxTokens) : ''))
      setReasoning(sharedModelField(channel.modelDetails, 'reasoningEfforts') || (Array.isArray(channel.reasoningEfforts) ? channel.reasoningEfforts.join(',') : ''))
    } else {
      setModels(channel?.hint ?? '')
      setPickModels([])
      setCatalogReady(false)
      setContextWindow(channel?.contextWindow ? String(channel.contextWindow) : '')
      setMaxTokens(channel?.maxTokens ? String(channel.maxTokens) : '')
      setReasoning(Array.isArray(channel?.reasoningEfforts) ? channel.reasoningEfforts.join(',') : '')
    }
    setOauthNote('')
    setOauthState('')
    setDeviceCode('')
    setPasteCode('')
    setNeedPasteCode(false)
    setOauthOpenUrl('')
  }, [channelId])
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])
  const isSub = channel?.kind === 'subscription'
  const oauth = channel?.oauth
  const canOAuth = !!(isSub && oauth?.available && oauth?.configured)
  useEffect(() => {
    setShowPaste(!(isSub && oauth?.available && oauth?.configured))
  }, [channelId, isSub, oauth?.available, oauth?.configured])
  const applyCatalog = (list) => {
    let next = []
    setPickModels((cur) => {
      next = modelEntriesFrom(list, cur)
      return next
    })
    setCatalogReady(next.length > 0)
    setModels(next.map((m) => m.id).join(', '))
    return next.map((m) => m.id)
  }
  const afterConnect = async (label, modelList) => {
    toast(`已接入 ${label}：${(modelList || []).join(', ')}`, 'success')
    await api.gw.get('/auth/me')
    await refreshDeskState()
    onDone?.()
    onClose()
  }
  const extras = () => ({
    contextWindow: contextWindow ? Number(contextWindow) : undefined,
    maxTokens: maxTokens ? Number(maxTokens) : undefined,
    reasoningEfforts: reasoning.trim() ? reasoning.split(/[,\s/]+/).filter(Boolean) : undefined,
  })
  const submit = async () => {
    if (!channel) return
    setBusy(true)
    try {
      const entries = pickModels.length ? pickModels : parseModelEntries(models)
      const r = await api.gw.post(`/channels/${channel.id}/connect`, { credential, baseUrl, models: modelsPayload(entries), ...extras() })
      await afterConnect(r.channel.label, r.channel.models)
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const saveEdit = async () => {
    if (!channel) return
    const entries = pickModels.length ? pickModels : parseModelEntries(models)
    if (!entries.length) {
      toast('请至少填写或留下一个模型 id', 'error')
      return
    }
    setBusy(true)
    try {
      const r = await api.gw.patch(`/channels/${channel.id}`, {
        models: modelsPayload(entries),
        baseUrl: baseUrl || undefined,
        label: channel.custom ? label : undefined,
        ...extras(),
      })
      toast(`已更新 ${r.channel.label}：${(r.channel.models || []).join(', ')}`, 'success')
      await api.gw.get('/auth/me')
      await refreshDeskState()
      onDone?.()
      onClose()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const discover = async () => {
    if (!channel) return
    setBusy(true)
    try {
      const r = await api.gw.post(`/channels/${channel.id}/discover-models`, { credential, baseUrl, state: oauthState || undefined })
      applyCatalog(r.models || [])
      const first = r.models?.[0]
      if (first?.contextWindow && !contextWindow) setContextWindow(String(first.contextWindow))
      if (first?.maxTokens && !maxTokens) setMaxTokens(String(first.maxTokens))
      if (first?.reasoningEfforts && !reasoning) setReasoning(Array.isArray(first.reasoningEfforts) ? first.reasoningEfforts.join(',') : '')
      toast(r.source === 'upstream' ? `已拉取 ${r.models.length} 个模型` : `已用内置目录（${r.reason || '上游未返回'}）`, 'success')
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const watchStatus = (channelId, state) => {
    if (pollRef.current) clearInterval(pollRef.current)
    const t0 = Date.now()
    pollRef.current = setInterval(async () => {
      if (Date.now() - t0 > 10 * 60 * 1000) {
        clearInterval(pollRef.current)
        setOauthNote('授权超时，请重试')
        setBusy(false)
        return
      }
      try {
        const st = await api.gw.get(`/channels/${channelId}/oauth/status?state=${encodeURIComponent(state)}`)
        if (st.status === 'authorized') {
          clearInterval(pollRef.current)
          const ids = applyCatalog(st.models || [])
          setOauthNote(`已登录，已拉取 ${ids.length} 个模型。点 × 去掉不需要的，再点接入。`)
          setBusy(false)
          return
        }
        if (st.status === 'success') {
          clearInterval(pollRef.current)
          await afterConnect(st.channel.label, st.channel.models)
          return
        }
        if (st.status === 'error') {
          clearInterval(pollRef.current)
          setOauthNote(st.error || '授权失败')
          setBusy(false)
        }
      } catch {
        /* 进行中 */
      }
    }, 1200)
  }
  const openAuthorizePage = (url, popup) => {
    if (!url) return
    try {
      if (popup && !popup.closed) {
        popup.location.replace(url)
        return
      }
    } catch {
      /* 已关 */
    }
    if (window.deskShell?.openExternal) {
      window.deskShell.openExternal(url)
      return
    }
    window.open(url, 'desk-oauth-subscribe', 'width=520,height=740')
  }
  const startOAuth = async () => {
    if (!channel) return
    const popup = window.deskShell?.openExternal ? null : window.open('about:blank', 'desk-oauth-subscribe', 'width=520,height=740')
    setBusy(true)
    setOauthNote('正在发起授权…')
    setOauthOpenUrl('')
    try {
      const r = await api.gw.post(`/channels/${channel.id}/oauth/start`, { models, baseUrl: baseUrl || undefined, ...extras() })
      setOauthState(r.state || '')
      if (r.flow === 'device_code') {
        setDeviceCode(r.userCode || '')
        const openUrl = r.verificationUriComplete || r.verificationUri
        openAuthorizePage(openUrl, popup)
        setOauthOpenUrl(openUrl || '')
        setOauthNote(`在打开的页面输入代码 ${r.userCode || ''}，登录订阅账号。`)
        watchStatus(channel.id, r.state)
        return
      }
      openAuthorizePage(r.authorizeUrl, popup)
      setOauthOpenUrl(r.authorizeUrl || '')
      if (r.flow === 'authorization_code_paste') {
        setNeedPasteCode(true)
        setOauthNote(channel.oauth?.pasteHint || '浏览器登录后，把回调页上的授权码（或整段网址）贴到下面。')
        setBusy(false)
        return
      }
      setOauthNote('已打开授权页，等待回调…')
      watchStatus(channel.id, r.state)
    } catch (err) {
      try { if (popup && !popup.closed) popup.close() } catch { /* 已关 */ }
      setOauthNote(err.message)
      setBusy(false)
    }
  }
  const completeOAuth = async () => {
    if (!channel || !oauthState) return
    setBusy(true)
    try {
      const st = await api.gw.post(`/channels/${channel.id}/oauth/complete`, { state: oauthState, code: pasteCode })
      if (st.status === 'authorized') {
        const ids = applyCatalog(st.models || [])
        setOauthNote(`已登录，已拉取 ${ids.length} 个模型。点 × 去掉不需要的，再点接入。`)
        setBusy(false)
      } else if (st.status === 'success') await afterConnect(st.channel.label, st.channel.models)
      else {
        setOauthNote(st.error || '授权失败')
        setBusy(false)
      }
    } catch (err) {
      setOauthNote(err.message)
      setBusy(false)
    }
  }
  const commitOAuth = async () => {
    if (!channel || !oauthState) return
    const entries = pickModels.length ? pickModels : parseModelEntries(models)
    if (!entries.length) {
      toast('请至少填写或留下一个模型 id', 'error')
      return
    }
    setBusy(true)
    try {
      const st = await api.gw.post(`/channels/${channel.id}/oauth/commit`, { state: oauthState, models: modelsPayload(entries), ...extras() })
      if (st.status === 'success') await afterConnect(st.channel.label, st.channel.models)
      else {
        setOauthNote(st.error || '接入失败')
        setBusy(false)
      }
    } catch (err) {
      setOauthNote(err.message)
      setBusy(false)
    }
  }
  const subHint = !isSub
    ? '用 API key 接入一个模型供应商：key 只存在网关服务器上。'
    : canOAuth
      ? '用官方 OAuth 登录订阅账号；登录后会自动拉取模型列表，你可以去掉不需要的再接入。令牌只保存在服务端。'
      : oauth?.available
        ? `该通道支持官方 OAuth，但网关还没配置应用。${oauth.reason || ''}`
        : (oauth?.reason || '该平台无官方 OAuth，仍需粘贴令牌')
  return (
    <div className="dk-overlay" onClick={onClose}>
      <div className={`dk-dialog${pickModels.length ? ' wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <h2>{isEdit ? `编辑 ${channel?.label ?? ''}` : initial.addAccount ? `再登录 ${channel?.label ?? ''}` : isSub ? '加入订阅' : '加入模型'}</h2>
        <div className="sub">{isEdit ? '改模型列表和上下文，不必重新登录。凭据保持不变。' : initial.addAccount ? '同一订阅再挂一个账号；额度用完后自动切到下一个。' : subHint}</div>
        {oauth?.detail && <div className="sub">{oauth.detail}</div>}
        {isEdit && channel?.custom ? (
          <div className="dk-field">
            <label>名称</label>
            <input className="dk-input" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
        ) : (
          <div className="dk-field">
            <label>通道</label>
            <select className="dk-select" value={channelId} onChange={(e) => setChannelId(e.target.value)} disabled={!!initial.channel}>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}（{c.kindLabel}）
                </option>
              ))}
            </select>
          </div>
        )}
        {!isEdit && isSub && canOAuth && (
          <div className="dk-field">
            <button className="dk-btn primary block" type="button" disabled={busy} onClick={startOAuth}>
              {busy ? '请稍候…' : '登录账号'}
            </button>
            {deviceCode && <div className="dk-mono" style={{ fontSize: 22, letterSpacing: 2, marginTop: 8 }}>{deviceCode}</div>}
            {needPasteCode && (
              <>
                <input className="dk-input" value={pasteCode} onChange={(e) => setPasteCode(e.target.value)} placeholder="授权码或回调网址" style={{ marginTop: 8 }} />
                <button className="dk-btn" type="button" disabled={busy || !pasteCode.trim()} onClick={completeOAuth} style={{ marginTop: 8 }}>提交授权码</button>
              </>
            )}
            {oauthNote && <span className="hint">{oauthNote}</span>}
            {oauthOpenUrl && (
              <a className="hint" href={oauthOpenUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'block', marginTop: 6 }}>
                如果浏览器拦截了弹窗，点这里打开授权页
              </a>
            )}
            {oauth?.flow === 'authorization_code' && oauth?.callbackUrl && <span className="hint">开发者后台登记 callback：{oauth.callbackUrl}</span>}
          </div>
        )}
        {!isEdit && isSub && oauth?.available && !oauth?.configured && oauth?.callbackUrl && (
          <p className="dk-xs dk-muted" style={{ margin: '0 0 10px' }}>开发者后台登记 callback：{oauth.callbackUrl}</p>
        )}
        {!isEdit && isSub && canOAuth && (
          <button className="dk-btn sm ghost" type="button" onClick={() => setShowPaste((v) => !v)} style={{ marginBottom: 8 }}>
            {showPaste ? '收起手动粘贴' : '高级：手动粘贴'}
          </button>
        )}
        {!isEdit && (!isSub || showPaste || !canOAuth) && (
          <div className="dk-field">
            <label>{isSub ? '订阅凭据（订阅账号的访问令牌）' : 'API key'}</label>
            <input className="dk-input" type="password" autoFocus={!canOAuth} value={credential} onChange={(e) => setCredential(e.target.value)} placeholder={isSub ? '粘贴订阅账号的 access token' : 'sk-…'} />
          </div>
        )}
        <div className="dk-field">
          <label>接口地址（OpenAI 兼容）</label>
          <input className="dk-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </div>
        <div className="dk-field">
          <label>模型 id（逗号分隔，可留空自动拉取）</label>
          <div className="dk-row" style={{ gap: 8 }}>
            <input
              className="dk-input"
              value={models}
              onChange={(e) => {
                const value = e.target.value
                setModels(value)
                setPickModels((cur) => parseModelEntries(value, cur))
              }}
              placeholder={channel?.hint || '留空则自动发现'}
              style={{ flex: 1 }}
            />
            <button className="dk-btn" type="button" disabled={busy || !channel} onClick={discover}>拉取列表</button>
          </div>
        </div>
        {pickModels.length > 0 && (
          <div className="dk-field">
            <label>已填入 {pickModels.length} 个模型（每行可改上下文，点 × 去掉）</label>
            <ModelPickList
              models={pickModels}
              onRemove={(id) => setPickModels((cur) => {
                const next = cur.filter((x) => x.id !== id)
                setModels(next.map((m) => m.id).join(', '))
                return next
              })}
              onContext={(id, value) => setPickModels((cur) => cur.map((x) => (x.id === id ? { ...x, contextWindow: value } : x)))}
            />
          </div>
        )}
        <div className="dk-form-grid">
          <div className="dk-field">
            <label>默认上下文（未单独填的模型）</label>
            <input className="dk-input" value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} placeholder="自动 / 例如 200000" />
          </div>
          <div className="dk-field">
            <label>最长输出</label>
            <input className="dk-input" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="自动 / 例如 32000" />
          </div>
          <div className="dk-field">
            <label>思考强度</label>
            <input className="dk-input" value={reasoning} onChange={(e) => setReasoning(e.target.value)} placeholder="例如 low,medium,high" />
          </div>
        </div>
        <div className="dk-row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button className="dk-btn" onClick={onClose}>
            取消
          </button>
          {isEdit ? (
            <button className="dk-btn primary" disabled={busy || !channel} onClick={saveEdit}>
              保存
            </button>
          ) : catalogReady && canOAuth && oauthState ? (
            <button className="dk-btn primary" disabled={busy || !pickModels.length || !channel} onClick={commitOAuth}>
              接入这些模型
            </button>
          ) : (!isSub || showPaste || !canOAuth) ? (
            <button className="dk-btn primary" disabled={busy || !credential.trim() || !channel} onClick={submit}>
              {initial.addAccount ? '添加账号' : isSub ? '接入订阅' : '接入模型'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function CustomEndpointDialog({ onClose, onDone }) {
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://')
  const [credential, setCredential] = useState('')
  const [models, setModels] = useState('')
  const [contextWindow, setContextWindow] = useState('')
  const [maxTokens, setMaxTokens] = useState('')
  const [reasoning, setReasoning] = useState('low,medium,high')
  const [busy, setBusy] = useState(false)
  const extras = () => ({
    contextWindow: contextWindow ? Number(contextWindow) : undefined,
    maxTokens: maxTokens ? Number(maxTokens) : undefined,
    reasoningEfforts: reasoning.trim() ? reasoning.split(/[,\s/]+/).filter(Boolean) : undefined,
  })
  const save = async () => {
    setBusy(true)
    try {
      const r = await api.gw.post('/channels', { label, baseUrl, credential, models, hint: models, ...extras() })
      toast(`已添加 ${r.channel.label}${r.channel.models?.length ? `：${r.channel.models.join(', ')}` : ''}`, 'success')
      await api.gw.get('/auth/me')
      await refreshDeskState()
      onDone?.()
      onClose()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="dk-overlay" onClick={onClose}>
      <div className="dk-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>自定义模型端点</h2>
        <div className="sub">任意 OpenAI 兼容 / Anthropic 端点。可先填 key 再拉模型列表。</div>
        <div className="dk-field"><label>名称</label><input className="dk-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如 自建网关" /></div>
        <div className="dk-field"><label>接口地址</label><input className="dk-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></div>
        <div className="dk-field"><label>API key</label><input className="dk-input" type="password" value={credential} onChange={(e) => setCredential(e.target.value)} /></div>
        <div className="dk-field"><label>模型 id（可留空自动拉取）</label><input className="dk-input" value={models} onChange={(e) => setModels(e.target.value)} placeholder="gpt-4o, …" /></div>
        <div className="dk-form-grid">
          <div className="dk-field"><label>默认上下文（未单独填的模型）</label><input className="dk-input" value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} /></div>
          <div className="dk-field"><label>最长输出</label><input className="dk-input" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} /></div>
          <div className="dk-field"><label>思考强度</label><input className="dk-input" value={reasoning} onChange={(e) => setReasoning(e.target.value)} /></div>
        </div>
        <div className="dk-row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button className="dk-btn" onClick={onClose}>取消</button>
          <button className="dk-btn primary" disabled={busy || !label.trim() || !baseUrl.trim()} onClick={save}>保存</button>
        </div>
      </div>
    </div>
  )
}

/* ---------------- 技能 / 知识 / 插件 ---------------- */
export function KnowledgeSection() {
  const desk = useStoreValue(deskStore, (s) => s.desk)
  const [q, reload] = useFetch(
    () =>
      Promise.all([api.gw.get('/knowledge/collections'), api.plugins().catch(() => ({ entries: [] })), api.gw.get('/plugins').catch(() => ({ entries: [] }))]).then(([col, live, catalog]) => ({
        ...col,
        livePlugins: live.entries ?? [],
        catalogPlugins: catalog.entries ?? [],
      })),
    [desk?.user?.id],
  )
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [scope, setScope] = useState('shared')
  const [layer, setLayer] = useState('02-methods')
  const [busy, setBusy] = useState(false)
  const add = async () => {
    setBusy(true)
    try {
      await api.gw.post('/knowledge/entries', { title, content, scope, layer })
      toast('已写入知识库', 'success')
      setTitle('')
      setContent('')
      reload()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  if (q.error) return <div className="dk-settings"><Head title="技能与知识" /><div className="dk-alert error">{q.error}</div></div>
  if (!q.data) return <div className="dk-settings"><Head title="技能与知识" /><div className="dk-empty">加载中…</div></div>
  const { handbook = [], skills = [], shared = {}, personal = [], livePlugins = [], catalogPlugins = [], memoryLayers = [] } = q.data
  const plugins = livePlugins.length ? livePlugins : catalogPlugins
  return (
    <div className="dk-settings">
      <Head title="技能与知识" desc="查看当前技能、知识库，并手动补充。插件列表兼容 DeepSeek Harness 的 plugin inventory。" right={<button className="dk-btn sm" onClick={reload}>刷新</button>} />
      <div className="dk-card">
        <div className="dk-card-title">当前技能 _shared/skills</div>
        {skills.length === 0 ? <div className="dk-small dk-muted">还没有技能文件。</div> : (
          <ul className="dk-small" style={{ margin: 0, paddingLeft: 18 }}>
            {skills.map((f) => <li key={f.path}><span className="dk-mono">{f.path}</span></li>)}
          </ul>
        )}
      </div>
      <div className="dk-card">
        <div className="dk-card-title">知识库</div>
        <div className="dk-small dk-muted" style={{ marginBottom: 8 }}>手册 {handbook.length} · 共享 {Object.values(shared).reduce((n, l) => n + (l.files?.length ?? 0), 0)} · 个人 {personal.length}</div>
        {handbook.slice(0, 8).map((f) => <div key={f.path} className="dk-small dk-mono">{f.path}</div>)}
        {Object.entries(shared).map(([dir, layerInfo]) => (
          <div key={dir} className="dk-small" style={{ marginTop: 6 }}><b>{layerInfo.label}</b> <span className="dk-muted">{layerInfo.files?.length ?? 0} 个文件</span></div>
        ))}
      </div>
      <div className="dk-card">
        <div className="dk-card-title">手动增加知识</div>
        <div className="dk-form-grid">
          <div className="dk-field"><label>标题</label><input className="dk-input" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="dk-field">
            <label>位置</label>
            <select className="dk-select" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="shared">共享经验</option>
              <option value="personal">个人记忆</option>
              <option value="handbook">岗位手册</option>
              <option value="skill">技能</option>
            </select>
          </div>
          {(scope === 'shared' || scope === 'personal') && (
            <div className="dk-field">
              <label>分层</label>
              <select className="dk-select" value={layer} onChange={(e) => setLayer(e.target.value)}>
                {(memoryLayers.length ? memoryLayers : [{ dir: '02-methods', label: '方法' }]).map((l) => <option key={l.dir} value={l.dir}>{l.label}</option>)}
              </select>
            </div>
          )}
        </div>
        <div className="dk-field" style={{ marginTop: 8 }}>
          <label>内容</label>
          <textarea className="dk-textarea" rows={6} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Markdown" />
        </div>
        <button className="dk-btn sm primary" disabled={busy || !title.trim() || !content.trim()} onClick={add} style={{ marginTop: 8 }}>写入</button>
      </div>
      <div className="dk-card">
        <div className="dk-card-title">DeepSeek Harness 插件</div>
        {plugins.length === 0 ? <div className="dk-small dk-muted">当前没有插件快照。官方插件列表页已启用。</div> : (
          <table className="dk-table">
            <thead><tr><th>id</th><th>模块</th><th>状态</th></tr></thead>
            <tbody>
              {plugins.map((p) => (
                <tr key={p.entryId}>
                  <td className="dk-mono dk-small">{p.entryId}</td>
                  <td className="dk-small">{p.moduleName}</td>
                  <td><span className={`dk-badge ${p.enabled ? 'online' : 'offline'}`}>{p.enabled ? (p.fiberPhase || '启用') : '关闭'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/* ---------------- 人员 ---------------- */
export function PersonnelSection() {
  const desk = useStoreValue(deskStore, (s) => s.desk)
  const [q, reload] = useFetch(() => api.gw.get('/personnel'), [])
  const [form, setForm] = useState({ username: '', password: '', displayName: '', role: 'employee', department: '' })
  const [busy, setBusy] = useState(false)
  const [data, setData] = useState(null)
  useEffect(() => {
    if (q.data) setData(q.data)
  }, [q.data])
  if (q.error) return <div className="dk-settings"><Head title="人员" /><div className="dk-alert warn">{q.error}</div></div>
  if (!data) return <div className="dk-settings"><Head title="人员" /><div className="dk-empty">加载中…</div></div>
  const canEdit = data.canEdit
  const apply = (r) => {
    if (r?.departments) setData((d) => ({ ...d, departments: r.departments }))
  }
  const patch = async (u, body, ok) => {
    setBusy(true)
    try {
      const r = await api.gw.patch(`/personnel/users/${u.id}`, body)
      apply(r)
      if (ok) toast(ok, 'success')
      if (u.id === desk?.user?.id) refreshDeskState()
      loadPeople()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const revoke = async (u) => {
    if (!window.confirm(`吊销 ${u.displayName}（${u.username}）的网关令牌？其客户端会立刻无法调用模型，需重新登录。`)) return
    setBusy(true)
    try {
      const r = await api.gw.post(`/personnel/users/${u.id}/revoke-token`, {})
      apply(r)
      toast(`已吊销 ${r.revoked} 枚令牌，即时生效`, 'success')
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const resetPw = async (u) => {
    const p = window.prompt(`给 ${u.displayName} 设置新密码（至少 6 位）`)
    if (!p) return
    try {
      await api.gw.post(`/personnel/users/${u.id}/reset-password`, { password: p })
      toast('密码已重置', 'success')
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  const create = async () => {
    if (!form.username.trim() || form.password.length < 6) return toast('账号必填，密码至少 6 位', 'error')
    setBusy(true)
    try {
      const r = await api.gw.post('/personnel/users', { ...form, username: form.username.trim(), displayName: form.displayName.trim() || form.username.trim() })
      apply(r)
      toast(`已发账号 ${r.user.username}`, 'success')
      setForm({ username: '', password: '', displayName: '', role: 'employee', department: form.department })
      loadPeople()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const total = data.departments.reduce((n, d) => n + d.users.length, 0)
  return (
    <div className="dk-settings">
      <Head title="人员" desc={`${total} 人，按部门分组。${canEdit ? '管理员可修改角色/部门、停用账号、吊销令牌、发账号。' : '总监只读；修改请联系管理员。'}`} right={<button className="dk-btn sm" onClick={reload}>刷新</button>} />
      {data.departments.map((dep) => (
        <div key={dep.name} className="dk-dept">
          <div className="dk-dept-title">
            {dep.name} <span className="dk-badge">{dep.users.length} 人</span>
            <span className="dk-badge online">{dep.users.filter((u) => u.online).length} 在线</span>
          </div>
          <div className="dk-card dk-table-wrap" style={{ padding: '4px 8px' }}>
            <table className="dk-table dk-people">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>姓名</th>
                  <th>角色</th>
                  <th>部门</th>
                  <th>状态</th>
                  <th>令牌</th>
                  {canEdit && <th style={{ textAlign: 'right' }}>操作</th>}
                </tr>
              </thead>
              <tbody>
                {dep.users.map((u) => (
                  <tr key={u.id} style={u.disabled ? { opacity: 0.55 } : undefined}>
                    <td className="dk-mono nowrap">{u.username}{u.seed && <span className="dk-xs dk-muted" title="种子管理员：不可停用/降级"> ★</span>}</td>
                    <td className="nowrap">{u.displayName}</td>
                    <td>
                      {canEdit ? (
                        <select className="dk-select sm" style={{ width: 84 }} value={u.role} disabled={busy || u.seed} onChange={(e) => patch(u, { role: e.target.value }, `${u.displayName} 已改为${ROLE[e.target.value]}`)}>
                          {data.roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                        </select>
                      ) : ROLE[u.role] ?? u.role}
                    </td>
                    <td>
                      {canEdit ? (
                        <DeptInput value={u.department} disabled={busy} onCommit={(v) => v !== u.department && patch(u, { department: v }, `${u.displayName} 已转到 ${v || '未分组'}`)} />
                      ) : u.department || '—'}
                    </td>
                    <td><span className={`dk-badge ${u.disabled ? 'disabled' : u.online ? 'online' : 'offline'}`}>{u.disabled ? '已停用' : u.online ? '在线' : '离线'}</span></td>
                    <td className="dk-small">{u.gatewayTokenActive ? <span className="dk-badge online">有效</span> : <span className="dk-badge">无</span>}</td>
                    {canEdit && (
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="dk-btn sm ghost" title="吊销网关令牌：这个人所有电脑上的模型请求立刻 401，需重新登录" disabled={busy || !u.gatewayTokenActive} onClick={() => revoke(u)}>吊销令牌</button>
                        <button className="dk-btn sm ghost" title="重置登录密码" disabled={busy} onClick={() => resetPw(u)}>重置密码</button>
                        <button className={`dk-btn sm ${u.disabled ? 'success' : 'danger'}`} title={u.disabled ? '重新启用账号' : '停用账号：令牌同时吊销'} disabled={busy || u.seed} onClick={() => patch(u, { disabled: !u.disabled }, u.disabled ? `${u.displayName} 已启用` : `${u.displayName} 已停用（令牌已吊销）`)}>
                          {u.disabled ? '启用' : '停用'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {canEdit && (
        <div className="dk-card">
          <div className="dk-card-title">发账号</div>
          <div className="dk-form-grid">
            <div className="dk-field"><label>账号</label><input className="dk-input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="工号 / 拼音" /></div>
            <div className="dk-field"><label>初始密码</label><input className="dk-input" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="至少 6 位" /></div>
            <div className="dk-field"><label>姓名</label><input className="dk-input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></div>
            <div className="dk-field"><label>部门</label><input className="dk-input" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} placeholder="例如：销售部" /></div>
            <div className="dk-field">
              <label>角色</label>
              <select className="dk-select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {data.roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </div>
          </div>
          <button className="dk-btn primary" disabled={busy} onClick={create}>发账号</button>
        </div>
      )}
    </div>
  )
}

function DeptInput({ value, onCommit, disabled }) {
  const [v, setV] = useState(value ?? '')
  useEffect(() => setV(value ?? ''), [value])
  return <input className="dk-input sm" style={{ width: 92 }} value={v} disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={() => onCommit(v.trim())} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
}

/* ---------------- 快速推理 ---------------- */
export function QuickInferenceSection() {
  const [q, reload] = useFetch(() => api.gw.get('/quick-inference'), [])
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  useEffect(() => {
    if (q.data && !model) setModel(q.data.model ?? '')
  }, [q.data])
  if (q.error) return <div className="dk-settings"><Head title="快速推理" /><div className="dk-alert error">{q.error}</div></div>
  if (!q.data) return <div className="dk-settings"><Head title="快速推理" /><div className="dk-empty">加载中…</div></div>
  const saveModel = async (m) => {
    const prev = model
    setModel(m)
    try {
      await api.gw.patch('/quick-inference', { model: m || null })
      toast('快速推理模型已更新', 'success')
      reload()
    } catch (err) {
      setModel(prev) // 失败回滚，避免下拉显示一个没保存上的模型
      toast(err.message, 'error')
    }
  }
  const runIt = async () => {
    if (!prompt.trim() || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setResult(null)
    try {
      const r = await api.gw.post('/quick-inference/run', { prompt, model })
      setResult(r)
      reload()
    } catch (err) {
      setResult({ error: err.message })
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  return (
    <div className="dk-settings">
      <Head title="快速推理" desc="不开会话、不进任务卡的一次性问答：走公司网关、按人记账。用于快速改写、翻译、摘要。" />
      <div className="dk-card">
        <div className="dk-field">
          <label>模型（公司默认 {q.data.companyDefault}）</label>
          <select className="dk-select" value={model} onChange={(e) => saveModel(e.target.value)}>
            {q.data.models.map((m) => <option key={m.id} value={m.id}>{m.name}（{m.providerLabel}）</option>)}
          </select>
        </div>
        <div className="dk-field">
          <label>输入</label>
          <textarea className="dk-textarea" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="例如：把下面这段话改成给客户看的正式邮件…" onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && runIt()} />
        </div>
        <button className="dk-btn primary" disabled={busy || !prompt.trim()} onClick={runIt}>{busy ? '推理中…' : '运行（Ctrl+Enter）'}</button>
        {result && (
          <div style={{ marginTop: 12 }}>
            {result.error ? <div className="dk-alert error">{result.error}</div> : (
              <>
                <div className="dk-quick-result">{result.content ?? result.text}</div>
                <div className="dk-xs dk-muted" style={{ marginTop: 6 }}>
                  {result.model} · {result.latencyMs} ms · 输入 {result.usage?.prompt_tokens ?? result.usage?.inputTokens ?? '—'} / 输出 {result.usage?.completion_tokens ?? result.usage?.outputTokens ?? '—'} tokens · 成本 {fmtCny(result.costCny)}
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <div className="dk-card">
        <div className="dk-card-title">最近记录（近 7 天）</div>
        {q.data.recent.length === 0 ? <div className="dk-small dk-muted">还没有快速推理记录。</div> : (
          <table className="dk-table">
            <thead><tr><th>时间</th><th>模型</th><th className="num">输入</th><th className="num">输出</th><th className="num">成本</th></tr></thead>
            <tbody>
              {q.data.recent.map((e, i) => (
                <tr key={i}>
                  <td className="dk-small dk-dim">{fmtDateTime(e.ts)}</td>
                  <td className="dk-mono dk-small">{e.model}</td>
                  <td className="num">{e.inputTokens}</td>
                  <td className="num">{e.outputTokens}</td>
                  <td className="num">{fmtCny(e.costCny)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/* ---------------- 订阅 ---------------- */
export function SubscriptionSection() {
  const desk = useStoreValue(deskStore, (s) => s.desk)
  const [q, reload] = useFetch(
    () =>
      Promise.all([api.gw.get('/company'), api.gw.get('/models'), api.gw.get('/colleagues')]).then(([c, m, col]) => ({
        ...c,
        models: m.models,
        seatsUsed: col.users.filter((u) => !u.disabled).length,
        quotas: col.quota ?? [],
        channels: col.channels ?? [],
        canEditChannels: !!col.canEditChannels,
        quickInferenceModel: col.quickInferenceModel,
      })),
    [],
  )
  const [edit, setEdit] = useState(null)
  const [busy, setBusy] = useState(false)
  // 所有 hook 必须在条件返回之前调用（否则数据到达后 hook 数量变化，整个面板被错误边界吞成空白）
  const models = q.data?.models ?? []
  const providers = useMemo(() => {
    const m = new Map()
    for (const x of models) {
      if (!m.has(x.provider)) m.set(x.provider, { label: x.providerLabel ?? x.provider, models: [] })
      m.get(x.provider).models.push(x)
    }
    return [...m.entries()]
  }, [models])
  if (q.error) return <div className="dk-settings"><Head title="订阅" /><div className="dk-alert error">{q.error}</div></div>
  if (!q.data) return <div className="dk-settings"><Head title="订阅" /><div className="dk-empty">加载中…</div></div>
  const { company, canEdit, seatsUsed, quotas, channels, canEditChannels, quickInferenceModel } = q.data
  const subscribed = channels.filter((c) => c.kind === 'subscription' && c.connected)
  const save = async () => {
    setBusy(true)
    try {
      await api.gw.patch('/company', edit)
      toast('订阅设置已保存', 'success')
      setEdit(null)
      reload()
      refreshDeskState()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="dk-settings">
      <Head title="订阅" desc="公司套餐、席位与每周额度。模型密钥只在公司网关上配置。" right={canEdit && !edit && <button className="dk-btn sm" onClick={() => setEdit({ name: company.name, plan: company.plan, seats: company.seats, weeklyQuotaCny: company.weeklyQuotaCny, quotaAnchor: company.quotaAnchor, defaultModel: company.defaultModel, quickInferenceModel: company.quickInferenceModel, quotaByRole: { ...(company.quotaByRole ?? {}) } })}>编辑</button>} />
      {/* 订阅共享：谁的订阅在给全公司用、本周额度、办公机在线状态 —— 和「同事」页同一份数据 */}
      <div className="lead">
        <div>
          {subscribed.length > 0
            ? <><b>{subscribed.map((c) => c.label).join(' / ')}</b> 订阅正在共享给公司（{[...new Set(subscribed.map((c) => c.connectedBy ?? '配置文件'))].join(' / ')} 接入），员工不接触凭据，不需要各自订阅。</>
            : <>还没有接入订阅通道：管理员可用下方「加入订阅」接入 Grok / ChatGPT / Claude / Google One（Gemini）。</>}
        </div>
        {quotas.map((quota) => (
          <div key={quota.provider}>
            <b>{quota.label}</b> 本周已用 <b>{quota.usedPct}%</b>，还剩 <b>{quota.remainingPct}%</b>（{quotaUseText(quota)}），{fmtDateTime(quota.refreshAt)} 刷新。
          </div>
        ))}
        <div>
          办公机 <b>{desk?.device ?? '本机'}</b> {desk?.online ? '在线' : '离线'}。快速推理用 <b>{quickInferenceModel ?? '—'}</b>，开关在「快速推理」。
        </div>
      </div>
      <ChannelTable channels={channels} canEdit={canEditChannels} onChanged={reload} />
      {!edit ? (
        <div className="dk-card">
          <div className="dk-kv">
            <div><div className="k">公司</div><div className="v">{company.name}</div></div>
            <div><div className="k">套餐</div><div className="v">{company.plan}</div></div>
            <div><div className="k">席位</div><div className="v">{seatsUsed} / {company.seats} 已用</div></div>
            <div><div className="k">每周额度（默认）</div><div className="v">{fmtCny(company.weeklyQuotaCny)} / 人</div></div>
            <div><div className="k">按角色额度</div><div className="v">{Object.entries(company.quotaByRole ?? {}).map(([r, v]) => `${ROLE[r] ?? r} ${fmtCny(v)}`).join(' · ') || '—'}</div></div>
            <div><div className="k">额度刷新锚点</div><div className="v">{fmtDateTime(company.quotaAnchor)}（每周）</div></div>
            <div><div className="k">默认模型</div><div className="v dk-mono dk-small">{company.defaultModel}</div></div>
            <div><div className="k">快速推理模型</div><div className="v dk-mono dk-small">{company.quickInferenceModel}</div></div>
          </div>
        </div>
      ) : (
        <div className="dk-card">
          <div className="dk-form-grid">
            <div className="dk-field"><label>公司名</label><input className="dk-input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div className="dk-field"><label>套餐</label><input className="dk-input" value={edit.plan} onChange={(e) => setEdit({ ...edit, plan: e.target.value })} /></div>
            <div className="dk-field"><label>席位</label><input className="dk-input" type="number" value={edit.seats} onChange={(e) => setEdit({ ...edit, seats: Number(e.target.value) })} /></div>
            <div className="dk-field"><label>每周额度（元/人）</label><input className="dk-input" type="number" value={edit.weeklyQuotaCny} onChange={(e) => setEdit({ ...edit, weeklyQuotaCny: Number(e.target.value) })} /></div>
            {['admin', 'director', 'employee'].map((r) => (
              <div key={r} className="dk-field"><label>{ROLE[r]} 每周额度</label><input className="dk-input" type="number" value={edit.quotaByRole[r] ?? ''} placeholder="留空用默认" onChange={(e) => setEdit({ ...edit, quotaByRole: { ...edit.quotaByRole, [r]: e.target.value === '' ? undefined : Number(e.target.value) } })} /></div>
            ))}
            <div className="dk-field"><label>额度刷新锚点（ISO 时间）</label><input className="dk-input" value={edit.quotaAnchor} onChange={(e) => setEdit({ ...edit, quotaAnchor: e.target.value })} /></div>
            <div className="dk-field">
              <label>默认模型</label>
              <select className="dk-select" value={edit.defaultModel} onChange={(e) => setEdit({ ...edit, defaultModel: e.target.value })}>{models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
            </div>
            <div className="dk-field">
              <label>快速推理模型</label>
              <select className="dk-select" value={edit.quickInferenceModel} onChange={(e) => setEdit({ ...edit, quickInferenceModel: e.target.value })}>{models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
            </div>
          </div>
          <div className="dk-row">
            <button className="dk-btn primary" disabled={busy} onClick={save}>保存</button>
            <button className="dk-btn" onClick={() => setEdit(null)}>取消</button>
          </div>
        </div>
      )}
      {providers.map(([id, p]) => (
        <div key={id} className="dk-card">
          <div className="dk-card-title">{p.label} <span className="dk-muted dk-small">{p.models.length} 个模型 · 密钥仅在网关</span></div>
          <table className="dk-table">
            <thead><tr><th>模型</th><th>ID</th><th>上下文</th><th className="num">输入 ¥/M</th><th className="num">输出 ¥/M</th><th>能力</th></tr></thead>
            <tbody>
              {p.models.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}{m.id === company.defaultModel && <span className="dk-badge" style={{ marginLeft: 6 }}>默认</span>}</td>
                  <td className="dk-mono dk-small">{m.id}</td>
                  <td className="dk-small">{m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K` : '—'}</td>
                  <td className="num">{m.priceCnyPerM?.input ?? '—'}</td>
                  <td className="num">{m.priceCnyPerM?.output ?? '—'}</td>
                  <td className="dk-small dk-dim">{[m.reasoningEfforts ? `推理（${Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts.join('/') : '可选强度'}）` : '对话', `最长输出 ${m.maxTokens}`].join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

const CLOSE_OPTIONS = [
  { id: 'ask', label: '每次询问', hint: '点关闭时选择后台运行或退出，可勾选记住。' },
  { id: 'minimize', label: '最小化到后台', hint: '窗口隐藏，托盘图标可再打开，内核继续跑。' },
  { id: 'quit', label: '退出程序', hint: '结束客户端和内核进程。' },
]

/* ---------------- 桌面（仅 Electron） ---------------- */
export function DesktopSection() {
  const desk = useStoreValue(deskStore, (s) => s.desk)
  const shell = typeof window !== 'undefined' ? window.deskShell : null
  const [prefs, setPrefs] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!shell?.getPrefs) return
    shell.getPrefs().then(setPrefs).catch((err) => setError(err.message || String(err)))
  }, [])
  const versionCard = (
    <div className="dk-card">
      <div className="dk-card-title">本机版本</div>
      <div className="dk-kv">
        <div><div className="k">客户端</div><div className="v">{clientVersionLabel(desk?.client)}</div></div>
        <div><div className="k">构建</div><div className="v dk-mono dk-small">{clientVersionDetail(desk?.client)}</div></div>
      </div>
    </div>
  )
  if (!shell?.getPrefs) {
    return (
      <div className="dk-settings">
        <Head title="桌面" desc="这项只在安装版 / Electron 客户端里生效。" />
        {versionCard}
      </div>
    )
  }
  const choose = async (closeAction) => {
    try {
      const next = await shell.setPrefs({ closeAction })
      setPrefs(next)
      toast('已保存', 'success')
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  return (
    <div className="dk-settings">
      <Head title="桌面" desc="关闭右上角窗口时：后台继续连网关，或退出整个程序。" />
      {versionCard}
      {error && <div className="dk-alert error">{error}</div>}
      <div className="dk-card">
        <div className="dk-card-title">关闭窗口时</div>
        {CLOSE_OPTIONS.map((opt) => (
          <label key={opt.id} className={`dk-choice${prefs?.closeAction === opt.id ? ' on' : ''}`}>
            <input type="radio" name="closeAction" checked={prefs?.closeAction === opt.id} onChange={() => choose(opt.id)} />
            <span>
              <b>{opt.label}</b>
              <div className="dk-xs dk-muted">{opt.hint}</div>
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}
