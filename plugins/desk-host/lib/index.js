/**
 * @company-desk/desk-host —— 企业交付工作台的本机 Host 插件。
 *
 * - 登录公司网关：拿到本人的登录会话令牌 + 网关令牌；把网关注册为 llm-pi-ai 的一条模型路由
 *   （baseURL = 网关 /v1，apiKeyEnv = DESK_GATEWAY_TOKEN），模型真实密钥从不下发到本机。
 * - /desk/api/*：给浏览器端 UI 用的本机接口（登录态、代理网关业务接口、窗口产物、本地文件附加）。
 * - 公司盘镜像：共享经验 / 个人记忆 / 相关任务收件箱同步到本机，Agent 用普通文件工具即可读。
 * - Agent 工具：company_memory_*、company_task_*；系统提示注入公司盘约定与当前任务卡。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DeskState } from './state.js'
import { GatewayClient, GatewayError } from './gateway-client.js'
import { DriveMirror } from './drive-mirror.js'
import { ProducedIndex } from './produced.js'
import { fetchKernelUpdate, readLocalKernelVersion, resolvePendingDir } from './kernel-update.js'
import { discoverGateways } from './lan-discover.js'
import { portFromUrl } from '../../../scripts/lib/lan-protocol.mjs'

export const name = 'desk-host'
export const inject = ['webServer', 'settings', 'credentials', 'tools', 'systemPrompt', 'sessions', 'agentDefaultModel', 'workspaceRegistry']

export const Config = z.object({
  /** 默认网关地址（登录界面可改）。 */
  gatewayUrl: z.string().default('http://127.0.0.1:8790'),
  /** 本机状态目录（desk-state.json、produced-index.json、drive 镜像）；留空 = $DSH_HOME/desk。 */
  stateDir: z.string().default(''),
  /** 注册到 llm-pi-ai 的路由 id。 */
  providerId: z.string().default('desk-gateway'),
  /** 路由显示名。 */
  providerName: z.string().default('valimart harness 公司网关'),
  /** 网关令牌的凭据引用名（环境变量风格）。 */
  credentialName: z.string().default('DESK_GATEWAY_TOKEN'),
  /** 心跳/同步周期（毫秒）。 */
  heartbeatMs: z.number().default(30_000),
})

const CREDENTIAL_SCOPE_NS = 'llm-pi-ai'
const TASK_CARD_FILES = new Set(['_task-card.json', '_task-card.md', '_worklog.md'])

export function apply(ctx, config) {
  const stateDir = path.resolve(config.stateDir || process.env.DESK_STATE_DIR || path.join(resolveDshHome(), 'desk'))
  fs.mkdirSync(stateDir, { recursive: true })
  const log = (msg) => console.log(`[desk-host] ${msg}`)
  const state = new DeskState(stateDir)
  state.data.driveDir = path.join(stateDir, 'drive')
  state.data.device = `${os.hostname()} (${os.platform()})`
  // 未登录时以 profile 配置的网关地址为准（登录界面仍可改）；登录态里保留登录时实际使用的地址。
  if (!state.data.gatewayUrl || !state.loggedIn) state.data.gatewayUrl = config.gatewayUrl
  state.save()
  const gateway = new GatewayClient(state)
  const mirror = new DriveMirror({ root: state.data.driveDir, gateway, state, log })
  const produced = new ProducedIndex(stateDir)
  const credential = credentialRef(config.credentialName)

  // ---------- 会话事件：窗口产物索引 ----------
  ctx.on('session/event', (session, event) => {
    try {
      produced.observe(session, event)
    } catch (err) {
      log(`产物索引失败: ${err.message}`)
    }
  })

  // ---------- 模型路由：登录后把网关写成 llm-pi-ai 的一条 provider ----------
  /** llm-pi-ai 要求 reasoningEfforts 是 false 或 { 档位: 上游取值 } 的映射；网关目录里允许写成数组。 */
  const REASONING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  function normalizeEfforts(v) {
    if (Array.isArray(v)) v = Object.fromEntries(v.filter((e) => typeof e === 'string').map((e) => [e, e]))
    if (!v || typeof v !== 'object') return false
    const out = {}
    for (const [k, val] of Object.entries(v)) if (REASONING_LEVELS.has(k) && typeof val === 'string') out[k] = val
    return Object.keys(out).length ? out : false
  }

  /** 路由 id：公司网关下每个上游厂商一条（模型选择器按厂商分组：DeepSeek / Grok / …）。 */
  const routeIdOf = (provider) => `${config.providerId}-${String(provider ?? 'default').replace(/[^A-Za-z0-9_-]/g, '_')}`
  const isOurRoute = (id) => typeof id === 'string' && (id === config.providerId || id.startsWith(`${config.providerId}-`))
  /** 当前 llm-pi-ai 设置里属于公司网关的路由 id（含旧版单路由），用于清理下架的厂商。 */
  const ourRouteIds = () => Object.keys(ctx.settings.get?.(CREDENTIAL_SCOPE_NS)?.providers ?? {}).filter(isOurRoute)

  async function configureLlmRoute(company, gatewayToken) {
    // 按上游厂商分组；公司目录里模型自带 provider / providerLabel
    const groups = new Map()
    for (const m of company.models ?? []) {
      const key = m.provider ?? 'default'
      if (!groups.has(key)) groups.set(key, { label: m.providerLabel ?? m.provider ?? config.providerName, models: [] })
      groups.get(key).models.push({
        id: m.id,
        name: `${m.name}`,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        reasoningEfforts: normalizeEfforts(m.reasoningEfforts),
      })
    }
    // 网关对外统一是 OpenAI 兼容 + deepseek 思维链格式（其他厂商由网关在服务端转换）
    const compat = {
      thinkingFormat: 'deepseek',
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      supportsStore: false,
      requiresReasoningContentOnAssistantMessages: true,
    }
    await ctx.credentials.set(credential, gatewayToken)
    const providers = {}
    const routeOfModel = new Map()
    for (const [provider, g] of groups) {
      const rid = routeIdOf(provider)
      providers[rid] = {
        displayName: g.label,
        apiKeyEnv: config.credentialName,
        api: 'openai-completions',
        baseURL: `${gateway.baseUrl}/v1`,
        compat,
        models: g.models,
      }
      for (const m of g.models) routeOfModel.set(m.id, rid)
    }
    // 先清掉不再存在的旧路由（厂商下架 / 旧版单路由），再写入当前分组
    const stale = ourRouteIds().filter((id) => !(id in providers))
    if (stale.length) await ctx.settings.mutate(CREDENTIAL_SCOPE_NS, stale.map((id) => ({ op: 'unset', path: ['providers', id] })))
    if (Object.keys(providers).length) await ctx.settings.update(CREDENTIAL_SCOPE_NS, { providers })
    const allModels = [...routeOfModel.keys()]
    const defaultModel = company.defaultModel && routeOfModel.has(company.defaultModel) ? company.defaultModel : allModels[0]
    if (defaultModel && ctx.agentDefaultModel) {
      try {
        // 已经选在公司网关的某个仍然存在的模型上就不动它（目录刷新不打断用户的选择）
        const cur = ctx.agentDefaultModel.currentSelection?.()
        const keep = cur && isOurRoute(cur.provider) && routeOfModel.get(cur.model) === cur.provider
        if (!keep) await ctx.agentDefaultModel.saveSelection({ provider: routeOfModel.get(defaultModel), model: defaultModel })
      } catch (err) {
        log(`设置默认模型失败: ${err.message}`)
      }
    }
    log(`模型路由已配置 → ${gateway.baseUrl}/v1：${[...groups.values()].map((g) => `${g.label}[${g.models.map((m) => m.id).join(', ')}]`).join('；') || '（公司目录为空）'}`)
  }

  async function removeLlmRoute() {
    try {
      const ids = ourRouteIds()
      if (ids.length) await ctx.settings.mutate(CREDENTIAL_SCOPE_NS, ids.map((id) => ({ op: 'unset', path: ['providers', id] })))
    } catch (err) {
      log(`移除模型路由失败: ${err.message}`)
    }
    try {
      await ctx.credentials.unset(credential)
    } catch (err) {
      log(`移除网关令牌失败: ${err.message}`)
    }
  }

  // ---------- 工作区：「个人」= 我的格子 _office/<me>，「团队」= 公司盘 projects ----------
  async function ensureWorkspaces() {
    const me = state.data.user?.username
    if (!me || !ctx.workspaceRegistry) return
    const personal = mirror.abs(`_office/${me}`)
    const team = mirror.abs('projects')
    fs.mkdirSync(personal, { recursive: true })
    fs.mkdirSync(path.join(team, 'inbox'), { recursive: true })
    const wanted = [
      { key: 'personal', path: personal, title: '个人' },
      { key: 'team', path: team, title: '团队' },
    ]
    const found = {}
    for (const w of wanted) {
      try {
        const entity = await ctx.workspaceRegistry.create(w.path, w.title)
        if (entity.title !== w.title && typeof entity.setTitle === 'function') await entity.setTitle(w.title)
        found[w.key] = entity.id
      } catch (err) {
        log(`工作区「${w.title}」创建失败: ${err.message}`)
      }
    }
    // 一人一座：同一台电脑上换人登录，前一个人的「个人」格子从工作区列表摘掉（目录与会话日志都保留，
    // 那个人再登录时 create() 会按同一路径重新挂回来）——列表里永远只有当前登录者的「个人」
    try {
      const norm = (p) => path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      const officeRoot = norm(mirror.abs('_office')) + '/'
      const mine = norm(personal)
      for (const w of ctx.workspaceRegistry.list()) {
        const p = norm(w.path)
        if (p.startsWith(officeRoot) && p !== mine && !Object.values(found).includes(w.id)) {
          await ctx.workspaceRegistry.delete(w.id)
          log(`已收起他人的个人工作区：${w.path}`)
        }
      }
    } catch (err) {
      log(`收起他人个人工作区失败: ${err.message}`)
    }
    // 「个人」置顶，「团队」紧随其后，其余工作区排在后面
    try {
      const ours = wanted.map((w) => found[w.key]).filter(Boolean)
      const firstOther = ctx.workspaceRegistry.list().map((w) => w.id).find((id) => !ours.includes(id))
      for (const id of ours) await ctx.workspaceRegistry.insertBefore(id, firstOther)
    } catch {
      /* 排序失败不影响使用 */
    }
    state.data.workspaces = { personal: found.personal ?? null, team: found.team ?? null }
    state.save()
  }

  async function syncAll() {
    await mirror.sync()
    await ensureWorkspaces()
  }

  function scheduleKernelUpdate() {
    fetchKernelUpdate({
      gateway,
      pendingDir: resolvePendingDir(),
      localVersion: readLocalKernelVersion(),
      log: (msg) => log(`内核更新: ${msg}`),
    }).catch((err) => log(`内核更新失败: ${err.message}`))
  }

  // ---------- 登录 / 登出 / 心跳 ----------
  async function login({ gatewayUrl, username, password }) {
    const url = (gatewayUrl || state.data.gatewayUrl || config.gatewayUrl).replace(/\/+$/, '')
    state.data.gatewayUrl = url
    const result = await gateway.post('/api/auth/login', { username, password, device: state.data.device }, { token: null })
    state.setLogin({ gatewayUrl: url, sessionToken: result.sessionToken, gatewayToken: result.gatewayToken, user: result.user, company: result.company, quota: result.quota })
    state.data.lastHeartbeatOk = true
    state.data.lastHeartbeatAt = new Date().toISOString()
    state.save()
    await configureLlmRoute(result.company, result.gatewayToken)
    try {
      await syncAll()
    } catch (err) {
      log(`公司盘同步失败: ${err.message}`)
    }
    log(`已登录 ${result.user.username}（${result.user.roleLabel} · ${result.user.department}）`)
    scheduleKernelUpdate()
    return state.publicView()
  }

  async function completeSetup({ gatewayUrl, companyName, admin, colleagues, device }) {
    const url = (gatewayUrl || state.data.gatewayUrl || config.gatewayUrl).replace(/\/+$/, '')
    state.data.gatewayUrl = url
    const result = await gateway.post('/api/setup', { companyName, admin, colleagues, device: device ?? state.data.device }, { token: null })
    state.setLogin({ gatewayUrl: url, sessionToken: result.sessionToken, gatewayToken: result.gatewayToken, user: result.user, company: result.company, quota: result.quota })
    state.data.lastHeartbeatOk = true
    state.data.lastHeartbeatAt = new Date().toISOString()
    state.save()
    await configureLlmRoute(result.company, result.gatewayToken)
    try {
      await syncAll()
    } catch (err) {
      log(`公司盘同步失败: ${err.message}`)
    }
    log(`初始设置完成，已登录 ${result.user.username}`)
    scheduleKernelUpdate()
    return state.publicView()
  }

  async function logout() {
    if (state.loggedIn) {
      try {
        await gateway.post('/api/auth/logout', {})
      } catch {
        /* 网关不可达也允许本地登出 */
      }
    }
    await removeLlmRoute()
    state.clearLogin(null)
    log('已登出')
    return state.publicView()
  }

  /** 本机缓存的公司模型目录签名（与网关 /api/presence 返回的 modelsSignature 同一算法）。 */
  const localModelsSignature = () => JSON.stringify(state.data.company?.models ?? [])

  /** 公司模型目录变了（管理员接入/断开通道）→ 拉一次 /auth/me，重写本机路由。 */
  async function refreshCompanyCatalog(reason) {
    const me = await gateway.get('/api/auth/me')
    state.data.user = me.user
    state.data.company = me.company
    state.data.quota = me.quota
    state.save()
    if (me.gatewayTokenActive !== false && state.data.gatewayToken) {
      log(`公司模型目录已更新（${reason}），重写本机模型路由`)
      await configureLlmRoute(me.company, state.data.gatewayToken)
    }
  }

  async function heartbeat() {
    if (!state.loggedIn) return
    try {
      const r = await gateway.post('/api/presence', {})
      state.data.quota = r.quota
      state.data.lastHeartbeatOk = true
      state.data.lastHeartbeatAt = new Date().toISOString()
      if (r.gatewayTokenActive === false && !state.data.needsRelogin) {
        state.data.needsRelogin = true
        state.data.lastError = '这台电脑的网关令牌已失效（管理员吊销或已在别处重置），请重新登录以获取新令牌'
        log('本机网关令牌已失效')
      }
      state.save()
      // 管理员在网关上接入/断开了通道：不用等界面刷新，一个心跳内全员的模型菜单就跟着变
      if (typeof r.modelsSignature === 'string' && r.modelsSignature !== localModelsSignature() && r.gatewayTokenActive !== false) {
        await refreshCompanyCatalog('心跳发现目录签名变化').catch((err) => log(`刷新模型路由失败: ${err.message}`))
      }
    } catch (err) {
      state.data.lastHeartbeatOk = false
      if (err instanceof GatewayError && (err.status === 401 || err.status === 403)) {
        await removeLlmRoute()
        state.clearLogin(err.status === 403 ? '账号已停用' : '登录已失效，请重新登录')
      } else state.save()
    }
  }

  // 启动时：若有登录态，刷新一次路由与镜像（令牌被吊销则提示重登）
  ctx.effect(() => {
    let stopped = false
    ;(async () => {
      if (!state.loggedIn) return
      try {
        const me = await gateway.get('/api/auth/me')
        state.data.user = me.user
        state.data.company = me.company
        state.data.quota = me.quota
        state.data.lastHeartbeatOk = true
        state.data.lastHeartbeatAt = new Date().toISOString()
        if (me.gatewayTokenActive === false || !state.data.gatewayToken) {
          state.data.needsRelogin = true
          state.data.lastError = '网关令牌已失效，请重新登录'
        } else {
          await configureLlmRoute(me.company, state.data.gatewayToken)
        }
        state.save()
        syncAll().catch((err) => log(`公司盘同步失败: ${err.message}`))
        scheduleKernelUpdate()
      } catch (err) {
        if (err instanceof GatewayError && (err.status === 401 || err.status === 403)) state.clearLogin('登录已失效，请重新登录')
        else log(`启动校验失败（网关可能未启动）: ${err.message}`)
      }
    })()
    const timer = setInterval(() => {
      if (stopped) return
      heartbeat().catch(() => {})
      if (state.loggedIn) mirror.sync().catch(() => {})
    }, config.heartbeatMs)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, 'desk-host: heartbeat')

  // ---------- 任务卡辅助 ----------
  async function fetchTask(taskId) {
    const r = await gateway.get(`/api/tasks/${encodeURIComponent(taskId)}`)
    mirror.writeTaskCard(r.task)
    return r.task
  }

  async function attachLocalFiles(taskId, paths, { sessionId, source = 'manual' } = {}) {
    const files = []
    for (const p of paths) {
      const full = path.resolve(p)
      const st = fs.statSync(full)
      if (!st.isFile()) throw new Error(`${p} 不是文件`)
      if (st.size > 50 * 1024 * 1024) throw new Error(`${p} 超过 50MB`)
      files.push({ name: path.basename(full), dataBase64: fs.readFileSync(full).toString('base64'), source, sessionId: sessionId ?? null, localPath: full })
    }
    const r = await gateway.post(`/api/tasks/${encodeURIComponent(taskId)}/deliverables`, { files })
    mirror.writeTaskCard(r.task)
    mirror.pull().catch(() => {})
    return r.task
  }

  function sessionIdOf(exec) {
    const agent = exec?.agent
    return agent?.session?.id ?? agent?.id
  }

  function resolveTaskId(exec, explicit) {
    if (explicit) return explicit
    const sid = sessionIdOf(exec)
    const bound = state.taskOfSession(sid ? String(sid) : undefined)
    if (!bound) throw new Error('当前进程没有绑定任务卡：请在任务页打开任务进程，或显式传 taskId')
    return bound
  }

  function zoneRoot(zone) {
    const me = state.data.user?.username
    if (!me) throw new Error('未登录公司网关')
    if (zone === 'personal') return `_office/${me}/_memory`
    if (zone === 'shared') return '_shared/_memory'
    if (zone === 'handbook') return '_shared/handbook'
    throw new Error(`未知 zone ${zone}`)
  }

  // ---------- Agent 工具 ----------
  const textOut = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }
  ctx.tools.register(
    defineTool({
      name: 'company_memory_write',
      description:
        '把经验/方法/证据/复盘写进公司盘记忆（Markdown）。zone=personal 写到自己的椅子 _office/<账号>/_memory（跟人走，换电脑还在）；zone=shared 写到公司共享经验 _shared/_memory（全员只读；总监/管理员可写，普通员工只能追加到 05-logs）。path 是相对 _memory 的路径，按层放：01-projects 项目、02-methods 方法、03-evidence 证据、04-reviews 复盘、05-logs 日志（追加）、90-system 系统/规定（追加）。',
      parameters: {
        zone: { type: 'string', required: true, enum: ['personal', 'shared'], description: 'personal（个人记忆）或 shared（公司共享）' },
        path: { type: 'string', required: true, description: '相对 _memory 的文件路径，如 02-methods/详情页模块顺序.md' },
        content: { type: 'string', required: true, description: 'Markdown 正文' },
        append: { type: 'boolean', description: '追加而不是覆盖（05-logs / 90-system 必须追加）' },
      },
      output: textOut,
      async execute(args) {
        const rel = `${zoneRoot(args.zone)}/${args.path.replace(/^\/+/, '')}`
        const append = !!args.append || /^(05-logs|90-system)\//.test(args.path)
        const r = await gateway.put(`/api/drive/file?path=${encodeURIComponent(rel)}${append ? '&append=1' : ''}`, Buffer.from(args.content, 'utf8'), { raw: true, headers: { 'content-type': 'application/octet-stream' } })
        const local = mirror.abs(rel)
        fs.mkdirSync(path.dirname(local), { recursive: true })
        if (append) fs.appendFileSync(local, args.content)
        else fs.writeFileSync(local, args.content)
        return `已写入公司盘 ${r.file.path}（${r.file.size} 字节）${append ? '（追加）' : ''}；本机镜像 ${local}`
      },
      presentCall: (args) => ({ card: 'generic', title: `写入公司记忆 ${args.zone}/${args.path}`, kind: 'edit', rawInput: args }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'company_memory_read',
      description: '读取公司盘记忆文件。zone=personal 读自己的 _office/<账号>/_memory；zone=shared 读 _shared/_memory；zone=handbook 读岗位手册/公司技能手册。',
      parameters: {
        zone: { type: 'string', required: true, enum: ['personal', 'shared', 'handbook'] },
        path: { type: 'string', required: true, description: '相对该区的文件路径' },
      },
      output: textOut,
      async execute(args) {
        const rel = `${zoneRoot(args.zone)}/${args.path.replace(/^\/+/, '')}`
        const buf = await gateway.get(`/api/drive/file?path=${encodeURIComponent(rel)}`)
        return Buffer.isBuffer(buf) ? buf.toString('utf8') : JSON.stringify(buf)
      },
      isConcurrencySafe: () => true,
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'company_memory_list',
      description: '列出公司盘记忆目录（personal / shared / handbook）。',
      parameters: {
        zone: { type: 'string', required: true, enum: ['personal', 'shared', 'handbook'] },
        path: { type: 'string', description: '相对该区的子目录，默认根' },
      },
      output: textOut,
      async execute(args) {
        const rel = `${zoneRoot(args.zone)}${args.path ? `/${args.path.replace(/^\/+/, '')}` : ''}`
        const r = await gateway.get(`/api/drive/list?path=${encodeURIComponent(rel)}`)
        if (!r.items.length) return `${rel}/ 为空`
        return r.items.map((it) => `${it.isDir ? '📁' : '📄'} ${it.path}${it.isDir ? '' : ` (${it.size} B, ${it.mtime})`}`).join('\n')
      },
      isConcurrencySafe: () => true,
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'company_knowledge',
      description:
        '企业知识库的第四层通道——检索：开工前先问「公司里有没有人做过」。在公司盘（岗位手册 / 共享经验 / 你的个人记忆 / 与你有关的任务格子）和任务卡（标题 / 任务内容 / 提交内容 / 工作日志 / 交付物名）里按关键词搜，只返回谁、什么时候、在哪、一小段上下文；不拷贝任何会话。要细节就读那张任务卡（company_task_read）或去问任务卡旁边的进程。',
      parameters: {
        query: { type: 'string', required: true, description: '关键词，空格分隔多个词，如「详情页 模块顺序」' },
        kinds: { type: 'array', items: { type: 'string', enum: ['handbook', 'shared', 'personal', 'deliverable', 'task'] }, description: '只搜某几类；缺省全搜' },
        limit: { type: 'number', description: '最多返回条数，默认 20' },
      },
      output: textOut,
      async execute(args) {
        const qs = new URLSearchParams({ q: String(args.query ?? ''), limit: String(args.limit ?? 20) })
        if (Array.isArray(args.kinds) && args.kinds.length) qs.set('kinds', args.kinds.join(','))
        const r = await gateway.get(`/api/knowledge/search?${qs}`)
        if (!r.hits?.length) return `公司里没有人做过「${r.query}」（扫描了 ${r.scanned?.files ?? 0} 个文件、${r.scanned?.tasks ?? 0} 张任务卡）。可以直接开工，做完把方法写进公司记忆。`
        const lines = r.hits.map((h, i) => {
          const head = `${i + 1}. [${h.kindLabel}] ${h.title}${h.statusLabel ? `（${h.statusLabel}）` : ''}`
          const meta = [h.who ? `谁：${h.who}` : null, `何时：${h.when}`, `在哪：${h.path}`, h.taskId ? `任务卡：${h.taskId}` : null, h.deliverables?.length ? `交付物：${h.deliverables.join('、')}` : null].filter(Boolean).join(' · ')
          return `${head}\n   ${meta}\n   ${h.snippet}`
        })
        return `公司里做过「${r.query}」的记录 ${r.hits.length} 条（扫描 ${r.scanned?.files ?? 0} 个文件、${r.scanned?.tasks ?? 0} 张任务卡）：\n${lines.join('\n')}`
      },
      isConcurrencySafe: () => true,
      presentCall: (args) => ({ card: 'generic', title: `检索公司知识库：${args.query}`, kind: 'search', rawInput: args }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'company_task_read',
      description: '读取任务卡（工单）：派单人/提交人/状态/任务内容/提交内容/交付物/关联进程/工作日志。不传 taskId 时读取当前进程绑定的任务卡。',
      parameters: { taskId: { type: 'string', description: '任务 ID，如 tk-5a62a55642；缺省为当前进程绑定的任务' } },
      output: textOut,
      async execute(args, exec) {
        const id = resolveTaskId(exec, args.taskId)
        const task = await fetchTask(id)
        return JSON.stringify(task, null, 2)
      },
      isConcurrencySafe: () => true,
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'company_task_log',
      description: '往任务卡的工作日志追加一条记录（做了什么、改了几版、为什么这样改）。不传 taskId 时写当前进程绑定的任务。',
      parameters: {
        text: { type: 'string', required: true, description: '日志正文（一两句话）' },
        taskId: { type: 'string' },
      },
      output: textOut,
      async execute(args, exec) {
        const id = resolveTaskId(exec, args.taskId)
        const sid = sessionIdOf(exec)
        const r = await gateway.post(`/api/tasks/${encodeURIComponent(id)}/log`, { text: args.text, kind: 'agent', sessionId: sid ? String(sid) : null })
        mirror.writeTaskCard(r.task)
        return `已记录到任务 ${id} 的工作日志（共 ${r.task.log.length} 条）`
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'company_task_update',
      description: '更新任务卡文本：把成果说明写进「提交内容」（submission），或补充「任务内容」（content）。不传 taskId 时写当前进程绑定的任务。',
      parameters: {
        submission: { type: 'string', description: '提交内容（做了什么、交了什么）' },
        content: { type: 'string', description: '任务内容' },
        taskId: { type: 'string' },
      },
      output: textOut,
      async execute(args, exec) {
        const id = resolveTaskId(exec, args.taskId)
        const sid = sessionIdOf(exec)
        const patch = { sessionId: sid ? String(sid) : null }
        if (args.submission !== undefined) Object.assign(patch, { submission: args.submission, adopt: 'submission' })
        if (args.content !== undefined) Object.assign(patch, { content: args.content, adopt: patch.adopt ?? 'content' })
        const r = await gateway.patch(`/api/tasks/${encodeURIComponent(id)}`, patch)
        mirror.writeTaskCard(r.task)
        return `任务 ${id} 已更新（状态 ${r.task.statusLabel}）`
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'company_task_attach',
      description: '把本机文件作为交付物挂到任务卡（上传到公司盘 projects/inbox/<任务ID>/）。口头完成不算完成——提交验收前必须至少挂一个交付物。不传 taskId 时挂到当前进程绑定的任务。',
      parameters: {
        paths: { type: 'array', required: true, items: { type: 'string' }, description: '本机文件绝对路径列表' },
        taskId: { type: 'string' },
      },
      output: textOut,
      async execute(args, exec) {
        const id = resolveTaskId(exec, args.taskId)
        const sid = sessionIdOf(exec)
        const task = await attachLocalFiles(id, args.paths, { sessionId: sid ? String(sid) : null, source: 'agent' })
        return `已挂载 ${args.paths.length} 个交付物到任务 ${id}：${task.deliverables.map((d) => d.name).join('、')}`
      },
      presentCall: (args) => ({ card: 'generic', title: `挂载交付物到任务卡`, kind: 'other', rawInput: args }),
    }),
  )

  // ---------- 系统提示：公司盘约定 + 当前任务卡 ----------
  ctx.systemPrompt.section({
    name: 'desk:company',
    order: 60,
    text: () => {
      if (!state.loggedIn) return ''
      const u = state.data.user
      const c = state.data.company
      return [
        `## 企业交付工作台（${c?.name ?? '公司'}）`,
        `你在为 ${u.displayName}（账号 ${u.username}，${u.roleLabel}，${u.department}）工作，通过公司网关使用模型，用量按人记账。`,
        `公司盘本机镜像：${state.data.driveDir}`,
        `- _shared/_memory/ 共享经验（全员只读；01-projects 项目、02-methods 方法、03-evidence 证据、04-reviews 复盘、05-logs 日志(追加)、90-system 系统/规定(追加)）`,
        `- _shared/handbook/ 岗位手册 / 公司技能手册：地图上的 how 已经是结论，有就按那条做，没有就说明没有。`,
        `- _office/${u.username}/_memory/ 你的个人记忆（跟人走）。值得复用的做法、踩过的坑，用 company_memory_write 写进去。`,
        `- projects/inbox/<任务ID>/ 任务交付物；每个任务目录里的 _task-card.md / _worklog.md 是任务卡与工作日志。`,
        `- 第四层是检索，不是知识库本身：开工前用 company_knowledge 问「公司里有没有人做过」，只拿到谁/何时/在哪，不拷贝别人的会话；细节去读那张任务卡。`,
        `规则：口头完成不算完成——交付必须是文件，用 company_task_attach 挂到任务卡；做完把结论写进提交内容（company_task_update），过程记进工作日志（company_task_log）。`,
      ].join('\n')
    },
  })

  ctx.systemPrompt.context({
    name: 'desk:task',
    order: 10,
    text: (context) => {
      const scope = context?.scope
      const sid = scope?.session?.id ?? scope?.id ?? scope?.agent?.id
      const taskId = state.taskOfSession(sid ? String(sid) : undefined)
      if (!taskId) return ''
      const dir = mirror.taskDir(taskId)
      const head = [
        `当前进程绑定任务卡 ${taskId}。任务格子（本机目录）：${dir}`,
        `- 交付物文件一律写到这个目录里，再用 company_task_attach 挂到任务卡；结论写进提交内容（company_task_update），过程记进工作日志（company_task_log）。`,
        `- 可用 company_task_read 获取任务卡最新状态。`,
      ].join('\n')
      try {
        const card = fs.readFileSync(path.join(dir, '_task-card.md'), 'utf8')
        return `${head}\n\n${card}`
      } catch {
        return head
      }
    },
  })

  // ---------- /desk/api ----------
  const json = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }
  const readJson = async (req) => {
    // 盲 CSRF 常用 text/plain 发简单请求：非 JSON 内容类型直接 415，别把任意文本当 JSON 解析
    const ct = String(req.headers['content-type'] ?? '')
    if (ct && !ct.includes('application/json') && !ct.includes('text/json')) {
      throw Object.assign(new Error('请求体必须是 application/json'), { status: 415, code: 'bad_content_type' })
    }
    const chunks = []
    for await (const c of req) chunks.push(c)
    const text = Buffer.concat(chunks).toString('utf8')
    try {
      return text ? JSON.parse(text) : {}
    } catch {
      throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400, code: 'bad_json' })
    }
  }
  const fail = (res, err, opts = {}) => {
    const status = err instanceof GatewayError ? (err.status || 502) : err.status ?? 500
    // 默认：网关 401 就认为登录失效（吊销/过期），清登录态、拆模型路由。
    // 登录/首次设置路由传 keepLogin：输错密码只是本次失败，不能连坐清掉仍有效的旧会话。
    if (!opts.keepLogin && err instanceof GatewayError && err.status === 401 && state.loggedIn) {
      state.clearLogin('登录已失效，请重新登录')
      removeLlmRoute().catch(() => {})
    }
    json(res, status, { error: { message: err.message, code: err.code ?? 'error' } })
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/desk/api',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const rel = url.pathname.replace(/^\/desk\/api/, '') || '/'
          const method = req.method ?? 'GET'
          try {
            // /desk/api 只服务本机工作台页面：他源/跨站请求一律拒绝。
            // 盲 CSRF 能从浏览器网页打到 http://127.0.0.1 的本机接口（attach-local 上传本机文件、/open 拉资源管理器、/gw 改数据）
            const secFetch = String(req.headers['sec-fetch-site'] ?? '')
            if (secFetch && secFetch !== 'same-origin' && secFetch !== 'same-site' && secFetch !== 'none') {
              return json(res, 403, { error: { message: '跨站请求被拒绝', code: 'bad_origin' } })
            }
            const origin = req.headers['origin']
            if (origin && (!req.headers['host'] || String(new URL(origin).host) !== String(req.headers['host']))) {
              return json(res, 403, { error: { message: '跨源请求被拒绝', code: 'bad_origin' } })
            }
            if (method === 'GET' && rel === '/state') return json(res, 200, state.publicView())
            if (method === 'GET' && rel === '/discover') {
              const want = url.searchParams.get('gatewayUrl')
              const last = (want || state.data.gatewayUrl || config.gatewayUrl || '').replace(/\/+$/, '')
              const r = await discoverGateways({
                lastUrl: last,
                defaultPort: portFromUrl(last, 8790),
              })
              if (!state.loggedIn && r.picked) {
                state.data.gatewayUrl = r.picked.replace(/\/+$/, '')
                state.save()
              }
              return json(res, 200, r)
            }
            if (method === 'GET' && rel === '/setup') {
              const want = url.searchParams.get('gatewayUrl')
              if (want) state.data.gatewayUrl = want.replace(/\/+$/, '')
              const r = await gateway.get('/api/setup', { token: null })
              return json(res, 200, r)
            }
            if (method === 'POST' && rel === '/setup') {
              try {
                return json(res, 200, await completeSetup(await readJson(req)))
              } catch (err) {
                return fail(res, err, { keepLogin: true })
              }
            }
            if (method === 'POST' && rel === '/login') {
              try {
                return json(res, 200, await login(await readJson(req)))
              } catch (err) {
                return fail(res, err, { keepLogin: true })
              }
            }
            if (method === 'POST' && rel === '/logout') return json(res, 200, await logout())
            if (method === 'POST' && rel === '/drive/sync') {
              if (!state.loggedIn) throw Object.assign(new Error('未登录'), { status: 401 })
              const r = await mirror.sync()
              await ensureWorkspaces()
              return json(res, 200, { ...r, driveDir: state.data.driveDir })
            }
            if (method === 'GET' && rel.startsWith('/sessions/') && rel.endsWith('/produced')) {
              const sid = decodeURIComponent(rel.split('/')[2])
              const live = ctx.sessions.get?.(sid)
              if (live && !(produced.data.sessions[sid]?.length)) produced.rebuildFrom(live)
              return json(res, 200, { sessionId: sid, files: produced.list(sid).filter((f) => f.exists && !TASK_CARD_FILES.has(f.name)) })
            }
            if (method === 'GET' && rel.startsWith('/sessions/') && rel.endsWith('/last-assistant')) {
              const sid = decodeURIComponent(rel.split('/')[2])
              const live = ctx.sessions.get?.(sid)
              if (!live) return json(res, 200, { sessionId: sid, text: null, reason: 'session_not_live' })
              let text = null
              let title = null
              for (const ev of live.events ?? []) {
                if (ev.type === 'assistant/message') {
                  const blocks = ev.data?.message?.content ?? []
                  const t = blocks
                    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
                    .map((b) => b.text)
                    .join('\n')
                    .trim()
                  if (t) text = t
                }
                if (ev.type === 'session/title' || ev.type === 'session/rename') title = ev.data?.title ?? title
              }
              return json(res, 200, { sessionId: sid, text, title, cwd: live.header?.cwd ?? null })
            }
            if (method === 'POST' && rel.startsWith('/sessions/') && rel.endsWith('/attach-files')) {
              // 输入框「文件」：把本机选中的文件写进会话工作目录的 _attachments/，Agent 用文件工具直接读；
              // 浏览器端随后把相对路径塞进草稿。文件内容以 base64 走本机回环，不经网关。
              const sid = decodeURIComponent(rel.split('/')[2])
              const body = await readJson(req)
              const live = ctx.sessions.get?.(sid)
              const cwd = live?.header?.cwd ?? (typeof body.cwd === 'string' ? body.cwd : null)
              if (!cwd) throw Object.assign(new Error('会话还没有工作目录，先选一个工作区'), { status: 400, code: 'no_cwd' })
              const written = writeAttachments(cwd, Array.isArray(body.files) ? body.files : [])
              return json(res, 200, { sessionId: sid, dir: written.dir, files: written.files })
            }
            if (method === 'POST' && /^\/tasks\/[^/]+\/open-process$/.test(rel)) {
              // 为任务准备本机工作目录（公司盘收件箱格子）并登记为工作区；浏览器端随后 connectWorkspace 打开会话。
              // 任务进程挂在「团队」工作区（公司盘 projects/）下，Agent 在 projects/inbox/<任务ID>/ 这个格子里干活。
              const taskId = decodeURIComponent(rel.split('/')[2])
              const task = await fetchTask(taskId)
              const dir = mirror.taskDir(taskId)
              fs.mkdirSync(dir, { recursive: true })
              mirror.writeTaskCard(task)
              if (!state.data.workspaces?.team) await ensureWorkspaces()
              const workspaceId = state.data.workspaces?.team ?? null
              return json(res, 200, { taskId, dir, workspaceId, teamDir: mirror.abs('projects') })
            }
            if (method === 'POST' && /^\/tasks\/[^/]+\/bind-session$/.test(rel)) {
              const taskId = decodeURIComponent(rel.split('/')[2])
              const body = await readJson(req)
              if (!body.sessionId) throw Object.assign(new Error('缺少 sessionId'), { status: 400 })
              state.bindTaskSession(taskId, String(body.sessionId))
              const r = await gateway.post(`/api/tasks/${encodeURIComponent(taskId)}/sessions`, { sessionId: String(body.sessionId), title: body.title ?? '', device: state.data.device })
              mirror.writeTaskCard(r.task)
              return json(res, 200, { task: r.task, taskSessions: state.data.taskSessions })
            }
            if (method === 'POST' && /^\/tasks\/[^/]+\/unbind-session$/.test(rel)) {
              // 「撤销」关联：任务卡上摘掉这个进程；本机的进程→任务映射同步清掉（Agent 工具不再默认落到这张卡）
              const taskId = decodeURIComponent(rel.split('/')[2])
              const body = await readJson(req)
              if (!body.sessionId) throw Object.assign(new Error('缺少 sessionId'), { status: 400 })
              const r = await gateway.delete(`/api/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(String(body.sessionId))}`)
              state.unbindTaskSession(taskId, String(body.sessionId))
              mirror.writeTaskCard(r.task)
              return json(res, 200, { task: r.task, taskSessions: state.data.taskSessions })
            }
            if (method === 'POST' && /^\/tasks\/[^/]+\/attach-local$/.test(rel)) {
              const taskId = decodeURIComponent(rel.split('/')[2])
              const body = await readJson(req)
              const task = await attachLocalFiles(taskId, body.paths ?? [], { sessionId: body.sessionId, source: body.source ?? 'session' })
              return json(res, 200, { task })
            }
            if (method === 'POST' && rel === '/open') {
              const body = await readJson(req)
              openPath(body.path)
              return json(res, 200, { ok: true })
            }
            if (method === 'GET' && rel === '/plugins') {
              const inv = ctx.pluginInventory ?? ctx.get?.('pluginInventory')
              if (inv?.list) {
                try {
                  const snap = await inv.list()
                  return json(res, 200, { ...snap, source: 'dsh-plugin-inventory', compatible: true, format: 'dsh-plugin-inventory' })
                } catch (err) {
                  log(`pluginInventory.list 失败：${err.message}`)
                }
              }
              const entries = []
              const loader = ctx.loader ?? ctx.get?.('loader')
              if (loader?.entries) {
                for (const entry of loader.entries()) {
                  if (entry.options?.group) continue
                  entries.push({
                    entryId: entry.id,
                    moduleName: entry.options?.name ?? entry.id,
                    enabled: !entry.disabled,
                    fiberPhase: entry.fiber === undefined ? null : String(entry.fiber.state ?? ''),
                  })
                }
              }
              const have = new Set(entries.map((e) => e.entryId))
              for (const extra of [
                { entryId: 'desk-host', moduleName: '@company-desk/desk-host', enabled: true, fiberPhase: 'active' },
                { entryId: 'desk-ui', moduleName: '@company-desk/desk-ui', enabled: true, fiberPhase: 'active' },
              ]) {
                if (!have.has(extra.entryId)) entries.push(extra)
              }
              return json(res, 200, { entries, source: 'loader', compatible: true, format: 'dsh-plugin-inventory' })
            }
            if (rel.startsWith('/gw/')) {
              if (!state.loggedIn) throw Object.assign(new Error('未登录公司网关'), { status: 401, code: 'unauthenticated' })
              const target = `/api/${rel.slice(4)}${url.search}`
              const hasBody = !['GET', 'HEAD'].includes(method)
              const body = hasBody ? await readJson(req) : undefined
              const r = await gateway.request(method, target, hasBody ? { body } : {})
              if (r && typeof r === 'object' && !Buffer.isBuffer(r)) {
                if (r.task?.id) mirror.writeTaskCard(r.task)
                if (Array.isArray(r.tasks)) for (const t of r.tasks) mirror.writeTaskCard(t)
                if (rel === '/gw/auth/me' && r.user) {
                  const modelSig = (c) => JSON.stringify(c?.models ?? [])
                  const changed = modelSig(state.data.company) !== modelSig(r.company)
                  state.data.user = r.user
                  state.data.company = r.company
                  state.data.quota = r.quota
                  state.save()
                  // 管理员接入/断开了通道 → 公司模型目录变了 → 立刻重写本机的模型路由
                  if (changed && state.data.gatewayToken) configureLlmRoute(r.company, state.data.gatewayToken).catch((err) => log(`刷新模型路由失败: ${err.message}`))
                }
                return json(res, 200, r)
              }
              res.writeHead(200, { 'content-type': 'application/octet-stream' })
              res.end(r)
              return
            }
            json(res, 404, { error: { message: `no route ${method} ${rel}`, code: 'not_found' } })
          } catch (err) {
            fail(res, err)
          }
        },
      }),
    'desk-host: /desk/api routes',
  )

  log(`已就绪：状态目录 ${stateDir}，网关 ${state.data.gatewayUrl}${state.loggedIn ? `，当前登录 ${state.data.user.username}` : '，未登录'}`)
}

const ATTACH_DIR = '_attachments'
const ATTACH_MAX_TOTAL = 64 * 1024 * 1024

/** 把 [{ name, dataBase64 }] 写进 <cwd>/_attachments/，同名自动加序号；返回相对路径供塞进草稿。 */
function writeAttachments(cwd, files) {
  const dir = path.join(path.resolve(cwd), ATTACH_DIR)
  fs.mkdirSync(dir, { recursive: true })
  // 第一遍只解码并累计大小：超限在写任何文件之前就 413，不留半截附件
  const parsed = []
  let total = 0
  for (const f of files) {
    const base = path.basename(String(f?.name ?? '')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'file'
    const buf = Buffer.from(String(f?.dataBase64 ?? ''), 'base64')
    total += buf.length
    if (total > ATTACH_MAX_TOTAL) throw Object.assign(new Error('附件总大小超过 64MB'), { status: 413, code: 'too_large' })
    parsed.push({ base, buf })
  }
  // 第二遍才落盘
  const out = []
  for (const { base, buf } of parsed) {
    const ext = path.extname(base)
    const stem = base.slice(0, base.length - ext.length)
    let name = base
    for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${stem} (${i})${ext}`
    const abs = path.join(dir, name)
    fs.writeFileSync(abs, buf)
    out.push({ name, path: abs, rel: `${ATTACH_DIR}/${name}`, size: buf.length })
  }
  return { dir, files: out }
}

function openPath(p) {
  if (!p) return
  const target = path.resolve(p)
  const platform = process.platform
  const cmd = platform === 'win32' ? 'explorer' : platform === 'darwin' ? 'open' : 'xdg-open'
  const args = platform === 'win32' && fs.existsSync(target) && fs.statSync(target).isFile() ? ['/select,', target] : [target]
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
}
