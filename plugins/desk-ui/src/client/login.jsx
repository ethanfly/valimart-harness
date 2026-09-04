/**
 * 登录遮罩（公司账号登录到网关）与全局 Toast。
 */
import { useEffect, useState } from 'react'
import { api, refreshDeskState, loadTasks, loadPeople } from './api.js'
import { deskStore, useStoreValue, toast } from './store.js'

export const BRAND_MOTTO = 'BORN IN SPOTLIGHT · RAISED IN STARDUST'

/** 品牌字标：正文为衬线大写 THE DIVA，上方一行极小的座右铭（与视频一致）。 */
export function Logotype({ size, motto = BRAND_MOTTO, tagline }) {
  return (
    <span className="dk-logotype" style={size ? { fontSize: size } : undefined}>
      {motto && <i className="motto">{motto}</i>}
      <b>THE DIVA</b>
      {tagline && <small>{tagline}</small>}
    </span>
  )
}

export function LoginOverlay() {
  const desk = useStoreValue(deskStore, (s) => s.desk)
  const phase = useStoreValue(deskStore, (s) => s.phase)
  const [gatewayUrl, setGatewayUrl] = useState(desk?.gatewayUrl ?? 'http://127.0.0.1:8790')
  const [username, setUsername] = useState(desk?.user?.username ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (desk?.gatewayUrl) setGatewayUrl(desk.gatewayUrl)
    if (desk?.user?.username && !username) setUsername(desk.user.username)
  }, [desk?.gatewayUrl, desk?.user?.username])

  const submit = async (e) => {
    e?.preventDefault?.()
    if (!username.trim() || !password) {
      setError('请输入账号和密码')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.login({ gatewayUrl: gatewayUrl.trim(), username: username.trim(), password })
      await refreshDeskState()
      await Promise.all([loadTasks(), loadPeople()])
      toast(`欢迎，${deskStore.get().desk?.user?.displayName ?? username}`, 'success')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dk-overlay">
      <form className="dk-dialog" onSubmit={submit}>
        <div className="dk-login-brand">
          <Logotype />
          <span className="tag">企业交付工作台</span>
        </div>
        {phase === 'offline' && <div className="dk-alert error" style={{ marginBottom: 12 }}>本机 Host 不可达：{deskStore.get().error}</div>}
        {desk?.notice && <div className="dk-alert warn" style={{ marginBottom: 12 }}>{desk.notice}</div>}
        <div className="dk-field">
          <label>公司网关</label>
          <input className="dk-input" value={gatewayUrl} onChange={(e) => setGatewayUrl(e.target.value)} placeholder="http://gateway.company.local:8790" />
        </div>
        <div className="dk-field">
          <label>公司账号</label>
          <input className="dk-input" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} placeholder="工号 / 账号" autoComplete="username" />
        </div>
        <div className="dk-field">
          <label>密码</label>
          <input className="dk-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </div>
        {error && <div className="dk-alert error" style={{ marginBottom: 12 }}>{error}</div>}
        <button className="dk-btn primary" type="submit" disabled={busy} style={{ width: '100%', height: 36, justifyContent: 'center' }}>
          {busy ? '登录中…' : '登录'}
        </button>
        <div className="dk-xs dk-muted" style={{ marginTop: 14, lineHeight: 1.6 }}>
          登录后本机只保存你个人的网关令牌；模型密钥保存在公司服务器，不会下发到本机。管理员可随时吊销令牌。
        </div>
      </form>
    </div>
  )
}

export function Toast() {
  const t = useStoreValue(deskStore, (s) => s.toast)
  if (!t) return null
  return <div className={`dk-toast ${t.kind}`}>{t.message}</div>
}
