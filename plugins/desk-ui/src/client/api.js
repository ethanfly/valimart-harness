/**
 * 浏览器端 → 本机 Host（/desk/api）→ 公司网关。
 */
import { deskStore, toast } from './store.js'

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function call(method, path, body, { raw = false, timeoutMs = 20_000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res
  try {
    res = await fetch(`/desk/api${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw new ApiError(0, '请求超时，请检查本机服务或网关是否在线', 'timeout')
    throw err
  } finally {
    clearTimeout(timer)
  }
  if (raw) return res
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { error: { message: text.slice(0, 200) } }
  }
  if (!res.ok) throw new ApiError(res.status, json?.error?.message ?? `请求失败 ${res.status}`, json?.error?.code)
  return json
}

export const api = {
  state: () => call('GET', '/state'),
  login: (payload) => call('POST', '/login', payload),
  discover: (gatewayUrl) => call('GET', `/discover?gatewayUrl=${encodeURIComponent(gatewayUrl ?? '')}`),
  workspaceGit: () => call('GET', '/workspace-git'),
  probeSetup: (gatewayUrl) => call('GET', `/setup?gatewayUrl=${encodeURIComponent(gatewayUrl ?? '')}`),
  completeSetup: (payload) => call('POST', '/setup', payload),
  logout: () => call('POST', '/logout', {}),
  syncDrive: () => call('POST', '/drive/sync', {}),
  produced: (sessionId) => call('GET', `/sessions/${encodeURIComponent(sessionId)}/produced`),
  lastAssistant: (sessionId) => call('GET', `/sessions/${encodeURIComponent(sessionId)}/last-assistant`),
  attachFiles: (sessionId, files, cwd) => call('POST', `/sessions/${encodeURIComponent(sessionId)}/attach-files`, { files, cwd }, { timeoutMs: 120_000 }),
  bindSession: (taskId, sessionId, title) => call('POST', `/tasks/${encodeURIComponent(taskId)}/bind-session`, { sessionId, title }),
  unbindSession: (taskId, sessionId) => call('POST', `/tasks/${encodeURIComponent(taskId)}/unbind-session`, { sessionId }),
  openProcess: (taskId) => call('POST', `/tasks/${encodeURIComponent(taskId)}/open-process`, {}),
  attachLocal: (taskId, paths, sessionId, source) => call('POST', `/tasks/${encodeURIComponent(taskId)}/attach-local`, { paths, sessionId, source }),
  openPath: (path) => call('POST', '/open', { path }),
  plugins: () => call('GET', '/plugins'),
  image: {
    config: () => call('GET', '/image/config'),
    saveConfig: (body) => call('POST', '/image/config', body),
    generate: (body) => call('POST', '/image/generate', body, { timeoutMs: 180_000 }),
  },
  mixed: {
    config: () => call('GET', '/mixed/config'),
    saveConfig: (body) => call('POST', '/mixed/config', body),
    session: (sid) => call('GET', `/sessions/${encodeURIComponent(sid)}/mixed`),
    setSession: (sid, body) => call('POST', `/sessions/${encodeURIComponent(sid)}/mixed`, body),
    attach: (sid) => call('POST', `/sessions/${encodeURIComponent(sid)}/mixed/attach`, {}),
    runs: (sid) => call('GET', `/mixed/runs?sessionId=${encodeURIComponent(sid)}`),
    run: (runId) => call('GET', `/mixed/runs/${encodeURIComponent(runId)}`),
    cancel: (runId) => call('POST', `/mixed/runs/${encodeURIComponent(runId)}/cancel`, {}),
    resume: (runId, body) => call('POST', `/mixed/runs/${encodeURIComponent(runId)}/resume`, body),
    rerun: (runId) => call('POST', `/mixed/runs/${encodeURIComponent(runId)}/rerun`, {}),
    evidence: (runId, evidenceId) => call('GET', `/mixed/runs/${encodeURIComponent(runId)}/evidence/${encodeURIComponent(evidenceId)}`),
  },
  // 网关业务接口透传：/desk/api/gw/<path> → 网关 /api/<path>
  gw: {
    get: (p) => call('GET', `/gw${p}`),
    post: (p, body = {}) => call('POST', `/gw${p}`, body),
    patch: (p, body = {}) => call('PATCH', `/gw${p}`, body),
    put: (p, body = {}) => call('PUT', `/gw${p}`, body),
    delete: (p) => call('DELETE', `/gw${p}`),
  },
}

/** 刷新登录态；网关不可达时进入 offline。 */
export async function refreshDeskState() {
  try {
    const desk = await api.state()
    deskStore.set({ phase: 'ready', desk, error: null })
    return desk
  } catch (err) {
    deskStore.set({ phase: 'offline', error: err.message })
    return null
  }
}

export async function loadTasks({ silent = true } = {}) {
  const { desk } = deskStore.get()
  if (!desk?.loggedIn) return []
  try {
    const r = await api.gw.get('/tasks')
    deskStore.set((s) => ({ ...s, tasks: r.tasks, tasksError: null, tasksLoadedAt: Date.now(), taskDetail: s.selectedTaskId ? r.tasks.find((t) => t.id === s.selectedTaskId) ?? s.taskDetail : s.taskDetail }))
    return r.tasks
  } catch (err) {
    deskStore.set({ tasksError: err.message })
    if (!silent) toast(err.message, 'error')
    return []
  }
}

export async function loadTask(taskId) {
  const r = await api.gw.get(`/tasks/${encodeURIComponent(taskId)}`)
  deskStore.set((s) => ({ ...s, taskDetail: r.task, tasks: s.tasks.some((t) => t.id === r.task.id) ? s.tasks.map((t) => (t.id === r.task.id ? r.task : t)) : [r.task, ...s.tasks] }))
  return r.task
}

export function applyTask(task) {
  deskStore.set((s) => ({ ...s, taskDetail: s.selectedTaskId === task.id ? task : s.taskDetail, tasks: s.tasks.some((t) => t.id === task.id) ? s.tasks.map((t) => (t.id === task.id ? task : t)) : [task, ...s.tasks] }))
}

export async function loadPeople() {
  try {
    const r = await api.gw.get('/people')
    deskStore.set({ people: r.users })
    return r.users
  } catch {
    return deskStore.get().people
  }
}

/** 后台轮询：登录态 + 任务列表。 */
export function startPolling() {
  let stopped = false
  let inflight = false
  const tick = async () => {
    if (stopped || inflight) return
    inflight = true
    try {
      const desk = await refreshDeskState()
      if (desk?.loggedIn) await loadTasks()
    } finally {
      inflight = false
    }
  }
  tick()
  const timer = setInterval(tick, 15_000)
  const onFocus = () => tick()
  window.addEventListener('focus', onFocus)
  return () => {
    stopped = true
    clearInterval(timer)
    window.removeEventListener('focus', onFocus)
  }
}

export function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff >= 0 && diff < 60_000) return '刚才'
  if (diff >= 0 && diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff >= 0 && diff < 86400_000 && d.getDate() === new Date().getDate()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
export function fmtCny(n) {
  if (n === undefined || n === null) return '—'
  const v = Number(n)
  if (v === 0) return '¥0.00'
  if (Math.abs(v) < 0.01) return `¥${v.toFixed(4)}`
  return `¥${v.toFixed(2)}`
}
export function fmtBytes(n) {
  if (n === undefined || n === null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
const pad = (n) => String(n).padStart(2, '0')
