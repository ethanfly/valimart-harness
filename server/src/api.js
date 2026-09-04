/**
 * /api/* 业务接口（客户端本机 host 以登录会话令牌访问）。
 */
import fs from 'node:fs'
import { HttpError, readJson, readBody, sendJson, bearer, parseUrl } from './http.js'
import { ROLES, ROLE_LABELS, publicUser, verifyPassword, hashPassword } from './db.js'
import { TASK_STATUS } from './tasks.js'
import { MEMORY_LAYERS } from './drive.js'

/** 客户端内核的锁定版本（scripts/kernel/pin.json），只用于管理页展示。 */
const KERNEL_LABEL = (() => {
  try {
    const pin = JSON.parse(fs.readFileSync(new URL('../../scripts/kernel/pin.json', import.meta.url), 'utf8'))
    return `${pin.package}@${pin.version}（内置公司补丁）`
  } catch {
    return '@deepseek-ai/dsh（内置公司补丁）'
  }
})()

export function registerApi(router, ctx) {
  const { db, cfg, ledger, tasks, drive, proxy, catalog, presence, channels, knowledge, startedAt } = ctx

  const auth = (req, { allowDisabled = false } = {}) => {
    const token = bearer(req)
    const session = db.findLoginSession(token)
    if (!session) throw new HttpError(401, '未登录或登录已失效', 'unauthenticated')
    const user = db.getUser(session.userId)
    if (!user) throw new HttpError(401, '账号不存在', 'unauthenticated')
    if (user.disabled && !allowDisabled) throw new HttpError(403, '账号已停用', 'account_disabled')
    presence.touch(user.id)
    return { user, session }
  }
  const requireAdmin = (user) => {
    if (user.role !== 'admin') throw new HttpError(403, '需要管理员权限', 'forbidden')
  }
  const isOnline = (u) => presence.isOnline(u)
  const models = () => catalog()
  const providers = () =>
    Object.values(cfg.upstreams)
      .filter((u) => u.kind === 'mock' || u.resolvedKey)
      .map((u) => ({ id: u.id, label: u.label ?? u.id, kind: u.kind }))
  const companyView = () => {
    const s = db.companySettings()
    return {
      name: s.name ?? cfg.company?.name ?? 'Company',
      plan: s.plan ?? cfg.company?.plan ?? '团队版',
      seats: s.seats ?? cfg.company?.seats ?? 10,
      seatsUsed: db.listUsers().filter((u) => !u.disabled).length,
      weeklyQuotaCny: s.weeklyQuotaCny ?? cfg.quota?.weeklyCny ?? 200,
      quotaByRole: { ...(cfg.quota?.byRole ?? {}), ...(s.quotaByRole ?? {}) },
      quotaAnchor: ledger.quotaAnchor(),
      defaultModel: s.defaultModel ?? cfg.defaultModel ?? models()[0]?.id,
      quickInferenceModel: s.quickInferenceModel ?? cfg.quickInference?.defaultModel ?? models()[0]?.id,
      providers: providers(),
      models: models().map(({ compat: _c, upstreamModel: _u, ...m }) => m),
      publicUrl: cfg.publicUrl,
      memoryLayers: MEMORY_LAYERS,
    }
  }
  const loginPayload = (user, sessionToken, gatewayToken) => ({
    user: publicUser(user),
    sessionToken,
    gatewayToken,
    company: companyView(),
    quota: ledger.quotaView(user, providers()),
    serverTime: new Date().toISOString(),
  })

  // ---------- 认证 ----------
  router.post('/api/auth/login', async (req, res) => {
    const body = await readJson(req)
    const user = db.getUserByName(body.username)
    if (!user || !verifyPassword(String(body.password ?? ''), user.passwordSalt, user.passwordHash)) {
      throw new HttpError(401, '账号或密码错误', 'bad_credentials')
    }
    if (user.disabled) throw new HttpError(403, '账号已停用，请联系管理员', 'account_disabled')
    const { token, item: session } = db.createLoginSession(user.id, cfg.loginTtlDays ?? 30, body.device)
    // 网关令牌绑定这次登录（这台电脑）；管理页 / 网页登录不需要调模型，传 gatewayToken:false 就不签发，也不会打断桌面端
    const gatewayToken = body.gatewayToken === false ? null : db.issueGatewayToken(user.id, body.device ?? 'desktop', session.id).token
    db.updateUser(user.id, { lastLoginAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() })
    drive.ensureOffice(user.username)
    presence.touch(user.id)
    console.log(`[gateway] 登录 ${user.username} (${ROLE_LABELS[user.role]}) device=${body.device ?? '-'}${gatewayToken ? '' : '（不签网关令牌）'}`)
    sendJson(res, 200, loginPayload(db.getUser(user.id), token, gatewayToken))
  })

  router.post('/api/auth/logout', async (req, res) => {
    const { user, session } = auth(req, { allowDisabled: true })
    db.revokeLoginSession(session.id)
    db.revokeGatewayTokensForSession(session.id) // 这台电脑登出：它的模型令牌同时作废
    presence.leave(user.id)
    sendJson(res, 200, { ok: true })
  })

  /** 这台电脑（这次登录会话）自己的网关令牌是否仍有效——不是「这个人随便哪台电脑还有没有令牌」。 */
  const myGatewayTokenActive = (session) => !!db.gatewayTokenForSession(session.id)

  router.get('/api/auth/me', async (req, res) => {
    const { user, session } = auth(req)
    sendJson(res, 200, { user: publicUser(user), company: companyView(), quota: ledger.quotaView(user, providers()), gatewayTokenActive: myGatewayTokenActive(session), serverTime: new Date().toISOString() })
  })

  router.post('/api/auth/gateway-token', async (req, res) => {
    const { user, session } = auth(req)
    const { token } = db.issueGatewayToken(user.id, 'desktop-reissue', session.id)
    sendJson(res, 200, { gatewayToken: token })
  })

  router.post('/api/auth/password', async (req, res) => {
    const { user } = auth(req)
    const body = await readJson(req)
    if (!verifyPassword(String(body.oldPassword ?? ''), user.passwordSalt, user.passwordHash)) throw new HttpError(400, '原密码错误')
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 6) throw new HttpError(400, '新密码至少 6 位')
    const { salt, hash } = hashPassword(body.newPassword)
    db.updateUser(user.id, { passwordSalt: salt, passwordHash: hash })
    sendJson(res, 200, { ok: true })
  })

  /** 模型目录签名：管理员接入/断开通道、改显示名或推理档位都会变；客户端心跳用它判断要不要重写本机路由。 */
  const modelsSignature = () => JSON.stringify(companyView().models)
  router.post('/api/presence', async (req, res) => {
    const { user, session } = auth(req)
    sendJson(res, 200, { ok: true, serverTime: new Date().toISOString(), gatewayTokenActive: myGatewayTokenActive(session), quota: ledger.quotaView(user, providers()), modelsSignature: modelsSignature() })
  })

  // ---------- 模型目录 ----------
  router.get('/api/models', async (req, res) => {
    auth(req)
    sendJson(res, 200, { models: models().map(({ upstreamModel: _u, ...m }) => m), defaultModel: companyView().defaultModel, gatewayBaseUrl: `${cfg.publicUrl}/v1` })
  })

  // ---------- 同事 ----------
  router.get('/api/colleagues', async (req, res) => {
    const { user } = auth(req)
    const ledger7 = ledger.companyLedger(7)
    const users = db
      .listUsers()
      .map((u) => ({ ...publicUser(u), online: isOnline(u), spend7dCny: ledger7.byUser[u.id] ?? 0, weeklyQuotaCny: ledger.weeklyLimitCny(u) }))
      .sort((a, b) => a.username.localeCompare(b.username))
    sendJson(res, 200, {
      quota: ledger.quotaView(user, providers()),
      ledger7d: { totalCny: ledger7.totalCny, requests: ledger7.requests, byModel: ledger7.byModel },
      users,
      me: publicUser(user),
      channels: channels?.view() ?? [],
      quickInferenceModel: companyView().quickInferenceModel,
      canEditChannels: user.role === 'admin',
    })
  })

  // ---------- 模型通道（订阅 / key）----------
  router.get('/api/channels', async (req, res) => {
    const { user } = auth(req)
    sendJson(res, 200, { channels: channels?.view() ?? [], canEdit: user.role === 'admin' })
  })

  router.post('/api/channels/:id/connect', async (req, res) => {
    const { user } = auth(req)
    requireAdmin(user)
    if (!channels) throw new HttpError(500, '通道模块未启用')
    const body = await readJson(req)
    const channel = channels.connect(req.params.id, body, user)
    console.log(`[gateway] ${user.username} 接入通道 ${channel.label}（${channel.kindLabel}），模型 ${channel.models.join(', ')}`)
    sendJson(res, 200, { channel, channels: channels.view(), models: models().map(({ compat: _c, upstreamModel: _u, ...m }) => m) })
  })

  router.post('/api/channels/:id/disconnect', async (req, res) => {
    const { user } = auth(req)
    requireAdmin(user)
    if (!channels) throw new HttpError(500, '通道模块未启用')
    const channel = channels.disconnect(req.params.id)
    console.log(`[gateway] ${user.username} 断开通道 ${channel.label}`)
    sendJson(res, 200, { channel, channels: channels.view(), models: models().map(({ compat: _c, upstreamModel: _u, ...m }) => m) })
  })

  // ---------- 人员 ----------
  const personnelView = () => {
    const groups = new Map()
    for (const u of db.listUsers()) {
      const dep = u.department || '未分组'
      if (!groups.has(dep)) groups.set(dep, [])
      groups.get(dep).push({ ...publicUser(u), online: isOnline(u), gatewayTokenActive: !!db.activeGatewayToken(u.id) })
    }
    return {
      departments: [...groups.entries()].map(([name, users]) => ({ name, users: users.sort((a, b) => a.username.localeCompare(b.username)) })).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
      roles: ROLES.map((r) => ({ id: r, label: ROLE_LABELS[r] })),
    }
  }
  router.get('/api/personnel', async (req, res) => {
    const { user } = auth(req)
    if (user.role === 'employee') throw new HttpError(403, '人员管理仅总监/管理员可见', 'forbidden')
    sendJson(res, 200, { ...personnelView(), canEdit: user.role === 'admin' })
  })
  router.post('/api/personnel/users', async (req, res) => {
    const { user } = auth(req)
    requireAdmin(user)
    const body = await readJson(req)
    let created
    try {
      created = db.createUser({ username: String(body.username ?? '').trim(), password: body.password, displayName: body.displayName, role: body.role ?? 'employee', department: body.department })
    } catch (err) {
      throw new HttpError(400, err.message)
    }
    drive.ensureOffice(created.username)
    console.log(`[gateway] ${user.username} 发了账号 ${created.username} (${ROLE_LABELS[created.role]}/${created.department})`)
    sendJson(res, 201, { user: publicUser(created), ...personnelView() })
  })
  router.patch('/api/personnel/users/:id', async (req, res) => {
    const { user } = auth(req)
    requireAdmin(user)
    const target = db.getUser(req.params.id)
    if (!target) throw new HttpError(404, '用户不存在')
    const body = await readJson(req)
    const patch = {}
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) throw new HttpError(400, '未知角色')
      if (target.seed && body.role !== 'admin') throw new HttpError(400, '种子管理员不能被降级', 'seed_protected')
      patch.role = body.role
    }
    if (body.department !== undefined) patch.department = String(body.department).trim() || '未分组'
    if (body.displayName !== undefined) patch.displayName = String(body.displayName).trim() || target.username
    if (body.disabled !== undefined) {
      if (target.seed && body.disabled) throw new HttpError(400, '种子管理员不能被停用', 'seed_protected')
      patch.disabled = !!body.disabled
      if (patch.disabled) {
        db.revokeGatewayTokens(target.id)
        db.revokeLoginSessions(target.id)
        presence.leave(target.id)
      }
    }
    if (body.weeklyQuotaCny !== undefined) db.updateUserSettings(target.id, { weeklyQuotaCny: body.weeklyQuotaCny === null ? undefined : Number(body.weeklyQuotaCny) })
    const updated = db.updateUser(target.id, patch)
    sendJson(res, 200, { user: publicUser(updated), ...personnelView() })
  })
  router.post('/api/personnel/users/:id/revoke-token', async (req, res) => {
    const { user } = auth(req)
    requireAdmin(user)
    const target = db.getUser(req.params.id)
    if (!target) throw new HttpError(404, '用户不存在')
    const count = db.revokeGatewayTokens(target.id)
    console.log(`[gateway] ${user.username} 吊销了 ${target.username} 的 ${count} 枚网关令牌（即时生效）`)
    sendJson(res, 200, { revoked: count, ...personnelView() })
  })
  router.post('/api/personnel/users/:id/reset-password', async (req, res) => {
    const { user } = auth(req)
    requireAdmin(user)
    const target = db.getUser(req.params.id)
    if (!target) throw new HttpError(404, '用户不存在')
    const body = await readJson(req)
    if (typeof body.password !== 'string' || body.password.length < 6) throw new HttpError(400, '密码至少 6 位')
    const { salt, hash } = hashPassword(body.password)
    db.updateUser(target.id, { passwordSalt: salt, passwordHash: hash })
    sendJson(res, 200, { ok: true })
  })
  router.get('/api/people', async (req, res) => {
    // 任务派发/审核人选择用的精简名单（全员可见：账号、姓名、角色、部门、在线）
    auth(req)
    sendJson(res, 200, { users: db.listUsers().filter((u) => !u.disabled).map((u) => ({ ...publicUser(u), online: isOnline(u) })) })
  })

  // ---------- 任务卡 ----------
  router.get('/api/tasks', async (req, res) => {
    const { user } = auth(req)
    sendJson(res, 200, { tasks: tasks.visibleTo(user).map((t) => tasks.view(t)), statuses: TASK_STATUS })
  })
  router.post('/api/tasks', async (req, res) => {
    const { user } = auth(req)
    const body = await readJson(req)
    const task = tasks.create(user, body)
    sendJson(res, 201, { task: tasks.view(task) })
  })
  router.get('/api/tasks/:id', async (req, res) => {
    const { user } = auth(req)
    const task = tasks.mustGet(req.params.id)
    if (!tasks.canView(task, user)) throw new HttpError(403, '无权查看该任务')
    sendJson(res, 200, { task: tasks.view(task) })
  })
  router.patch('/api/tasks/:id', async (req, res) => {
    const { user } = auth(req)
    const body = await readJson(req)
    sendJson(res, 200, { task: tasks.view(tasks.update(req.params.id, user, body)) })
  })
  router.post('/api/tasks/:id/log', async (req, res) => {
    const { user } = auth(req)
    const body = await readJson(req)
    sendJson(res, 200, { task: tasks.view(tasks.addLog(req.params.id, user, body)) })
  })
  router.post('/api/tasks/:id/sessions', async (req, res) => {
    const { user } = auth(req)
    const body = await readJson(req)
    sendJson(res, 200, { task: tasks.view(tasks.bindSession(req.params.id, user, body)) })
  })
  router.delete('/api/tasks/:id/sessions/:sessionId', async (req, res) => {
    const { user } = auth(req)
    sendJson(res, 200, { task: tasks.view(tasks.unbindSession(req.params.id, user, req.params.sessionId)) })
  })
  router.post('/api/tasks/:id/deliverables', async (req, res) => {
    const { user } = auth(req)
    const body = await readJson(req)
    sendJson(res, 200, { task: tasks.view(tasks.addDeliverables(req.params.id, user, body.files)) })
  })
  router.delete('/api/tasks/:id/deliverables/:name', async (req, res) => {
    const { user } = auth(req)
    sendJson(res, 200, { task: tasks.view(tasks.removeDeliverable(req.params.id, user, req.params.name)) })
  })
  router.get('/api/tasks/:id/deliverables/:name', async (req, res) => {
    const { user } = auth(req)
    const task = tasks.mustGet(req.params.id)
    if (!tasks.canView(task, user)) throw new HttpError(403, '无权查看该任务')
    const d = task.deliverables.find((x) => x.name === req.params.name)
    if (!d) throw new HttpError(404, '交付物不存在')
    const buf = drive.read(d.path)
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(d.name)}` })
    res.end(buf)
  })
  router.post('/api/tasks/:id/submit', async (req, res) => {
    const { user } = auth(req)
    const body = await readJson(req)
    const task = tasks.submit(req.params.id, user, body)
    console.log(`[gateway] ${user.username} 提交任务 ${task.id} 验收 → ${task.reviewerId}`)
    sendJson(res, 200, { task: tasks.view(task) })
  })
  router.post('/api/tasks/:id/review', async (req, res) => {
    const { user } = auth(req)
    const body = await readJson(req)
    if (!['pass', 'reject'].includes(body.decision)) throw new HttpError(400, 'decision 必须是 pass 或 reject')
    sendJson(res, 200, { task: tasks.view(tasks.review(req.params.id, user, body)) })
  })
  router.post('/api/tasks/:id/final', async (req, res) => {
    const { user } = auth(req)
    const body = await readJson(req)
    if (!['pass', 'reject'].includes(body.decision)) throw new HttpError(400, 'decision 必须是 pass 或 reject')
    sendJson(res, 200, { task: tasks.view(tasks.finalize(req.params.id, user, body)) })
  })

  // ---------- 公司盘 ----------
  router.get('/api/drive/list', async (req, res) => {
    const { user } = auth(req)
    const rel = parseUrl(req).searchParams.get('path') ?? ''
    if (rel && !drive.canRead(user, rel)) throw new HttpError(403, '无权访问该目录')
    let items = drive.list(rel)
    items = items.filter((it) => drive.canRead(user, it.path))
    sendJson(res, 200, { path: rel, items })
  })
  router.get('/api/drive/file', async (req, res) => {
    const { user } = auth(req)
    const rel = parseUrl(req).searchParams.get('path')
    if (!rel) throw new HttpError(400, '缺少 path')
    if (!drive.canRead(user, rel)) throw new HttpError(403, '无权读取该文件')
    const st = drive.stat(rel)
    if (!st.exists || st.isDir) throw new HttpError(404, '文件不存在')
    const buf = drive.read(rel)
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length, 'x-file-mtime': st.mtime })
    res.end(buf)
  })
  router.put('/api/drive/file', async (req, res) => {
    const { user } = auth(req)
    const url = parseUrl(req)
    const rel = url.searchParams.get('path')
    const append = url.searchParams.get('append') === '1'
    if (!rel) throw new HttpError(400, '缺少 path')
    const mode = drive.canWrite(user, rel)
    if (!mode) throw new HttpError(403, '无权写入该位置（共享区仅管理员/总监可写，员工只能追加到 05-logs）', 'forbidden')
    if (mode === 'append' && !append) throw new HttpError(403, '该位置只允许追加写入（append=1）', 'append_only')
    const data = await readBody(req)
    const info = drive.write(rel, data, { append })
    sendJson(res, 200, { file: info })
  })
  router.delete('/api/drive/file', async (req, res) => {
    const { user } = auth(req)
    const rel = parseUrl(req).searchParams.get('path')
    if (!rel) throw new HttpError(400, '缺少 path')
    if (drive.canWrite(user, rel) !== 'full') throw new HttpError(403, '无权删除')
    drive.remove(rel)
    sendJson(res, 200, { ok: true })
  })
  router.get('/api/drive/snapshot', async (req, res) => {
    const { user } = auth(req)
    // inbox 只同步与我有关的任务目录
    const myTasks = tasks.visibleTo(user).map((t) => `projects/inbox/${t.id}`)
    const files = drive.snapshot(user, ['_shared', `_office/${user.username}`, ...myTasks])
    sendJson(res, 200, { files, roots: { shared: '_shared', personal: `_office/${user.username}`, inbox: 'projects/inbox' }, memoryLayers: MEMORY_LAYERS })
  })

  // ---------- 知识检索（第四层通道：公司里有没有人做过）----------
  router.get('/api/knowledge/search', async (req, res) => {
    const { user } = auth(req)
    const url = parseUrl(req)
    const q = url.searchParams.get('q') ?? ''
    const limit = Number(url.searchParams.get('limit') ?? 20)
    const kinds = (url.searchParams.get('kinds') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (!knowledge) throw new HttpError(500, '知识检索模块未启用')
    sendJson(res, 200, knowledge.search(user, q, { limit: Number.isFinite(limit) ? limit : 20, kinds }))
  })
  router.get('/api/knowledge/collections', async (req, res) => {
    const { user } = auth(req)
    if (!knowledge) throw new HttpError(500, '知识检索模块未启用')
    sendJson(res, 200, { ...knowledge.collections(user), memoryLayers: MEMORY_LAYERS })
  })

  // ---------- 服务器状态（管理页）----------
  router.get('/api/status', async (req, res) => {
    const { user } = auth(req)
    if (user.role === 'employee') throw new HttpError(403, '服务器状态仅总监/管理员可见', 'forbidden')
    const users = db.listUsers()
    const all = tasks.all()
    const byStatus = {}
    for (const t of all) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1
    const zoneStats = (root) => {
      let files = 0
      let bytes = 0
      const walk = (rel) => {
        for (const it of drive.list(rel)) {
          if (it.isDir) walk(it.path)
          else {
            files++
            bytes += it.size
          }
        }
      }
      try {
        walk(root)
      } catch {
        /* 目录不存在 */
      }
      return { files, bytes }
    }
    const ledger7 = ledger.companyLedger(7)
    sendJson(res, 200, {
      company: companyView(),
      server: {
        version: cfg.version ?? '0.1.0',
        kernel: KERNEL_LABEL,
        startedAt: new Date(startedAt ?? Date.now()).toISOString(),
        uptimeSeconds: Math.floor((Date.now() - (startedAt ?? Date.now())) / 1000),
        publicUrl: cfg.publicUrl,
        dataDir: cfg.dataDir,
        driveRoot: db.driveRoot,
        time: new Date().toISOString(),
      },
      people: { total: users.length, active: users.filter((u) => !u.disabled).length, online: users.filter((u) => isOnline(u)).length, tokensActive: users.filter((u) => !!db.activeGatewayToken(u.id)).length },
      tasks: { total: all.length, byStatus, labels: TASK_STATUS },
      drive: { shared: zoneStats('_shared'), office: zoneStats('_office'), inbox: zoneStats('projects/inbox') },
      ledger7d: { totalCny: ledger7.totalCny, requests: ledger7.requests },
      channels: channels?.view() ?? [],
      models: models().map(({ compat: _c, upstreamModel: _u, ...m }) => m),
    })
  })

  // ---------- 公司/订阅/快速推理 ----------
  router.get('/api/company', async (req, res) => {
    const { user } = auth(req)
    sendJson(res, 200, { company: companyView(), canEdit: user.role === 'admin' })
  })
  router.patch('/api/company', async (req, res) => {
    const { user } = auth(req)
    requireAdmin(user)
    const body = await readJson(req)
    const patch = {}
    for (const key of ['name', 'plan', 'seats', 'weeklyQuotaCny', 'quotaAnchor', 'defaultModel', 'quickInferenceModel']) if (body[key] !== undefined) patch[key] = body[key]
    if (body.quotaByRole) patch.quotaByRole = { ...(db.companySettings().quotaByRole ?? {}), ...body.quotaByRole }
    if (patch.quotaAnchor !== undefined && !Number.isFinite(Date.parse(patch.quotaAnchor))) throw new HttpError(400, '额度刷新锚点不是合法时间')
    db.updateCompanySettings(patch)
    sendJson(res, 200, { company: companyView() })
  })
  router.get('/api/quick-inference', async (req, res) => {
    const { user } = auth(req)
    const s = db.userSettings(user.id)
    const recent = ledger.entriesSince(Date.now() - 7 * 86400_000, (e) => e.userId === user.id && e.tag === 'quick-inference')
    sendJson(res, 200, {
      model: s.quickInferenceModel ?? companyView().quickInferenceModel,
      companyDefault: companyView().quickInferenceModel,
      models: models().map((m) => ({ id: m.id, name: m.name, provider: m.provider, providerLabel: m.providerLabel })),
      recent: recent.slice(-20).reverse(),
    })
  })
  router.patch('/api/quick-inference', async (req, res) => {
    const { user } = auth(req)
    const body = await readJson(req)
    if (body.model !== undefined) {
      if (body.model !== null && !models().some((m) => m.id === body.model)) throw new HttpError(400, '模型不在目录里')
      db.updateUserSettings(user.id, { quickInferenceModel: body.model ?? undefined })
    }
    sendJson(res, 200, { model: db.userSettings(user.id).quickInferenceModel ?? companyView().quickInferenceModel })
  })
  router.post('/api/quick-inference/run', async (req, res) => {
    const { user } = auth(req)
    const body = await readJson(req)
    const prompt = String(body.prompt ?? '').trim()
    if (!prompt) throw new HttpError(400, '请输入内容')
    const modelId = body.model ?? db.userSettings(user.id).quickInferenceModel ?? companyView().quickInferenceModel
    const result = await proxy.completeOnce(user, modelId, [
      { role: 'system', content: '你是公司内部的快速推理助手，回答简洁、直接，不超过 200 字。' },
      { role: 'user', content: prompt },
    ])
    sendJson(res, 200, { ...result, costCny: ledger.entriesSince(Date.now() - 60_000, (e) => e.userId === user.id).at(-1)?.costCny ?? 0 })
  })
  router.get('/api/ledger', async (req, res) => {
    const { user } = auth(req)
    const days = Number(parseUrl(req).searchParams.get('days') ?? 7)
    const since = Date.now() - days * 86400_000
    const entries = ledger.entriesSince(since, (e) => user.role === 'admin' || e.userId === user.id)
    sendJson(res, 200, { days, entries: entries.slice(-500).reverse() })
  })
}
