/**
 * Prefer company-desk createGateway (temp dataDir + mock-echo).
 * If the sibling cannot be imported, speak the same login / me / models / chat paths locally.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SIBLING_CANDIDATES = [
  path.resolve(here, '../../../company-harness/server/src/index.js'),
  path.resolve('E:/workspace/valimart-harness/company-desk/server/src/index.js'),
  path.resolve(here, '../../../../valimart-harness/company-desk/server/src/index.js'),
  path.resolve(process.cwd(), '../valimart-harness/company-desk/server/src/index.js'),
]

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vh-gw-'))
}

export async function startCompanyDeskGateway() {
  const dataDir = tmpDir()
  let createGateway
  let importErr
  for (const candidate of SIBLING_CANDIDATES) {
    if (!fs.existsSync(candidate)) continue
    try {
      const mod = await import(pathToFileURL(candidate).href)
      createGateway = mod.createGateway
      break
    } catch (err) {
      importErr = err
    }
  }
  if (typeof createGateway !== 'function') {
    return startCompatGateway(dataDir, importErr)
  }

  const gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    lanDiscover: false,
    upstreams: {
      mock: {
        kind: 'mock',
        label: 'Mock',
        models: [
          { id: 'mock-echo', name: 'Mock Echo', priceCnyPerM: { input: 1, output: 2, cachedInput: 0.1 } },
          {
            id: 'mock-reasoner',
            name: 'Mock Reasoner',
            reasoningEfforts: { off: null, low: 'low', high: 'high' },
            priceCnyPerM: { input: 1, output: 2, cachedInput: 0.1 },
          },
        ],
      },
    },
    defaultModel: 'mock-echo',
    seedAdmin: { username: 'boss', password: 'boss123456', displayName: '老板', department: '管理层' },
    seedUsers: [
      { username: 'emp-a', password: 'emp123456', displayName: '员工A', role: 'employee', department: '内容部' },
      { username: 'director', password: 'director123', displayName: '总监', role: 'director', department: '内容部' },
    ],
    fetchReleases: async () => [],
    fetchNpmVersions: async () => [],
    fetchModels: async () => new Response(JSON.stringify({ error: 'no' }), { status: 404 }),
  })
  const baseUrl = await gw.listen()
  return {
    source: 'createGateway',
    baseUrl,
    dataDir,
    credentials: { username: 'boss', password: 'boss123456' },
    close: async () => {
      await gw.close()
      fs.rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function bearer(req) {
  const h = req.headers.authorization ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(h)
  return m ? m[1].trim() : undefined
}

/** Local stand-in that matches company-desk login + /v1 + 任务卡 paths/payloads. */
export function startCompatGateway(dataDir, importErr) {
  const sessions = new Map()
  const gateways = new Map()
  const users = {
    boss: { id: 'u-boss', username: 'boss', displayName: '老板', role: 'admin', department: '管理层', password: 'boss123456' },
    'emp-a': { id: 'u-emp', username: 'emp-a', displayName: '员工A', role: 'employee', department: '内容部', password: 'emp123456' },
    director: { id: 'u-dir', username: 'director', displayName: '总监', role: 'director', department: '内容部', password: 'director123' },
  }
  const publicUser = (u) => {
    const { password: _p, ...rest } = u
    return rest
  }
  const company = {
    name: 'valimart harness',
    defaultModel: 'mock-echo',
    models: [
      { id: 'mock-echo', name: 'Mock Echo', provider: 'mock', providerLabel: 'Mock' },
      { id: 'mock-reasoner', name: 'Mock Reasoner', provider: 'mock', providerLabel: 'Mock', reasoningEfforts: { off: null, low: 'low', high: 'high' } },
    ],
  }
  const quota = [
    {
      provider: 'mock',
      label: 'Mock',
      kind: 'cny',
      usedCny: 0,
      limitCny: 1000,
      usedPct: 0,
      remainingPct: 100,
      refreshAt: '2099-01-01T00:00:00.000Z',
    },
  ]
  const tasks = []
  const STATUS = { draft: '进行中', pending_review: '待审', pending_final: '待终审', approved: '通过', rejected: '驳回' }
  const viewTask = (t) => ({
    ...t,
    statusLabel: STATUS[t.status],
    assigner: publicUser(Object.values(users).find((u) => u.id === t.assignerId) ?? {}),
    assignee: publicUser(Object.values(users).find((u) => u.id === t.assigneeId) ?? {}),
    reviewer: t.reviewerId ? publicUser(Object.values(users).find((u) => u.id === t.reviewerId) ?? {}) : null,
  })
  const authUser = (req) => sessions.get(bearer(req))
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    try {
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readJson(req)
        const rec = users[body.username]
        if (!rec || rec.password !== body.password) {
          return json(res, 401, { error: { message: '账号或密码错误', code: 'bad_credentials' } })
        }
        const sessionToken = `sess_${crypto.randomBytes(12).toString('hex')}`
        const gatewayToken = `dgw_${crypto.randomBytes(12).toString('hex')}`
        const user = publicUser(rec)
        sessions.set(sessionToken, user)
        gateways.set(gatewayToken, user)
        return json(res, 200, { user, sessionToken, gatewayToken, company, quota })
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/me') {
        const u = authUser(req)
        if (!u) return json(res, 401, { error: { message: '未登录或登录已失效', code: 'unauthenticated' } })
        return json(res, 200, { user: u, company, quota, gatewayTokenActive: true })
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        const tok = bearer(req)
        if (!sessions.has(tok)) return json(res, 401, { error: { message: '未登录或登录已失效', code: 'unauthenticated' } })
        sessions.delete(tok)
        return json(res, 200, { ok: true })
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        if (!gateways.has(bearer(req))) return json(res, 401, { error: { message: '网关令牌无效', code: 'invalid_token' } })
        return json(res, 200, { object: 'list', data: company.models.map((m) => ({ id: m.id, object: 'model', owned_by: m.provider })) })
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        if (!gateways.has(bearer(req))) return json(res, 401, { error: { message: '网关令牌无效', code: 'invalid_token' } })
        const body = await readJson(req)
        const last = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user')
        const text = typeof last?.content === 'string' ? last.content : Array.isArray(last?.content) ? last.content.map((p) => p.text ?? '').join('') : ''
        return json(res, 200, {
          id: 'chatcmpl-compat',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: `【Mock 模型】收到你的消息：「${text.slice(0, 200)}」` }, finish_reason: 'stop' }],
        })
      }
      if (req.method === 'GET' && url.pathname === '/api/people') {
        if (!authUser(req)) return json(res, 401, { error: { message: '未登录', code: 'unauthenticated' } })
        return json(res, 200, { users: Object.values(users).map(publicUser) })
      }
      if (req.method === 'GET' && url.pathname === '/api/tasks') {
        if (!authUser(req)) return json(res, 401, { error: { message: '未登录', code: 'unauthenticated' } })
        return json(res, 200, { tasks: tasks.map(viewTask), statuses: STATUS })
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks') {
        const u = authUser(req)
        if (!u) return json(res, 401, { error: { message: '未登录', code: 'unauthenticated' } })
        const body = await readJson(req)
        const task = {
          id: `tk-${crypto.randomBytes(5).toString('hex')}`,
          title: body.title || '未命名报告',
          content: body.content ?? '',
          submission: body.submission ?? '',
          project: body.project ?? '',
          status: 'draft',
          assignerId: u.id,
          assigneeId: u.id,
          reviewerId: null,
          deliverables: [],
          sessions: [],
          log: [],
        }
        tasks.push(task)
        return json(res, 201, { task: viewTask(task) })
      }
      const taskMatch = /^\/api\/tasks\/([^/]+)(?:\/(.*))?$/.exec(url.pathname)
      if (taskMatch) {
        const u = authUser(req)
        if (!u) return json(res, 401, { error: { message: '未登录', code: 'unauthenticated' } })
        const task = tasks.find((t) => t.id === taskMatch[1])
        if (!task) return json(res, 404, { error: { message: '任务不存在', code: 'task_not_found' } })
        const rest = taskMatch[2] ?? ''
        if (req.method === 'GET' && !rest) return json(res, 200, { task: viewTask(task) })
        if (req.method === 'PATCH' && !rest) {
          const body = await readJson(req)
          for (const k of ['title', 'content', 'submission', 'project']) if (body[k] !== undefined) task[k] = body[k]
          return json(res, 200, { task: viewTask(task) })
        }
        if (req.method === 'POST' && rest === 'sessions') {
          const body = await readJson(req)
          task.sessions.push({ sessionId: body.sessionId, title: body.title ?? '', userId: u.id })
          return json(res, 200, { task: viewTask(task) })
        }
        if (req.method === 'POST' && rest === 'deliverables') {
          const body = await readJson(req)
          for (const f of body.files ?? []) task.deliverables.push({ name: f.name, size: Buffer.from(f.dataBase64 ?? '', 'base64').length })
          return json(res, 200, { task: viewTask(task) })
        }
        if (req.method === 'POST' && rest === 'submit') {
          if (task.deliverables.length === 0) return json(res, 400, { error: { message: '口头完成不算完成', code: 'no_deliverables' } })
          const body = await readJson(req)
          task.reviewerId = body.reviewerId
          task.status = 'pending_review'
          task.submittedAt = new Date().toISOString()
          return json(res, 200, { task: viewTask(task) })
        }
        if (req.method === 'POST' && rest === 'review') {
          const body = await readJson(req)
          task.review = { decision: body.decision, comment: body.comment }
          task.status = body.decision === 'pass' ? 'pending_final' : 'rejected'
          return json(res, 200, { task: viewTask(task) })
        }
        if (req.method === 'POST' && rest === 'final') {
          const body = await readJson(req)
          task.final = { decision: body.decision, comment: body.comment }
          task.status = body.decision === 'pass' ? 'approved' : 'rejected'
          return json(res, 200, { task: viewTask(task) })
        }
      }
      json(res, 404, { error: { message: `no route ${req.method} ${url.pathname}`, code: 'not_found' } })
    } catch (err) {
      json(res, 500, { error: { message: err.message, code: 'internal' } })
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({
        source: 'compat',
        importError: importErr?.message,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        dataDir,
        credentials: { username: 'boss', password: 'boss123456' },
        close: async () => {
          await new Promise((r) => server.close(r))
          fs.rmSync(dataDir, { recursive: true, force: true })
        },
      })
    })
  })
}

/**
 * Scripted /v1/chat/completions stub: replies is an array of message objects (or a function
 * of the request body). The final reply repeats when the script runs out. Every request body
 * is recorded so tests can assert what the loop actually re-sent.
 */
export function startScriptedModelServer(replies) {
  const bodies = []
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404)
      res.end()
      return
    }
    const chunks = []
    for await (const c of req) chunks.push(c)
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      body = {}
    }
    const index = bodies.length
    bodies.push(body)
    const message = typeof replies === 'function' ? replies(body, index) : replies[Math.min(index, replies.length - 1)]
    const raw = JSON.stringify({
      id: `chatcmpl-script-${index}`,
      choices: [{ index: 0, message, finish_reason: message?.tool_calls?.length ? 'tool_calls' : 'stop' }],
    })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) })
    res.end(raw)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        bodies,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

/** Stub that never answers: forces the client-side timeout path. */
export function startHangingModelServer() {
  const server = http.createServer(() => {
    /* accept but never respond */
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

export function startStubModelServer({ toolCall, thenText = 'done writing.' }) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404)
      res.end()
      return
    }
    const chunks = []
    for await (const c of req) chunks.push(c)
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      body = {}
    }
    const hasTool = (body.messages ?? []).some((m) => m.role === 'tool')
    const payload = hasTool
      ? {
          id: 'chatcmpl-stub-2',
          choices: [{ index: 0, message: { role: 'assistant', content: thenText }, finish_reason: 'stop' }],
        }
      : {
          id: 'chatcmpl-stub-1',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [toolCall],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }
    const raw = JSON.stringify(payload)
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) })
    res.end(raw)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}
