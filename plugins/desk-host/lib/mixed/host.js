/**
 * Mixed 宿主装配（T07 + T08 生产桥接运行）：把 mixed 存储/目录/证据/API/会话桥接装进 desk-host 插件生命周期。
 *
 * 与内核解耦：自带 JsonStorageBackend + DomainFacility（独立 mixed 单元，不碰内核其他存储单元），
 * 与 mixed-store 测试同一套真实存储栈。惰性 open（首个 mixed API 请求或登录后才付存储初始化成本），
 * 心跳续期单宿主所有权，插件卸载时 close。
 *
 * T08 生产桥接：内核 AgentRegistry（ctx.agents）是公开活注册表（get(id) 按会话 id 取活 agent，
 * 见 dsh-agent README "Live agents"），会话桥接按「Mixed 已启用 + agent 存活」条件挂到父会话 agent：
 * - attachAgent(sessionId)：客户端在打开会话/启用 Mixed 时 ping（API），立即尝试挂载；
 * - ensureBridges() 兜底轮询（默认 2s）：新会话 agent 上线即挂载，agent 重建自动重挂；
 * - agent 消失（dispose/宿主异常退出）：活动 run 按 §5.4 收敛（INTERRUPTABLE→interrupted、queued→blocked、
 *   cancelling→cancelled、waiting_input 保留待恢复入口）；
 * - close()：先收敛活动 run 再关存储（不留下"宿主没了但 run 还活动"的悬挂态）。
 *
 * T09 取消/中断/身份切换收敛：
 * - 启动对账（§5.4）：宿主进程首次解析出 owner 身份时，收敛该 owner 遗留的非终态 run
 *   （上一宿主生命周期的硬杀/断网残留）——先核对（run 记录/attempt/子会话/指纹已持久化），
 *   只标 interrupted/blocked/cancelled，不自动重放；恢复走「核查后继续」入口。
 * - owner fence（§6.1）：ownerKey 变化（换账号/换网关实例）或登出 → 先停旧 owner：
 *   活动控制器 requestStop（停派发 + 级联 abort 子代理/验证进程 + 收敛 cancelled）→
 *   收敛旧 owner 剩余非终态 run → 再 epoch+1 换身份。迟到 callback 因 ownerEpoch 栅栏
 *   （advanceRun 写链校验）不得推进旧 run。
 * - 恢复执行（§5.4「核查后继续」）：resume API 落 resume_requested 后，宿主用内核公开的
 *   agent.followup() 排一条 plugin 来源的恢复 marker；桥接 pre-step 识别后在同一 turn
 *   重入控制器（service.js execute({resume})）。agent 不在线时留 pendingResume，
 *   ensureBridges 在 agent 上线后自动补发 marker。
 */
import path from 'node:path'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MixedStore } from './store.js'
import { ModelRoutes } from './model-routes.js'
import { EvidenceCollector } from './evidence.js'
import { createMixedApi } from './host-api.js'
import { computeOwnerKey } from './owner.js'
import { MixedDriver } from './dsh-driver.js'
import { MixedAttributionReporter } from './attribution-reporter.js'
import { MixedRunController } from './service.js'
import { createMixedBridge } from './session-bridge.js'
import { planPrompt, taskPrompt, reviewPrompt } from './prompts.js'
import { PLAN_OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA } from './schemas.js'
import { RUN_CANCELLABLE, RUN_TERMINAL, RUN_STARTABLE, advanceRun, resumeMarkerText } from './contracts.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const INTERRUPTABLE = new Set(['planning', 'executing', 'reviewing', 'repairing', 'finalizing'])

/**
 * @param {object} deps
 * @param {string} deps.stateDir 本机状态目录（= $DSH_HOME/desk；所有权文件位置）
 * @param {(deps 登录态) => {loggedIn: boolean, user?: {id?: string, username?: string}} deps.getLogin
 * @param {() => Promise<object>} deps.fetchCatalog 网关 GET /api/mixed/catalog（登录令牌由实现方带上）
 * @param {() => string | null} deps.gatewayInstanceId 网关实例 id（目录快照未就绪前的兜底来源，可空）
 * @param {string} deps.profileId 宿主 profile id（ownerKey 派生维度）
 * @param {(sessionId) => boolean} [deps.sessionExists] 会话归属（本机 profile 的会话）
 * @param {object} [deps.agents] 内核 AgentRegistry（ctx.agents）：get(sessionId)/list()
 * @param {object} [deps.subagents] 内核 subagents 服务（驱动 spawn 子代理）
 * @param {(sessionId) => string | null} [deps.sessionCwd] 会话工作区规范路径（session header.cwd）
 * @param {(route) => string} [deps.providerIdOf] 角色路由 → 已注册 llm provider id
 * @param {number} [deps.stageTimeoutMs] 单阶段超时（默认 30 分钟）
 * @param {number} [deps.ensureBridgeMs] 桥接兜底轮询间隔（默认 2000ms）
 * @param {object} [deps.gateway] GatewayClient（T10 用量归属上报 + run 用量读取）
 * @param {object} [deps.logger]
 */
export function createMixedHost({
  stateDir,
  getLogin,
  fetchCatalog,
  gatewayInstanceId,
  profileId,
  sessionExists,
  agents = null,
  subagents = null,
  sessionCwd = () => null,
  providerIdOf = (route) => `desk-gateway-${route?.catalogProvider ?? 'default'}`,
  stageTimeoutMs = 30 * 60 * 1000,
  ensureBridgeMs = 2000,
  gateway = null,
  logger = console,
}) {
  const storageRoot = path.join(path.dirname(stateDir), 'storages')
  let store = null
  let modelRoutes = null
  let collector = null
  let api = null
  let heartbeatTimer = null
  let ensureTimer = null
  let openPromise = null
  const controllers = new Map() // runId → MixedRunController（会话桥接与 API 共享）
  const attached = new Map() // sessionId → { agent, disposer, bridge }
  const interested = new Set() // 需要保持桥接的会话（attach ping / 启用 Mixed / 有活动 run）
  let lastIdentity = null // 最近一次解析出的身份（桥接 getOwner 用同步值）
  const startupReconciled = new Set() // 本进程已做过启动对账的 ownerKey（§5.4：每宿主生命周期一次）
  const dispatchedResumes = new Set() // runId → 本生命周期已发过恢复 marker（防 ensureBridges 轮询重复补发同一 marker；
  // 宿主重启后集合清空——marker 随 agent 收件箱一起丢失时，由「最新事件=resume_requested」门重新放行补发）
  let closing = false
  const log = {
    info: (m) => logger.info?.(m),
    warn: (m) => logger.warn?.(`mixed ${m}`),
    error: (m) => logger.error?.(`mixed ${m}`),
  }
  // T10 用量归属：宿主→网关上报（无 gateway 时禁用，管道不受影响）
  const attributionReporter = gateway ? new MixedAttributionReporter({ gateway, logger: log }) : null

  async function open() {
    if (store) return api
    if (openPromise) return openPromise
    openPromise = (async () => {
      const backend = new JsonStorageBackend(storageRoot)
      const facilityCtx = {
        storage: { backend: { get: (name) => (name === 'json' ? backend : undefined) } },
        logger: { warn: () => {}, error: () => {} },
        emit: () => {},
      }
      const facility = new DomainFacility(facilityCtx, { backend: 'json', routes: {} })
      const s = new MixedStore({ stateDir, storageRoot, hostId: `desk-${process.pid}`, ownershipTtlMs: 15000, logger: log })
      await s.open(facility)
      store = s
      modelRoutes = new ModelRoutes({
        fetchCatalog: async () => {
          const login = getLogin()
          if (!login?.loggedIn) throw new Error('未登录：模型目录不可用')
          return fetchCatalog()
        },
      })
      collector = new EvidenceCollector({ storageRoot: path.dirname(stateDir), store: s, logger: log })
      api = createMixedApi({
        store: s,
        getIdentity,
        modelRoutes,
        controllers,
        evidence: collector,
        profileId,
        sessionExists,
        onSessionInterested: (sid) => interested.add(sid),
        attachAgent,
        onResume: (runId, request, ownerKey) => triggerResume(runId, request, ownerKey),
        fetchRunUsage: (runId) => (attributionReporter ? attributionReporter.fetchRunUsage(runId) : Promise.resolve(null)),
        logger: log,
      })
      // 所有权心跳（15s TTL → 5s 一次）
      heartbeatTimer = setInterval(() => {
        try { s.heartbeat() } catch { /* 忽略 */ }
      }, 5000)
      heartbeatTimer.unref?.()
      // 桥接兜底轮询（新会话 agent 上线即挂；agent 消失则收敛活动 run）
      if (agents && subagents && !closing) {
        ensureTimer = setInterval(() => {
          ensureBridges().catch((e) => log.warn(`ensureBridges: ${e.message}`))
        }, ensureBridgeMs)
        ensureTimer.unref?.()
      }
      log.info(`存储已打开（${s.openedAt}，healthy=${s.healthy}）`)
      return api
    })()
    try {
      return await openPromise
    } catch (err) {
      openPromise = null
      throw err
    }
  }

  /** 当前登录身份（ownerKey/epoch 栅栏，§6.1）：目录未同步时先同步再解析。 */
  async function getIdentity() {
    const login = getLogin()
    if (!login?.loggedIn) {
      // 登出：立即 fence 旧 owner（停派发 + 收敛），再清身份；持久化 owner 保留（同账号重登不升 epoch）
      if (lastIdentity?.ownerKey) {
        await fenceOwner(lastIdentity.ownerKey, '登出：fence 旧 owner（停止派发、收敛未终态 run）')
      }
      lastIdentity = null
      return null
    }
    // 目录快照（含 gatewayInstanceId）尽量先就绪
    if (modelRoutes && !modelRoutes.snapshot) {
      try { await modelRoutes.refresh() } catch { /* 目录暂不可用 → ownerKey null → 503 */ }
    }
    const gi = modelRoutes?.snapshot?.gatewayInstanceId ?? gatewayInstanceId?.() ?? null
    const userId = login.user?.id ?? login.user?.username ?? null
    if (!gi || !userId) {
      lastIdentity = null
      return { loggedIn: true, ownerKey: null, ownerEpoch: 0, userId }
    }
    const ownerKey = computeOwnerKey({ gatewayInstanceId: gi, userId, profileId })
    const persisted = store.getOwnerIdentity()
    let ownerEpoch = persisted.ownerEpoch ?? 0
    if (persisted.ownerKey === ownerKey) {
      ownerEpoch = persisted.ownerEpoch
    } else if (persisted.ownerKey == null) {
      ownerEpoch = 0 // 首次
      store.setOwnerIdentity({ ownerKey, ownerEpoch })
    } else {
      // 账号/网关实例变化：先 fence 旧 owner（停派发→取消子代理等收敛），再 epoch+1 换身份（§6.1 顺序）
      if (lastIdentity?.ownerKey) {
        await fenceOwner(lastIdentity.ownerKey, 'owner 身份变化（换账号/换网关实例）：fence 旧 owner')
      }
      ownerEpoch = (persisted.ownerEpoch ?? 0) + 1
      store.setOwnerIdentity({ ownerKey, ownerEpoch })
      log.warn(`owner 身份变化 → epoch=${ownerEpoch}（旧 owner 已 fence 收敛）`)
    }
    // 启动对账（§5.4）：本宿主进程首次解析出该 owner → 收敛上一宿主生命周期遗留的非终态 run
    // （硬杀/断网残留）。只标 interrupted/blocked/cancelled，不自动重放；恢复走「核查后继续」。
    if (!startupReconciled.has(ownerKey)) {
      await convergeRunsOf(ownerKey, '宿主启动对账：未终止阶段标记中断（§5.4，结果不明不自动重放）')
      startupReconciled.add(ownerKey)
    }
    lastIdentity = { ownerKey, ownerEpoch, userId }
    return { loggedIn: true, ownerKey, ownerEpoch, userId }
  }

  // ---------- T08 生产桥接运行 ----------

  function runControllerFactory({ agent, sessionId, run, store: s }) {
    const driver = new MixedDriver({
      ctx: { subagents },
      store: s,
      parentAgent: agent,
      run,
      providerIdOf,
      stageTimeoutMs,
      attribution: attributionReporter,
      logger: log,
    })
    const controller = new MixedRunController({
      store: s,
      driver,
      run,
      agent,
      collector,
      planPrompt: (r, opts) => planPrompt(r, opts),
      taskPrompt: (r, t, opts) => taskPrompt(r, t, opts),
      reviewPrompt: (r, plan, opts) => reviewPrompt(r, plan, opts),
      planSchema: PLAN_OUTPUT_SCHEMA,
      reviewSchema: REVIEW_OUTPUT_SCHEMA,
      logger: log,
    })
    controllers.set(run.runId, controller)
    return controller
  }

  /** 挂载（或复用）会话桥接。幂等；agent 变化时自动重挂。 */
  async function attachAgent(sessionId) {
    if (!agents || !subagents) return { attached: false, reason: 'runtime_unavailable' }
    await open()
    if (closing) return { attached: false, reason: 'closing' }
    const identity = lastIdentity ?? (await getIdentity())
    if (!identity?.ownerKey) return { attached: false, reason: 'owner_not_resolved' }
    const mode = store.getSessionMode(sessionId, { ownerKey: identity.ownerKey })
    if (!mode?.enabled) return { attached: false, reason: 'mode_disabled' }
    const agent = agents.get?.(sessionId)
    if (!agent) return { attached: false, reason: 'agent_not_live' }
    const cur = attached.get(sessionId)
    if (cur && cur.agent === agent) return { attached: true }
    // agent 已换（旧 agent dispose 后内核重建）：先卸旧桥
    if (cur) {
      try { cur.disposer() } catch { /* 已随 agent 销毁 */ }
      attached.delete(sessionId)
    }
    const bridge = createMixedBridge({
      store,
      profileId,
      getOwner: () => lastIdentity,
      workspacePath: (sid) => sessionCwd?.(sid) ?? '',
      deps: { runControllerFactory, controllers },
      findSession: () => {
        const a = agents.get?.(sessionId)
        return a ? { agent: a, sessionId } : null
      },
      providerIdOf,
      logger: log,
    })
    let disposer
    try {
      disposer = bridge.install(agent, sessionId)
    } catch (e) {
      log.error(`桥接安装失败（${sessionId}）: ${e.message}`)
      return { attached: false, reason: 'install_failed' }
    }
    attached.set(sessionId, { agent, disposer, bridge })
    interested.add(sessionId)
    log.info(`桥接已挂载：会话 ${sessionId}`)
    return { attached: true }
  }

  /**
   * 收敛指定 owner 的非终态 run（§5.1/§5.4 宿主侧收敛规则）：
   * cancelling→cancelled；planning/executing/reviewing/repairing/finalizing→interrupted；
   * queued→blocked(retryable)；waiting_input 保留（恢复入口）。不自动重放——结果不明的
   * attempt 保留记录，恢复走「核查后继续」。sessionId=null 时收敛该 owner 全部会话。
   */
  async function convergeRunsOf(ownerKey, reason, { sessionId = null } = {}) {
    if (!store || !ownerKey) return
    const runs = []
    let cursor = 0
    for (;;) {
      const page = store.listRuns({ ownerKey, sessionId, limit: 100, cursor })
      runs.push(...page.items)
      if (page.nextCursor == null) break
      cursor = page.nextCursor
    }
    for (const r of runs) {
      // 收敛目标 = queued + 活动阶段 + cancelling（cancelling 不在 RUN_CANCELLABLE 里——
      // 它只能 →cancelled，必须单独纳入，否则宿主重启后 cancelling 永久悬挂）
      // waiting_input 保留（恢复入口：等用户回答，宿主侧不代收敛；显式 Stop 仍可取消）
      if (r.status === 'waiting_input') continue
      if (!RUN_CANCELLABLE.has(r.status) && r.status !== 'cancelling') continue
      try {
        await store.updateRun(r.runId, (c) =>
          advanceRun(c, {
            ownerKey: c.ownerKey,
            ownerEpoch: c.ownerEpoch,
            to: c.status === 'cancelling' ? 'cancelled' : INTERRUPTABLE.has(c.status) ? 'interrupted' : 'blocked',
            interrupting: INTERRUPTABLE.has(c.status),
            cancelling: c.status === 'cancelling',
            event: { type: c.status === 'cancelling' ? 'status_changed' : 'interrupted', summary: reason },
            patch: INTERRUPTABLE.has(c.status) || c.status === 'queued'
              ? { error: { code: c.status === 'cancelling' ? 'cancelled' : 'host_interrupted', retryable: c.status === 'queued', detail: reason } }
              : undefined,
          }),
        )
        log.warn(`run ${r.runId} 收敛（${reason}）`)
      } catch (e) {
        if (e.code !== 'run_not_in_status') log.warn(`run ${r.runId} 收敛失败: ${e.message}`)
      }
    }
  }

  /** 会话 agent 消失/宿主退出：按 §5.4 收敛活动 run（不自动重放、不悬挂）。sessionId=null 时收敛全部会话。 */
  async function convergeSessionRuns(sessionId, reason) {
    if (!lastIdentity?.ownerKey) return
    return convergeRunsOf(lastIdentity.ownerKey, reason, { sessionId })
  }

  /**
   * owner fence（T09 / §6.1）：换账号/登出时先停旧 owner 再换身份——
   * ① 本宿主活动控制器（属于旧 owner、非终态）requestStop：停派发 + 级联 abort
   *   （子代理/上游请求/验证进程）+ 收敛 cancelled；
   * ② 收敛旧 owner 剩余非终态 run（含上一宿主生命周期残留）：interrupted/blocked/cancelled。
   * 迟到 callback 因 advanceRun 的 ownerKey/ownerEpoch 写链栅栏不得推进旧 run。
   */
  async function fenceOwner(ownerKey, reason) {
    if (!ownerKey) return
    const stops = []
    for (const [runId, controller] of controllers) {
      try {
        const r = store?.getRun(runId)
        if (r && r.ownerKey === ownerKey && !RUN_TERMINAL.has(r.status)) {
          stops.push(Promise.resolve(controller.requestStop(reason)).catch(() => {}))
        }
      } catch { /* 单 run 读取失败不阻塞 fence */ }
    }
    await Promise.allSettled(stops)
    await convergeRunsOf(ownerKey, reason).catch((e) => log.warn(`fenceOwner 收敛失败: ${e.message}`))
  }

  // ---------- T09 恢复执行（「核查后继续」——用户选择恢复，宿主不自动续跑）----------

  function resumeMarkerMessage(runId, kind) {
    return createUserMessage({
      content: [{ type: 'text', text: resumeMarkerText(runId, kind) }],
      source: { kind: 'plugin', plugin: 'mixed', form: 'notice', summary: 'Mixed 恢复' },
    })
  }

  /**
   * resume API 落 resume_requested 后调用：会话 agent 在线 → followup marker（唤醒内核
   * 下一轮，桥接 pre-step 识别 marker 后同轮重入控制器执行恢复）；离线 → 留 pendingResume
   * （ensureBridges 在 agent 上线后自动补发）。
   * @returns {Promise<{started: boolean, reason?: string}>}
   */
  async function triggerResume(runId, request, ownerKey) {
    await open()
    if (request?.kind !== 'continue' && request?.kind !== 'retry' && request?.kind !== 'answer') {
      return { started: false, reason: `不支持的恢复类型: ${request?.kind ?? 'none'}` }
    }
    const run = store.getRun(runId, { ownerKey })
    if (!run) return { started: false, reason: 'run_not_found' }
    if (!RUN_STARTABLE.has(run.status)) return { started: false, reason: `run 状态 ${run.status} 不可恢复` }
    const agent = agents?.get?.(run.sessionId)
    if (!agent || typeof agent.followup !== 'function') {
      return { started: false, reason: 'agent_not_live（会话打开后自动继续）' }
    }
    try {
      agent.followup(resumeMarkerMessage(run.runId, request.kind))
      dispatchedResumes.add(run.runId)
      log.info(`恢复 marker 已派发：${run.runId}（choice=${request.kind}）`)
      return { started: true }
    } catch (e) {
      return { started: false, reason: `followup_failed: ${e.message}` }
    }
  }

  /** 会话 agent 上线/桥接就位后，补发 pending 恢复（resume_requested 已落盘但当时 agent 离线）。 */
  async function dispatchPendingResumes(sessionId) {
    if (!store || !agents || !lastIdentity?.ownerKey) return
    // 索引行已带 pendingResume 摘要 → 先按行筛掉无需恢复的，再用全量记录核对事件序列
    const page = store.listRuns({ ownerKey: lastIdentity.ownerKey, sessionId, limit: 10 })
    const candidate = page.items.find((r) => RUN_STARTABLE.has(r.status) && r.pendingResume)
    if (!candidate) return
    const run = store.getRun(candidate.runId)
    if (!run?.pendingResume) return
    if (controllers.has(run.runId)) return // 恢复已在执行
    const last = (run.events ?? []).at(-1)
    if (last?.type !== 'resume_requested') return // 已有后续事件（恢复已启动/已失败）→ 不重放
    if (dispatchedResumes.has(run.runId)) return // 本生命周期已发过（marker 在 agent 收件箱/处理中）→ 不重复补发
    const agent = agents.get?.(sessionId)
    if (!agent || typeof agent.followup !== 'function') return
    try {
      agent.followup(resumeMarkerMessage(run.runId, run.pendingResume.kind))
      dispatchedResumes.add(run.runId)
      log.info(`补发恢复 marker：${run.runId}（choice=${run.pendingResume.kind}）`)
    } catch (e) {
      log.warn(`补发恢复 marker 失败（${run.runId}）: ${e.message}`)
    }
  }

  /** 兜底轮询：新 agent 上线即挂；agent 消失则收敛活动 run。 */
  async function ensureBridges() {
    if (!store || closing || !agents) return
    const identity = lastIdentity
    if (!identity?.ownerKey) return
    // 有活动 run 的会话也保持关注（客户端没 ping 过的兜底）
    for (const r of store.listRuns({ ownerKey: identity.ownerKey }).items) {
      if (!RUN_CANCELLABLE.has(r.status) && !['waiting_input'].includes(r.status)) continue
      interested.add(r.sessionId)
    }
    for (const sid of [...interested]) {
      const mode = store.getSessionMode(sid, { ownerKey: identity.ownerKey })
      const agent = agents.get?.(sid)
      const cur = attached.get(sid)
      if (!mode?.enabled) {
        if (cur) {
          try { cur.disposer() } catch { /* 忽略 */ }
          attached.delete(sid)
        }
        continue
      }
      if (agent) {
        if (cur && cur.agent === agent) {
          await dispatchPendingResumes(sid)
          continue
        }
        await attachAgent(sid)
        await dispatchPendingResumes(sid)
      } else if (cur) {
        try { cur.disposer() } catch { /* 忽略 */ }
        attached.delete(sid)
        await convergeSessionRuns(sid, '会话 agent 已销毁（宿主异常或会话关闭），运行未收敛部分标记中断')
      }
    }
  }

  async function close() {
    closing = true
    if (ensureTimer) clearInterval(ensureTimer)
    ensureTimer = null
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = null
    // 宿主退出：活动 run 按 §5.4 收敛（全部会话），不悬挂
    if (store && lastIdentity?.ownerKey) {
      await convergeSessionRuns(null, '宿主退出（插件卸载/应用关闭）').catch(() => {})
    }
    for (const { disposer } of [...attached.values()]) {
      try { disposer() } catch { /* 忽略 */ }
    }
    attached.clear()
    if (store) {
      try { await store.close() } catch { /* 忽略 */ }
    }
    store = null
    api = null
    modelRoutes = null
    collector = null
    openPromise = null
    controllers.clear()
    lastIdentity = null
  }

  return {
    api: null, // 惰性；用 open()/ready()
    /** 打开（幂等）并返回本机 mixed API（index.js 以 mapi.handle 调用）。 */
    ready() {
      return open()
    },
    open,
    close,
    attachAgent,
    ensureBridges,
    triggerResume,
    convergeRunsOf,
    /** 客户端打开会话/启用 Mixed 时 ping：立即尝试挂载桥接（不等轮询）。 */
    interested,
    get controllers() {
      return controllers
    },
    get store() {
      return store
    },
    get modelRoutes() {
      return modelRoutes
    },
    get attached() {
      return attached
    },
  }
}
