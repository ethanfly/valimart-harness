/**
 * Mixed 阶段 driver（T04）：官方 subagents 路由派发 + 显式模型快照 + attempt 持久化。
 *
 * 依据 compatibility.md §5（driver 决策，均已实测）与 §6（内核怪癖规避）：
 * - 每 stage 一个官方 `ctx.subagents.start('spawn', ...)` 子代理；agentOptions 显式给
 *   provider/model（角色路由快照）——**不切全局默认模型**（C8：路由只随 agent 创建/派发走）。
 *   provider 取宿主注册的公司网关路由 id：desk-gateway-<catalogProvider>（profile 约定）。
 * - `maxDepth: 1`：子代理不能再 spawn → 结构上禁止子代理嵌套 Mixed（Mixed 桥接钩子只注册在
 *   父会话 agent 作用域，子代理 ctx 不继承该监听器）。
 * - attempt 生命周期（§4.3 崩溃窗口）：starting 先持久化 → spawn 成功补 childSessionId →
 *   结束写 stopReason/usage。宿主在 starting 落盘与 spawn 之间死亡 → 记录仍在（结果未知），
 *   恢复侧不自动重放。
 * - structured_output 死循环怪癖（C3）：attempt 级超时兜底（AbortSignal.any 组合父信号）。
 * - Stop：run.signal 级联进子代理（s4 实测）；cancel cause 必须 JSON 可序列化（C6）。
 * - dispose 移除会话（怪癖 4）：结果读取在 dispose 前完成（await result → 落盘 → dispose）。
 */
import { MixedError, newId, advanceRun } from './contracts.js'

/**
 * 格式纠正（计划 A30 / §4）：第二次同模型重写 JSON 时禁用写入与执行工具，
 * 只许读宿主已给的输出与证据，不能再改工作区。structured_output 是作用域工具，
 * 不在全局 allow/deny 里，内核仍会注入。
 */
export const FORMAT_CORRECTION_TOOL_FILTER = {
  deny: ['write', 'edit', 'bash', 'pwsh'],
}

/** 内核 toolFilter 是 {allow?, deny?}，不是字符串数组。 */
export function spawnToolFilterOption(toolFilter) {
  if (!toolFilter || typeof toolFilter !== 'object' || Array.isArray(toolFilter)) return {}
  const allow = Array.isArray(toolFilter.allow) ? toolFilter.allow : undefined
  const deny = Array.isArray(toolFilter.deny) ? toolFilter.deny : undefined
  if (!(allow?.length || deny?.length)) return {}
  return { toolFilter: { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) } }
}

/** stage → 角色路由（模型由 run 快照决定，driver 绝不重新解析）。 */
export const STAGE_ROLE = {
  planning: 'planner',
  execution: 'executor',
  verification: 'executor',
  review: 'reviewer',
  repair: 'executor',
  summary: 'reviewer',
}

/**
 * @param {object} deps
 * @param {object} deps.ctx 宿主插件 ctx（提供 subagents；测试可注入假 spawn）
 * @param {object} deps.store MixedStore（attempt 落盘）
 * @param {object} deps.parentAgent 父会话 agent（spawn 的 parent）
 * @param {object} deps.run RunRecord 初始快照（models/workspace 固定；最新状态经 store 读取）
 * @param {object} [deps.logger]
 * @param {number} [deps.stageTimeoutMs] attempt 级兜底超时（默认 10 分钟）
  * @param {number} [deps.stageAbandonMs] 弃置宽限：cancel 触发后再等这么久仍无结果 → 停止等待，
  *   抛 stage_timeout（retryable）让 run 收敛 blocked（默认 stageTimeoutMs + 5 分钟）。
  *   内核 cancel 对进行中的上游 LLM 请求是否立即生效无法由宿主保证（真内核 T09 观测到
  *   19 分钟级未落定的单次 LLM 调用）→ 悬挂必须有与 cancel 无关的终局兜底：stage 不得无限期停留。
 * @param {(route) => string} [deps.providerIdOf] 角色路由 → 已注册 provider id
 *   （宿主默认 desk-gateway-<catalogProvider>；探测/测试可覆写）
 */
export class MixedDriver {
  constructor({ ctx, store, parentAgent, run, logger = console, stageTimeoutMs = 600000, stageAbandonMs, disposeTimeoutMs = 20000, providerIdOf, attribution }) {
    if (typeof ctx?.subagents?.start !== 'function') throw new Error('MixedDriver 需要 ctx.subagents.start')
    this.ctx = ctx
    this.store = store
    this.parentAgent = parentAgent
    this.run = run
    this.logger = logger
    this.stageTimeoutMs = stageTimeoutMs
    // 弃置宽限：stage 超时（cancel）触发后再等这么久仍无结果 → 停止等待（见 startStage 弃置路径）。
    // 真内核实测：内核 cancel 对进行中的上游 LLM 请求不一定生效（超时后子代理仍在逐步推进/挂死）。
    this.stageAbandonMs = stageAbandonMs ?? (stageTimeoutMs + 300_000)
    this.disposeTimeoutMs = disposeTimeoutMs
    this.providerIdOf = providerIdOf ?? ((route) => `desk-gateway-${route.catalogProvider}`)
    // T10 用量归属上报器（可选）：spawn 前登记活跃 attempt、attempt 结束时关闭。
    // 失败不阻塞派发——归属丢失在账本可见（无 mixed 字段），不悄悄归错。
    this.attribution = attribution ?? null
    this.active = new Map() // attemptId → {handle, abort}
  }

  #roleOf(stage) {
    const role = STAGE_ROLE[stage]
    if (!role) throw new MixedError('route_not_resolved', `未知 stage: ${stage}`)
    return role
  }

  /**
   * 派发一个阶段。
   * @returns {Promise<{attempt, output, structured?, stopReason}>}
   * 失败时抛 MixedError——调用方（run 控制器）据此把 run 置 blocked，桥接 reject 当前 turn；
   * **绝不静默继续父模型实施**。
   */
  async startStage({ stage, prompt, outputSchema, toolFilter, disableTools, signal, taskId, planVersion }) {
    const role = this.#roleOf(stage)
    const route = this.run.models?.[role]
    if (!route) throw new MixedError('route_unavailable', `${role} 路由缺失（run 模型快照不完整）`)

    // 1) 派发前落盘 starting（崩溃窗口保护）；run 已在取消中 → 拒绝新派发
    const attempt = {
      attemptId: newId('att'),
      stage,
      ...(taskId ? { taskId } : {}),
      planVersion: planVersion ?? this.run.planVersions?.[0]?.version ?? 1,
      route: structuredClone(route),
      startedAt: new Date().toISOString(),
      unknown: false,
    }
    await this.store.updateRun(this.run.runId, (cur) =>
      advanceRun(cur, {
        ownerKey: cur.ownerKey,
        ownerEpoch: cur.ownerEpoch,
        event: { type: 'attempt_started', summary: `${stage}${taskId ? ` task=${taskId}` : ''} 派发前落盘` },
        patch: { attempts: [...cur.attempts, attempt] },
      }),
    ).catch((e) => {
      if (e?.code === 'run_not_in_status') throw e
      throw e // 落盘失败（storage_unhealthy）同样上抛：停止派发
    })

    // 2) spawn（显式角色路由；maxDepth 1 禁止嵌套；超时兜底死循环怪癖）
    const abort = new AbortController()
    const onAbort = () => abort.abort()
    if (signal) {
      if (signal.aborted) abort.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const combined = AbortSignal.any
      ? AbortSignal.any([abort.signal, AbortSignal.timeout(this.stageTimeoutMs)])
      : abort.signal

    // 2.5) T10 用量归属：spawn 之前向网关登记活跃 attempt（必须 AWAIT——attempt 的 LLM 请求
    // 不能先于归属登记到达网关，否则漏关联）。失败不阻塞派发（归属丢失在账本可见）。
    if (this.attribution) {
      await this.attribution.open({ runId: this.run.runId, taskId, stage, attemptId: attempt.attemptId })
    }

    let handle
    try {
      handle = await this.ctx.subagents.start('spawn', {
        label: `mixed:${stage}${taskId ? `:${taskId}` : ''}`,
        prompt: [{ type: 'text', text: prompt }],
        parent: this.parentAgent,
        signal: combined,
        agentOptions: {
          provider: this.providerIdOf(route),
          model: route.modelId,
          ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
        },
        ...(outputSchema ? { outputSchema } : {}),
        ...spawnToolFilterOption(disableTools ? FORMAT_CORRECTION_TOOL_FILTER : toolFilter),
        maxDepth: 1,
      })
    } catch (error) {
      signal?.removeEventListener?.('abort', onAbort)
      await this.#endAttempt(attempt.attemptId, { stopReason: 'error' }).catch(() => {})
      throw new MixedError('route_unavailable', `${stage} 派发失败: ${String(error?.message ?? error)}`, { cause: error })
    }
    this.active.set(attempt.attemptId, { handle, abort })
    // 拒绝保护：spawn 之后、进入 await 之前若 Stop 落进来，result 的 rejection 不能无主
    // （unhandledRejection 会让宿主进程/测试进程收到裸异常；await 仍会正常收到它）
    try {
      handle.result?.catch?.(() => {})
    } catch { /* result 非 thenable 时忽略 */ }

    // 3) spawn 成功 → 补 childSessionId（结果读取/dispose 之前）
    let result
    try {
      await this.store.updateRun(this.run.runId, (cur) =>
        advanceRun(cur, {
          ownerKey: cur.ownerKey,
          ownerEpoch: cur.ownerEpoch,
          event: { type: 'attempt_dispatched', summary: `${stage} 子会话 ${handle.id}` },
          patch: { attempts: cur.attempts.map((a) => (a.attemptId === attempt.attemptId ? { ...a, childSessionId: handle.id } : a)) },
        }),
      ).catch((e) => {
        // 落盘失败 = 停止派发（§6.3）：中止子代理并上抛
        abort.abort()
        throw e
      })

      // 4) 等结果（Stop/超时经 signal 中止 → 子代理 cancel cause {kind:'parent'}）
      // + 弃置兜底：内核 cancel 对进行中的上游 LLM 请求是否立即生效无法由宿主保证（真内核 T09
      //   观测到 19 分钟级未落定的单次 LLM 调用）→ cancel 宽限期（stageAbandonMs）内仍无结果就
      //   停止等待：attempt 结算为 timeout_abandoned、抛 stage_timeout（retryable），run 收敛
      //   blocked（可恢复重试）；子代理留待后台自行了结（宿主重启即消失），stage 不无限期悬挂。
      result = await Promise.race([
        handle.result,
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ __abandoned: true }), this.stageAbandonMs)
          timer.unref?.()
        }),
      ])
      if (result && result.__abandoned) {
        this.logger.error?.(`stage ${stage} 超时弃置：cancel 触发后 ${this.stageAbandonMs - this.stageTimeoutMs}ms 宽限仍未出结果（上游请求可能挂死）`)
        await this.store.updateRun(this.run.runId, (cur) =>
          advanceRun(cur, {
            ownerKey: cur.ownerKey,
            ownerEpoch: cur.ownerEpoch,
            event: { type: 'stage_diagnostic', summary: `stage=${stage} 超时弃置（宽限 ${this.stageAbandonMs}ms 未出结果，结果未知）` },
          }),
        ).catch(() => {})
        await this.#endAttempt(attempt.attemptId, { stopReason: 'timeout_abandoned' }).catch((e) =>
          this.logger.error?.(`attempt 弃置落盘失败: ${String(e)}`),
        )
        await this.#boundedDispose(handle, stage)
        this.active.delete(attempt.attemptId)
        signal?.removeEventListener?.('abort', onAbort)
        throw new MixedError('stage_timeout', `${stage} 阶段超时弃置（宽限 ${this.stageAbandonMs}ms 未出结果）：结果未知，可恢复重试`)
      }
    } catch (error) {
      // 弃置路径已带明确语义（retryable）→ 原样上抛，不被二次包装
      if (error instanceof MixedError && error.code === 'stage_timeout') throw error
      const aborted = !!signal?.aborted
      await this.#endAttempt(attempt.attemptId, { stopReason: aborted ? 'aborted' : 'error' }).catch((e) =>
        this.logger.error?.(`attempt 结束落盘失败: ${String(e)}`),
      )
      await this.#boundedDispose(handle, stage)
      this.active.delete(attempt.attemptId)
      signal?.removeEventListener?.('abort', onAbort)
      if (aborted) throw new MixedError('run_not_in_status', `${stage} 阶段被停止`, { cause: error })
      throw new MixedError('route_unavailable', `${stage} 阶段失败: ${String(error?.message ?? error)}`, { cause: error })
    }

    // 5) 结果已可读（resolve 路径）→ 结算 attempt 并校验完成（在 try 外：自己的校验 throw 不被上面 catch 二次吞掉）
    const aborted = !!signal?.aborted
    const stopReason = aborted ? 'aborted' : (result?.stopReason ?? 'completed')
    await this.#endAttempt(attempt.attemptId, { stopReason, usage: result?.usage })
    await this.#boundedDispose(handle, stage)
    this.active.delete(attempt.attemptId)
    signal?.removeEventListener?.('abort', onAbort)
    // 非 completed 结束即失败/中断（§4.3）：不得视为成功
    if (aborted) throw new MixedError('run_not_in_status', `${stage} 阶段被停止`, { cause: new Error('aborted') })
    if (stopReason !== 'completed') {
      throw new MixedError('stage_failed', `${stage} 阶段未正常完成（stopReason=${stopReason}）`)
    }
    return {
      attempt: { ...attempt, childSessionId: handle.id, stopReason },
      output: result?.output,
      structured: result?.structured,
      stopReason,
    }
  }

  /**
   * 有界 dispose：dispose = 子 agent 的 quiescent teardown（等子作用域内全部后台工作落定，
   * 如标题生成/遥测）。真内核实测：宿主重启恢复后续跑，review attempt 正常 completed 后
   * teardown 卡在挂起的后台请求上 → run 永久停在 reviewing（结果已读、管道却无人推进）。
   * 结果已读之后清理不得无限期阻塞管道：超时记 stage_diagnostic 事件 + warn 后继续
   * （teardown 在后台自行了结，宿主重启即消失）。
   */
  async #boundedDispose(handle, stage) {
    if (typeof handle.dispose !== 'function') return
    const disposeTimeoutMs = this.disposeTimeoutMs ?? 20_000
    const disposal = Promise.resolve()
      .then(() => handle.dispose())
      .catch(() => {})
    let settled = false
    const timedOut = await Promise.race([
      disposal.then(() => { settled = true; return false }),
      new Promise((resolve) => setTimeout(() => resolve(true), disposeTimeoutMs).unref?.()),
    ])
    if (timedOut && !settled) {
      this.logger.warn?.(`stage ${stage} 子作用域 teardown 超时 ${disposeTimeoutMs}ms（结果已读，管道继续；后台自行了结）`)
      // 诊断写不 await：管道前进不依赖这条诊断（真内核环境实测：此处等待存储写曾导致
      // 管道静默停摆 15+ 分钟）。存储侧已有单写超时兜底（writeTimeoutMs）。
      this.store.updateRun(this.run.runId, (cur) =>
        advanceRun(cur, {
          ownerKey: cur.ownerKey,
          ownerEpoch: cur.ownerEpoch,
          event: { type: 'stage_diagnostic', summary: `stage=${stage} 子作用域 teardown 超时 ${disposeTimeoutMs}ms（结果已读，继续）` },
        }),
      ).catch(() => {})
    }
  }

  async #endAttempt(attemptId, { stopReason, usage }) {
    const rec = await this.store.updateRun(this.run.runId, (cur) =>
      advanceRun(cur, {
        ownerKey: cur.ownerKey,
        ownerEpoch: cur.ownerEpoch,
        event: { type: 'attempt_ended', summary: stopReason },
        patch: {
          attempts: cur.attempts.map((a) =>
            a.attemptId === attemptId ? { ...a, endedAt: new Date().toISOString(), stopReason, ...(usage ? { usage: { coverage: 'full', ...usage } } : {}) } : a,
          ),
        },
      }),
    )
    // T10：attempt 结束 → 关闭网关归属（fire-and-forget；宿主被杀时靠网关 TTL 兜底）
    const a = rec?.attempts?.find((x) => x.attemptId === attemptId)
    if (this.attribution && a) this.attribution.close({ runId: this.run.runId, taskId: a.taskId, stage: a.stage, attemptId })
  }

  /** Stop：中止所有活动阶段（父 agent.cancel 由 run 控制器执行，cause 必须可序列化）。 */
  abortAll() {
    for (const { abort } of this.active.values()) {
      try { abort.abort() } catch { /* 已中止 */ }
    }
    this.active.clear()
  }
}
