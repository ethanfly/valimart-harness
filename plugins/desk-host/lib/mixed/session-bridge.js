/**
 * Mixed 会话桥接（T04）：普通消息领取、Plan/Mixed 互斥、最终交付与 Stop。
 *
 * 依据 compatibility.md §5/§6（实测）：
 * - 桥接钩子注册在父会话 agent 作用域（agent.ctx.on）：
 *   - `agent/pre-step`：领取去重（按消息 id 幂等，team-gui message_claims 思路）→ 流水线（payload.signal
 *     为取消边界）→ 成功 enter+[原消息…, 交付插件消息] / 失败 reject（turn blocked，父模型不实施）。
 *   - `agent/request`：交付步 per-step 改道到 reviewer 路由（C5；最终汇总模型归属 + usage 进账本）。
 * - 重复消息/页面重连/pre-step 重试：同一 sourceMessageId → 同一 submissionKey/runId → 返回已认领 run，
 *   enter+[] 消费，绝不放行父模型再实施、绝不重复交付。
 * - 运行中用户新消息 → 排队为下一轮需求（run.queuedInputs），不修改当前目标（§5.3）。
 * - Stop：payload.signal（turn 信号）abort → controller.requestStop → 持久化取消意图 →
 *   agent.cancel({可序列化 cause})（C6）→ driver 级联 abort 子代理 → 收敛写 cancelled。
 * - 内核怪癖 2：claim 空消费后外层插件（skill 目录/instructions re-queue）仍可能触发模型步——
 *   交付去重按 runId 幂等，不假设「空决策 = 无模型调用」。
 */
import crypto from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  MixedError,
  advanceRun,
  submissionKeyOf,
  runIdOf,
  RUN_RESUMABLE,
  parseResumeMarker,
} from './contracts.js'

const TERMINAL = new Set(['succeeded', 'cancelled'])
const NEEDS_RECOVERY = new Set(['blocked', 'interrupted', 'waiting_input'])

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('')
  return ''
}
function messageIdOf(message, fallbackText) {
  return message?.id ?? `m-${crypto.createHash('sha256').update(textOf(message?.content ?? fallbackText), 'utf8').digest('hex').slice(0, 20)}`
}

/**
 * @param {object} deps
 * @param {object} deps.store MixedStore
 * @param {string} deps.profileId 宿主 profile id（ownerKey 派生维度）
 * @param {() => {ownerKey, ownerEpoch} | null} deps.getOwner 当前登录身份（未登录 = null → Mixed 不可用）
 * @param {(sessionId) => string} deps.workspacePath 会话工作区规范路径（宿主提供；内核 agent 不暴露 meta，
 *   cwd 在 session identity 里——宿主建会话时就知道，不从内核内部结构里挖）
 * @param {object} deps.deps 传给 run 控制器的依赖（prompt 构造器/schema/driver 工厂/controllers）
 * @param {(sessionId) => {agent, sessionId} | null} deps.findSession 取当前会话 agent（Stop 用）
 * @param {(route) => string} [deps.providerIdOf] 角色路由 → 已注册 provider id（默认 desk-gateway-<catalogProvider>）
 * @param {object} [deps.logger]
 */
export function createMixedBridge({
  store,
  profileId,
  getOwner,
  workspacePath,
  deps,
  findSession,
  providerIdOf = (route) => `desk-gateway-${route.catalogProvider}`,
  logger = console,
}) {
  let deliveryStepPending = false

  /** 安装到父会话 agent（每个会话一次）。返回 disposer。 */
  function install(agent, sessionId) {
    const d1 = agent.ctx.on('agent/pre-step', (payload, next) =>
      handlePreStep({ agent, sessionId, payload, next }),
    )
    const d2 = agent.ctx.on('agent/request', async (_payload, next) => {
      const seed = await next()
      if (!deliveryStepPending) return seed
      // 交付步改道 reviewer（C5）：改道后 config/source.model/usage 均按 reviewer 记录
      const owner = getOwner()
      const prefs = owner ? store.getPreferences(owner.ownerKey) : null
      const reviewer = prefs?.reviewer
      if (!reviewer) return seed
      deliveryStepPending = false
      return { ...seed, provider: providerIdOf(reviewer), model: reviewer.modelId }
    })
    return () => {
      d1()
      d2()
    }
  }

  async function handlePreStep({ agent, sessionId, payload, next }) {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const claimed = Array.isArray(decision.messages) ? decision.messages : []
    // T09：恢复 marker（宿主 followup 派发的 plugin 消息，可能没有 user 消息）→ 优先处理；
    // 未登录/模式已关时静默消费（不放进父模型；模式重开后宿主自动补发 marker）
    const markerMsg = claimed.find((m) => parseResumeMarker(textOf(m?.content)))
    if (markerMsg) {
      const owner = getOwner()
      const mode = owner
        ? store.getSessionMode(sessionId, { ownerKey: owner.ownerKey })
        : null
      if (!owner || !mode?.enabled) return { kind: 'enter', messages: [] }
      return handleResumeMarker({
        agent,
        sessionId,
        marker: parseResumeMarker(textOf(markerMsg.content)),
        payload,
      })
    }
    const userMsg = claimed.find((m) => m?.source?.kind === 'user')
    // 无用户消息（插件注入/运行时上下文 turn）→ 原样放行
    if (!userMsg) return decision

    const owner = getOwner()
    if (!owner) return decision // 未登录：普通模式（Mixed 需升级服务端/登录）
    const mode = store.getSessionMode(sessionId, { ownerKey: owner.ownerKey })
    if (!mode?.enabled) return decision // Plan/普通模式互斥：未启用 Mixed 时完全透传

    const sourceMessageId = messageIdOf(userMsg)
    const submissionKey = submissionKeyOf({ ownerKey: owner.ownerKey, profileId, sessionId, sourceMessageId })
    const runId = runIdOf(submissionKey)
    const existing = store.getRun(runId)

    // ---- 已认领：幂等路径 ----
    if (existing) {
      if (TERMINAL.has(existing.status)) {
        // 已交付/已停止的同一条消息（重试/重连）：消费，不重放、不重复交付（runId 去重）
        return { kind: 'enter', messages: [] }
      }
      if (NEEDS_RECOVERY.has(existing.status)) {
        return { kind: 'reject', reason: `该消息的 Mixed run 处于 ${existing.status}：请用「核查后继续/恢复」入口处理，不自动重放` }
      }
      // 活动 run 且属于同一消息：流水线已在跑（或 pre-step 重试）→ 消费，不跑模型
      return { kind: 'enter', messages: [] }
    }

    // ---- 同会话有其他活动 run：新消息排队为下一轮需求（§5.3）----
    const other = store
      .listRuns({ ownerKey: owner.ownerKey, sessionId })
      .items.find((r) => !TERMINAL.has(r.status))
    if (other) {
      await store.updateRun(other.runId, (cur) =>
        advanceRun(cur, {
          ownerKey: cur.ownerKey,
          ownerEpoch: cur.ownerEpoch,
          event: { type: 'input_queued', summary: textOf(userMsg.content).slice(0, 200) },
          patch: {
            queuedInputs: [
              ...(cur.queuedInputs ?? []),
              { messageId: sourceMessageId, text: textOf(userMsg.content), at: new Date().toISOString() },
            ],
          },
        }),
      ).catch((e) => logger.error?.(`排队输入落盘失败: ${String(e)}`))
      return { kind: 'enter', messages: [] }
    }

    // ---- 新 run：claim + 流水线（pre-step 内，payload.signal 为取消边界）----
    const prefs = store.getPreferences(owner.ownerKey)
    if (!prefs || !prefs.planner || !prefs.executor || !prefs.reviewer) {
      return { kind: 'reject', reason: 'Mixed 三路由配置不齐全：请先在「设置 → Mixed」配置规划/执行/审核模型' }
    }
    const params = {
      runId,
      ownerKey: owner.ownerKey,
      ownerEpoch: owner.ownerEpoch,
      profileId,
      sessionId,
      sourceMessageId,
      submissionKey,
      workspace: { canonicalPath: typeof workspacePath === 'function' ? (workspacePath(sessionId) ?? '') : '', baselineId: 'pending' },
      models: { planner: prefs.planner, executor: prefs.executor, reviewer: prefs.reviewer },
      policy: { maxRepairRounds: 2, maxReplans: 1 },
      goal: textOf(userMsg.content),
      inputRefs: [{ kind: 'text', messageId: sourceMessageId, text: textOf(userMsg.content) }],
    }
    let claimedRun
    try {
      const { run } = await store.claimRun(params)
      claimedRun = run
    } catch (error) {
      return { kind: 'reject', reason: `Mixed run 领取失败（${error?.code ?? 'unknown'}）：${String(error?.message ?? error)}` }
    }

    const controller = deps.runControllerFactory({ agent, sessionId, run: claimedRun, store })
    deps.controllers?.set?.(claimedRun.runId, controller)
    // Stop 级联：turn 信号 abort（原生 Stop）→ 控制器收敛
    const onSignalAbort = () => controller.requestStop('user-stop')
    payload.signal?.addEventListener('abort', onSignalAbort, { once: true })

    let outcome
    try {
      outcome = await controller.execute(payload.signal)
    } finally {
      payload.signal?.removeEventListener?.('abort', onSignalAbort)
    }

    if (outcome.outcome === 'succeeded') {
      deliveryStepPending = true
      return {
        kind: 'enter',
        messages: [
          ...claimed,
          createUserMessage({
            content: [{ type: 'text', text: renderDelivery(outcome.delivery) }],
            source: { kind: 'plugin', plugin: 'mixed', form: 'notice', summary: 'Mixed 交付' },
          }),
        ],
      }
    }
    if (outcome.outcome === 'waiting_input') {
      return {
        kind: 'enter',
        messages: [
          ...claimed,
          createUserMessage({
            content: [{ type: 'text', text: renderWaitingInput(outcome.questions) }],
            source: { kind: 'plugin', plugin: 'mixed', form: 'notice', summary: 'Mixed 等待补充' },
          }),
        ],
      }
    }
    if (outcome.outcome === 'cancelled') {
      return { kind: 'enter', messages: [] } // Stop 已收敛：消费当前消息
    }
    // 失败即停（§7.2）：reject → turn blocked，显示错误，父模型不实施
    return {
      kind: 'reject',
      reason: `Mixed run 失败（${outcome.error?.code ?? 'unknown'}）：${outcome.error?.detail ?? String(outcome.error?.message ?? outcome.error)}`,
    }
  }

  /**
   * T09 恢复 marker 分支：宿主 followup 的 marker 消息 → 重建控制器、重入 execute({resume})。
   * 幂等/去重：run 已终态或恢复已在执行（controllers 在册）→ 消费不重放；
   * 失败落 resume_failed（防宿主补发死循环）并 reject（父模型不实施）。
   */
  async function handleResumeMarker({ agent, sessionId, marker, payload }) {
    const run = store.getRun(marker.runId)
    if (!run) return { kind: 'reject', reason: `恢复请求指向不存在的 run（${marker.runId}）` }
    if (TERMINAL.has(run.status)) return { kind: 'enter', messages: [] } // 已交付/已停止：消费
    if (deps.controllers?.has?.(marker.runId)) return { kind: 'enter', messages: [] } // 恢复已在执行：消费
    if (!RUN_RESUMABLE.has(run.status)) {
      return { kind: 'reject', reason: `run ${run.runId} 当前状态 ${run.status} 不可恢复` }
    }
    const controller = deps.runControllerFactory({ agent, sessionId, run, store })
    deps.controllers?.set?.(marker.runId, controller)
    // Stop 级联：恢复 turn 的 Stop 同样收敛 run
    const onSignalAbort = () => controller.requestStop('user-stop')
    payload.signal?.addEventListener('abort', onSignalAbort, { once: true })
    let outcome
    try {
      outcome = await controller.execute(payload.signal, { resume: { kind: marker.choice } })
    } finally {
      payload.signal?.removeEventListener?.('abort', onSignalAbort)
    }
    if (outcome.outcome === 'succeeded') {
      deliveryStepPending = true
      return {
        kind: 'enter',
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: renderDelivery(outcome.delivery) }],
            source: { kind: 'plugin', plugin: 'mixed', form: 'notice', summary: 'Mixed 交付（恢复完成）' },
          }),
        ],
      }
    }
    if (outcome.outcome === 'waiting_input') {
      return {
        kind: 'enter',
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: renderWaitingInput(outcome.questions) }],
            source: { kind: 'plugin', plugin: 'mixed', form: 'notice', summary: 'Mixed 等待补充' },
          }),
        ],
      }
    }
    if (outcome.outcome === 'cancelled') return { kind: 'enter', messages: [] } // Stop 已收敛：消费
    const detail = `Mixed 恢复失败（${outcome.error?.code ?? 'unknown'}）：${outcome.error?.detail ?? String(outcome.error?.message ?? outcome.error)}`
    // 落 resume_failed：宿主 dispatchPendingResumes 只认「最新事件=resume_requested」，
    // 失败后不再自动重发（用户可在面板再次选择恢复）
    await store
      .updateRun(marker.runId, (cur) =>
        advanceRun(cur, {
          ownerKey: cur.ownerKey,
          ownerEpoch: cur.ownerEpoch,
          event: { type: 'resume_failed', summary: detail.slice(0, 300) },
        }),
      )
      .catch((e) => logger.error?.(`resume_failed 落盘失败: ${String(e)}`))
    return { kind: 'reject', reason: detail }
  }

  /** Stop API（T07 路由）：幂等。返回当前状态。 */
  function requestStop(runId) {
    const session = findSession?.()
    const controller = deps.controllers?.get(runId)
    if (controller) return controller.requestStop('user-stop')
    void session
    return Promise.resolve()
  }

  return { install, requestStop, isDeliveryPending: () => deliveryStepPending }
}

/** 缺关键需求时的会话通知（§5.1 waiting_input）：列出待答问题，不启动交付步。 */
export function renderWaitingInput(questions = []) {
  const lines = ['Mixed 需要补充关键需求后才能继续规划：']
  for (const q of questions) {
    if (q?.answer) lines.push(`- [${q.questionId}] ${q.text} → 已答：${q.answer}`)
    else lines.push(`- [${q.questionId}] ${q.text}`)
  }
  lines.push('请在运行面板填写答案后点「继续」。')
  return lines.join('\n')
}

/** 交付正文（§8）：验收项、产物、验证结果、审核结论、限制。 */
export function renderDelivery(delivery) {
  const lines = []
  lines.push('## Mixed 交付')
  lines.push(`目标：${delivery.goal}`)
  if (delivery.accepted?.length) lines.push(`通过验收：${delivery.accepted.join('、')}`)
  if (delivery.unverified?.length) lines.push(`未验证项：${delivery.unverified.join('、')}`)
  lines.push('')
  for (const t of delivery.tasks ?? []) lines.push(`- ${t.taskId} ${t.title}（${t.status}）`)
  lines.push(`\n审核结论：${delivery.summary}`)
  if (delivery.limitations?.length) lines.push(`\n限制：${delivery.limitations.join('；')}`)
  return lines.join('\n')
}

export { MixedError }
