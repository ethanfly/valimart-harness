/**
 * 登录遮罩（公司账号登录到网关）与首次安装引导、全局 Toast。
 */
import { useEffect, useState } from 'react'
import { api, refreshDeskState, loadTasks, loadPeople } from './api.js'
import { deskStore, useStoreValue, toast } from './store.js'
import { Logotype, PRODUCT_TAG } from './brand.jsx'
import { clientVersionDetail, clientVersionLabel, kernelVersionLabel } from './version.js'

export { Logotype, PRODUCT_NAME, PRODUCT_TAG } from './brand.jsx'

const SETUP_STEPS = ['公司', '管理员', '同事']

export function LoginOverlay() {
  const desk = useStoreValue(deskStore, (s) => s.desk)
  const phase = useStoreValue(deskStore, (s) => s.phase)
  const [gatewayUrl, setGatewayUrl] = useState(desk?.gatewayUrl ?? 'http://127.0.0.1:8790')
  const [username, setUsername] = useState(desk?.user?.username ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [setupStep, setSetupStep] = useState(1)
  const [companyName, setCompanyName] = useState('valimart harness')
  const [admin, setAdmin] = useState({ username: '', displayName: '', department: '管理层', password: '', passwordConfirm: '' })
  const [colleague, setColleague] = useState({ username: '', displayName: '', department: '', password: '' })
  const [urlTouched, setUrlTouched] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [gateways, setGateways] = useState([])
  const [discoverNote, setDiscoverNote] = useState('')

  useEffect(() => {
    if (desk?.gatewayUrl) setGatewayUrl(desk.gatewayUrl)
    if (desk?.user?.username && !username) setUsername(desk.user.username)
  }, [desk?.gatewayUrl, desk?.user?.username])

  const runDiscover = async ({ overwrite = !urlTouched } = {}) => {
    setDiscovering(true)
    setDiscoverNote('正在寻找本机网关，没有再找局域网…')
    try {
      const r = await api.discover(gatewayUrl)
      const list = r.gateways ?? []
      setGateways(list)
      if (overwrite && r.picked) setGatewayUrl(r.picked)
      if (!list.length) setDiscoverNote('本机和局域网都没找到网关，请填写地址或点「重新寻找」')
      else if (list.length === 1) setDiscoverNote(`已找到 ${list[0].name || r.picked}`)
      else setDiscoverNote(`找到 ${list.length} 台网关，可在下方选择`)
    } catch (err) {
      setDiscoverNote(err.message)
    } finally {
      setDiscovering(false)
    }
  }

  useEffect(() => {
    runDiscover()
    // 仅打开登录页时自动找一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const url = gatewayUrl.trim()
    if (!url) return
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const r = await api.probeSetup(url)
        if (cancelled) return
        setNeedsSetup(!!r.needsSetup)
        if (r.companyName) setCompanyName((cur) => (cur && cur !== 'valimart harness' ? cur : r.companyName))
        setError(null)
      } catch {
        if (!cancelled) setNeedsSetup(false)
      }
    }, 280)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [gatewayUrl])

  const afterAuth = async (name) => {
    await refreshDeskState()
    await Promise.all([loadTasks(), loadPeople()])
    toast(`欢迎，${deskStore.get().desk?.user?.displayName ?? name}`, 'success')
  }

  const submitLogin = async (e) => {
    e?.preventDefault?.()
    if (!username.trim() || !password) {
      setError('请输入账号和密码')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.login({ gatewayUrl: gatewayUrl.trim(), username: username.trim(), password })
      await afterAuth(username)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const submitSetup = async (e) => {
    e?.preventDefault?.()
    setError(null)
    if (setupStep === 1) {
      if (!companyName.trim()) return setError('请填写公司名称')
      setSetupStep(2)
      return
    }
    if (setupStep === 2) {
      if (!admin.username.trim()) return setError('请填写管理员账号')
      if (!admin.password || admin.password.length < 6) return setError('管理员密码至少 6 位')
      if (admin.password !== admin.passwordConfirm) return setError('两次输入的密码不一致')
      setSetupStep(3)
      return
    }
    const colleagues = []
    if (colleague.username.trim()) {
      if (!colleague.password || colleague.password.length < 6) return setError('同事密码至少 6 位，或清空账号以跳过')
      colleagues.push({
        username: colleague.username.trim(),
        displayName: colleague.displayName.trim(),
        department: colleague.department.trim(),
        password: colleague.password,
        role: 'employee',
      })
    }
    setBusy(true)
    try {
      await api.completeSetup({
        gatewayUrl: gatewayUrl.trim(),
        companyName: companyName.trim(),
        admin: { ...admin, username: admin.username.trim(), displayName: admin.displayName.trim(), department: admin.department.trim() },
        colleagues,
        device: 'desktop',
      })
      await afterAuth(admin.displayName || admin.username)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dk-overlay">
      <form className={`dk-dialog${needsSetup ? ' setup' : ''}`} onSubmit={needsSetup ? submitSetup : submitLogin}>
        <div className="dk-login-brand">
          <Logotype size={28} />
          <span className="tag">{needsSetup ? '首次安装引导' : PRODUCT_TAG}</span>
        </div>
        {phase === 'offline' && <div className="dk-alert error" style={{ marginBottom: 12 }}>本机 Host 不可达：{deskStore.get().error}</div>}
        {desk?.notice && <div className="dk-alert warn" style={{ marginBottom: 12 }}>{desk.notice}</div>}
        <div className="dk-field">
          <label>公司网关</label>
          <div className="dk-gateway-row">
            <input
              className="dk-input"
              value={gatewayUrl}
              onChange={(e) => { setUrlTouched(true); setGatewayUrl(e.target.value) }}
              placeholder="正在寻找本机网关…"
            />
            <button className="dk-btn" type="button" disabled={discovering} onClick={() => runDiscover({ overwrite: true })}>
              {discovering ? '寻找中' : '重新寻找'}
            </button>
          </div>
          {gateways.length > 1 && (
            <select
              className="dk-select"
              value={gatewayUrl}
              onChange={(e) => { setUrlTouched(true); setGatewayUrl(e.target.value) }}
              style={{ marginTop: 6 }}
            >
              {gateways.map((g) => {
                const url = (g.urls ?? [])[0]
                if (!url) return null
                return (
                  <option key={g.instanceId || url} value={url}>
                    {g.name ? `${g.name} · ${url}` : url}
                  </option>
                )
              })}
            </select>
          )}
          {discoverNote && <span className="hint">{discoverNote}</span>}
        </div>
        {needsSetup ? (
          <SetupFields
            step={setupStep}
            companyName={companyName}
            setCompanyName={setCompanyName}
            admin={admin}
            setAdmin={setAdmin}
            colleague={colleague}
            setColleague={setColleague}
          />
        ) : (
          <>
            <div className="dk-field">
              <label>公司账号</label>
              <input className="dk-input" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} placeholder="工号 / 账号" autoComplete="username" />
            </div>
            <div className="dk-field">
              <label>密码</label>
              <input className="dk-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </div>
          </>
        )}
        {error && <div className="dk-alert error" style={{ marginBottom: 12 }}>{error}</div>}
        <div className="dk-row" style={{ gap: 8 }}>
          {needsSetup && setupStep > 1 && (
            <button className="dk-btn" type="button" disabled={busy} onClick={() => { setError(null); setSetupStep((s) => s - 1) }}>
              上一步
            </button>
          )}
          <button className="dk-btn primary" type="submit" disabled={busy} style={{ flex: 1, justifyContent: 'center' }}>
            {busy ? '请稍候…' : needsSetup ? (setupStep === 3 ? '完成并登录' : '下一步') : '登录'}
          </button>
        </div>
        <div className="dk-xs dk-muted" style={{ marginTop: 14, lineHeight: 1.6 }}>
          {needsSetup
            ? '没有演示账号。引导只在库里还没有任何用户时出现；完成后即可用刚设置的管理员登录。'
            : '打开登录页会先找本机是否已有网关服务，没有再找局域网。登录后本机只保存你个人的网关令牌；模型密钥保存在公司服务器，不会下发到本机。'}
        </div>
        <div className="dk-client-ver" title={`${clientVersionDetail(desk?.client)} · 内核 ${kernelVersionLabel(desk)}`}>
          {clientVersionLabel(desk?.client)} · 内核 {kernelVersionLabel(desk)}
        </div>
      </form>
    </div>
  )
}

function SetupFields({ step, companyName, setCompanyName, admin, setAdmin, colleague, setColleague }) {
  const patchAdmin = (k, v) => setAdmin((s) => ({ ...s, [k]: v }))
  const patchCol = (k, v) => setColleague((s) => ({ ...s, [k]: v }))
  return (
    <>
      <div className="dk-setup-steps" aria-label="引导步骤">
        {SETUP_STEPS.map((label, i) => (
          <span key={label} className={step === i + 1 ? 'on' : ''}>{i + 1} {label}</span>
        ))}
      </div>
      {step === 1 && (
        <div className="dk-field">
          <label>公司名称</label>
          <input className="dk-input" autoFocus value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="显示在侧栏与管理页" />
          <span className="hint">之后可在设置里改。</span>
        </div>
      )}
      {step === 2 && (
        <>
          <p className="dk-small dk-dim" style={{ margin: '0 0 10px' }}>创建第一个管理员。没有演示数据，密码由你自己定。</p>
          <div className="dk-form-grid">
            <div className="dk-field">
              <label>管理员账号</label>
              <input className="dk-input" autoFocus value={admin.username} onChange={(e) => patchAdmin('username', e.target.value)} placeholder="字母数字 ._-，2–32 位" autoComplete="username" />
            </div>
            <div className="dk-field">
              <label>显示名</label>
              <input className="dk-input" value={admin.displayName} onChange={(e) => patchAdmin('displayName', e.target.value)} placeholder="例如：系统管理员" />
            </div>
          </div>
          <div className="dk-field">
            <label>部门</label>
            <input className="dk-input" value={admin.department} onChange={(e) => patchAdmin('department', e.target.value)} />
          </div>
          <div className="dk-form-grid">
            <div className="dk-field">
              <label>密码</label>
              <input className="dk-input" type="password" value={admin.password} onChange={(e) => patchAdmin('password', e.target.value)} autoComplete="new-password" />
            </div>
            <div className="dk-field">
              <label>确认密码</label>
              <input className="dk-input" type="password" value={admin.passwordConfirm} onChange={(e) => patchAdmin('passwordConfirm', e.target.value)} autoComplete="new-password" />
            </div>
          </div>
        </>
      )}
      {step === 3 && (
        <>
          <p className="dk-small dk-dim" style={{ margin: '0 0 10px' }}>可选：现在发第一个同事账号。留空账号即可跳过，之后在「人员」里添加。</p>
          <div className="dk-form-grid">
            <div className="dk-field">
              <label>同事账号</label>
              <input className="dk-input" autoFocus value={colleague.username} onChange={(e) => patchCol('username', e.target.value)} placeholder="留空则跳过" />
            </div>
            <div className="dk-field">
              <label>显示名</label>
              <input className="dk-input" value={colleague.displayName} onChange={(e) => patchCol('displayName', e.target.value)} />
            </div>
          </div>
          <div className="dk-form-grid">
            <div className="dk-field">
              <label>部门</label>
              <input className="dk-input" value={colleague.department} onChange={(e) => patchCol('department', e.target.value)} />
            </div>
            <div className="dk-field">
              <label>密码</label>
              <input className="dk-input" type="password" value={colleague.password} onChange={(e) => patchCol('password', e.target.value)} autoComplete="new-password" />
            </div>
          </div>
        </>
      )}
    </>
  )
}

export function Toast() {
  const t = useStoreValue(deskStore, (s) => s.toast)
  if (!t) return null
  return <div className={`dk-toast ${t.kind}`}>{t.message}</div>
}
