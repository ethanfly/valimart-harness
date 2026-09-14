/**
 * Mixed run 控制器（T04 最小闭环；T05 换成 DAG 调度器，T09 补恢复/身份切换收敛）。
 *
 * 职责（计划 §5 状态机 + §4.3 attempt 生命周期）：
 * - queued→planning→executing→reviewing→(repairing→reviewing)→finalizing→succeeded
 * - 任一阶段失败/证据不足 → blocked（桥接 reject 当前 turn，父模型不实施）
 * - Stop：先持久化取消意图（cancelling）→ 停止后续派发 → abort 活动阶段 → 等收敛 → cancelled
 * - owner 栅栏：每次状态推进经 contracts.advanceRun（ownerKey/ownerEpoch 不匹配即拒绝）
 * - 存储不可写（assertWritable 抛错）→ 停止派发，run 置 blocked（storage_unhealthy）
 *
 * T05：实施阶段走 scheduler（ready 集 + 拓扑串行 + 依赖失败阻断 + 工作区写锁 +
 *       重新拆分/planVersion/失效传播）；任务完成只到 executed，等待审核。
 *
 * T09（恢复/中断收敛）：
 * - execute(signal, { resume }) 恢复重入：先对账（running→ready；retry 时 failed 及其
 *   传递受阻后继→ready；结果不明的 attempt 不自动重放——新派发记新 attempt），再按
 *   持久化状态选重入阶段：无计划→planning；任务未完→executing（复用 planVersion 与
 *   原始基线，跳过 executed/accepted）；任务全完→审核未完→reviewing / 审核通过→
 *   finalizing（只重试 finalizing，不重跑实施——§5.1）；审核结论 blocked/返修耗尽→
 *   拒绝恢复（resume_not_allowed，改走重跑）。
 * - 「核查后继续」由用户在面板选择恢复触发（followup marker → 桥接 pre-step），
 *   不是宿主无条件自动续跑；宿主启动/owner 变更的收敛在 host.js（interrupted/blocked）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { MixedError, advanceRun, validatePlanGraph, newId } from './contracts.js'
import { MixedDriver } from './dsh-driver.js'
import {
  acquireWorkspaceWriteLock,
  executeTaskGraph,
  applyReplan,
  applyRepair,
  defaultWorkspaceLocks,
} from './scheduler.js'
import { hashTree } from './evidence.js'
import { validateReviewOutput, formatReviewRejectionDetail } from './review.js'

export class MixedRunController {
  #lastPlanError = null
  #self = new AbortController()

  /**
   * @param {object} deps
   * @param {object} deps.store MixedStore
   * @param {object} deps.driver MixedDriver
   * @param {object} deps.run 初始 RunRecord（claim 产物）
   * @param {(run) => string} deps.planPrompt 规划提示词构造
   * @param {(run, task) => string} deps.taskPrompt 任务提示词构造
   * @param {(run) => string} deps.reviewPrompt 审核提示词构造
   * @param {object} deps.planSchema 规划 structured_output schema
   * @param {object} deps.reviewSchema 审核 structured_output schema
   * @param {object} [deps.logger]
   * @param {number} [deps.maxRepairRounds=2]
   */
  constructor(deps) {
    this.store = deps.store
    this.driver = deps.driver
    this.agent = deps.agent // 父会话 agent（Stop 时 agent.cancel，cause 必须可序列化——C6）
    this.run = deps.run
    this.planPrompt = deps.planPrompt
    this.taskPrompt = deps.taskPrompt
    this.reviewPrompt = deps.reviewPrompt
    this.planSchema = deps.planSchema
    this.reviewSchema = deps.reviewSchema
    this.logger = deps.logger ?? console
    this.maxRepairRounds = deps.maxRepairRounds ?? 2
    this.maxReplans = deps.maxReplans ?? deps.run?.policy?.maxReplans ?? 1
    this.workspaceLocks = deps.workspaceLocks ?? defaultWorkspaceLocks
    this.collector = deps.collector ?? null // T06 证据收集器（缺省时走旧路径：无证据、弱校验）
    this.baseline = null // 运行前工作区基线（collector.collectBaseline 产物）
    this.signal = null // run 级取消信号（Stop 级联进 driver）
    this.aborted = false
    this.running = false
  }

  #fresh() {
    return this.store.getRun(this.run.runId) // 同步读内存投影；最新状态以 update 写链内为准
  }

  /**
   * 执行 run 闭环。
   * @param {AbortSignal} signal Stop 信号（pre-step 的 payload.signal）
   * @param {{resume?: {kind: 'continue'|'retry'}}} [opts] 恢复重入（T09：宿主对账 + 用户选择后，
   *   从持久化状态重入对应阶段；见文件头 T09 说明）
   * @returns {Promise<{outcome: 'succeeded'|'blocked'|'cancelled', delivery?: object, error?: MixedError}>}
   */
  async execute(signal, { resume = null } = {}) {
    this.running = true
    // 合成 run 级信号：外部 turn 信号（原生 Stop）+ 内部停止（API Stop / requestStop）
    this.#self = new AbortController()
    if (signal) {
      const onTurnAbort = () => this.#self.abort()
      if (signal.aborted) this.#self.abort()
      else signal.addEventListener('abort', onTurnAbort, { once: true })
      this.signal = AbortSignal.any ? AbortSignal.any([this.#self.signal, signal]) : this.#self.signal
    } else {
      this.signal = this.#self.signal
    }
    try {
      if (resume) {
        // 先判重入点（只读，可能拒绝 resume_not_allowed），再做对账写入——拒绝时不落半截 reconcile
        const entry = this.#resumeEntry(resume)
        await this.#reconcileForResume(resume)
        await this.#transition(entry.phase, {
          type: 'resume_started',
          summary: `恢复执行「${resume.kind}」：进入 ${entry.phase} 阶段${entry.startRound ? `（审核自第 ${entry.startRound + 1} 轮起）` : ''}`,
        }, { pendingResume: undefined, error: undefined }) // 恢复已启动：清掉待派发标记与上一轮错误
        // 恢复自 planning：新计划需要落盘（savePlan=true）；其余阶段复用既有 planVersion
        return await this.#runPipeline({
          startPhase: entry.phase,
          plan: entry.plan,
          savePlan: entry.phase === 'planning',
          startRound: entry.startRound,
        })
      }
      await this.#transition('planning', { type: 'status_changed', summary: '开始规划' })
      return await this.#runPipeline({ startPhase: 'planning', plan: null, savePlan: true, startRound: 0 })
    } catch (error) {
      // 停止（turn 信号或 API 触发）→ cancelled；其余失败 → blocked
      if (this.aborted || this.#self.signal.aborted) {
        await this.#convergeCancelled()
        return { outcome: 'cancelled' }
      }
      const code = error instanceof MixedError ? error.code : 'storage_unhealthy'
      const detail = String(error?.message ?? error)
      // 任何失败：持久化 blocked（若还能写）→ 桥接 reject；父模型不实施
      await this.store
        .updateRun(this.run.runId, (cur) =>
          advanceRun(cur, {
            ownerKey: cur.ownerKey,
            ownerEpoch: cur.ownerEpoch,
            to: cur.status === 'cancelling' || cur.status === 'cancelled' ? undefined : 'blocked',
            event: { type: 'run_failed', summary: detail },
            patch: { error: { code, retryable: false, detail } },
          }),
        )
        .catch((e) => this.logger.error?.(`失败状态落盘失败: ${String(e)}`))
      return { outcome: 'blocked', error: error instanceof MixedError ? error : new MixedError('storage_unhealthy', detail, { cause: error }) }
    } finally {
      this.running = false
    }
  }

  // ---------- 流水线（正常/恢复共用）----------

  /**
   * 从 startPhase 起跑完剩余阶段。
   * @param {object} p
   * @param {'planning'|'executing'|'reviewing'|'finalizing'} p.startPhase
   * @param {object|null} p.plan 进入时已有计划（planning 阶段为 null）
   * @param {boolean} [p.savePlan=true] 是否新落 planVersion（恢复复用既有计划时为 false）
   * @param {number} [p.startRound=0] 审核轮计数起点（continue 沿用已耗轮次；retry 重置）
   */
  async #runPipeline({ startPhase, plan, savePlan = true, startRound = 0 }) {
    let currentPlan = plan
    if (startPhase === 'planning') {
      currentPlan = await this.#plan()
      if (this.#needsInput(currentPlan)) {
        await this.#enterWaitingInput(currentPlan)
        return { outcome: 'waiting_input', questions: this.#fresh().pendingQuestions }
      }
      await this.#transition('executing', { type: 'status_changed', summary: '规划完成，开始实施' })
      await this.#execute(currentPlan, { savePlan })
    } else if (startPhase === 'executing') {
      await this.#execute(currentPlan, { savePlan })
    }
    if (startPhase !== 'finalizing') {
      // 审核轮（round>0 重跑验证）需要基线；恢复直接进审核时从未采集 → 从证据目录补读
      // （正常流程实施前必有基线；极端缺失时重新采集，diff 退化但审核可继续）
      if (this.collector && !this.baseline) {
        this.baseline = (await this.#loadBaseline()) ?? (await this.collector.collectBaseline(this.store, this.run))
      }
      await this.#transition('reviewing', {
        type: 'status_changed',
        summary: startPhase === 'reviewing' ? '恢复：进入审核（证据刷新 + 重新审核）' : '实施完成，开始审核',
      })
      const verdict = await this.#reviewLoop(currentPlan, { startRound })
      if (verdict !== 'pass') {
        const lastResult = [...(this.#fresh().reviewRounds ?? [])].reverse().find((r) => r?.result)?.result ?? null
        const detail = formatReviewRejectionDetail({ verdict, result: lastResult })
        await this.store.updateRun(this.run.runId, (cur) =>
          advanceRun(cur, {
            ownerKey: cur.ownerKey,
            ownerEpoch: cur.ownerEpoch,
            to: 'blocked',
            event: { type: 'status_changed', summary: detail },
            patch: { error: { code: 'review_rejected', retryable: false, detail } },
          }),
        )
        return { outcome: 'blocked', error: new MixedError('review_rejected', detail) }
      }
    }
    await this.#transition('finalizing', { type: 'status_changed', summary: '审核通过，准备交付' })
    const delivery = await this.#finalize(currentPlan)
    await this.#transition('succeeded', { type: 'status_changed', summary: '交付完成' })
    return { outcome: 'succeeded', delivery }
  }

  /** 从证据目录读原基线（恢复用）；缺失则返回 null（调用方决定回退）。 */
  async #loadBaseline() {
    const file = path.join(this.collector.dirFor(this.run.runId), 'baseline', 'baseline.json')
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }

  // ---------- 恢复对账（T09 / §5.4：先核对，再重入；不承诺 exactly-once）----------

  /**
   * 恢复前对账：
   * - 'running' 任务 = 宿主死亡/停止时派发未完成 → 回 'ready'（结果不明的 attempt 不自动重放，
   *   重新派发记新 attempt，旧 attempt 保留诊断）；
   * - choice='retry'：'failed' 任务及其传递受阻后继（blocked）一并回 'ready'（重试失败链）。
   */
  async #reconcileForResume(resume) {
    const cur = this.#fresh()
    const tasks = cur.tasks ?? []
    const running = tasks.filter((t) => t.status === 'running')
    const retrySet = new Set()
    if (resume?.kind === 'retry') {
      const byId = new Map(tasks.map((t) => [t.taskId, t]))
      for (const t of tasks) if (t.status === 'failed') retrySet.add(t.taskId)
      let grew = true
      while (grew) {
        grew = false
        for (const t of tasks) {
          if (t.status !== 'blocked' || retrySet.has(t.taskId)) continue
          const deps = t.dependsOnTaskIds ?? []
          if (
            deps.length > 0 &&
            deps.every((d) => {
              const s = byId.get(d)?.status
              return s === 'executed' || s === 'accepted' || retrySet.has(d)
            })
          ) {
            retrySet.add(t.taskId)
            grew = true
          }
        }
      }
    }
    const reset = new Set([...running.map((t) => t.taskId), ...retrySet])
    if (reset.size === 0) return
    await this.store.updateRun(cur.runId, (c) =>
      advanceRun(c, {
        ownerKey: c.ownerKey,
        ownerEpoch: c.ownerEpoch,
        event: {
          type: 'resume_reconciled',
          summary: `恢复对账：${running.length} 个中断任务回 ready${retrySet.size ? `；${retrySet.size} 个失败/受阻任务回 ready（retry）` : ''}（结果不明不自动重放）`,
        },
        patch: {
          tasks: c.tasks.map((t) =>
            reset.has(t.taskId) ? { ...t, status: 'ready', blockedReason: undefined } : t,
          ),
        },
      }),
    )
  }

  /**
   * 按持久化状态选恢复重入阶段（§5.1/§5.4）：
   * - 无计划 → planning（规划/派发前中断，无实施副作用，可安全重规划）；
   * - 任务未完 → executing（复用 planVersion；调度器跳过 executed/accepted）；
   * - 任务全完 + 审核未完 → reviewing（中断轮结果未知 → 重跑该轮，不采信不明结果）；
   * - 任务全完 + 审核 pass → finalizing（只重试 finalizing，不重跑实施）；
   * - 审核结论 blocked / 返修耗尽 → 拒绝（resume_not_allowed，建议重跑）。
   */
  #resumeEntry(resume) {
    const cur = this.#fresh()
    // 缺关键需求的补充回答：必须先于「已有计划 → executing」判断，否则草稿计划会被误实施
    if (cur.status === 'waiting_input') {
      return { phase: 'planning', plan: null, startRound: 0 }
    }
    const plan = (cur.planVersions ?? []).at(-1) ?? null
    if (!plan) {
      return { phase: 'planning', plan: null, startRound: 0 }
    }
    const tasks = cur.tasks ?? []
    const allDone = tasks.length > 0 && tasks.every((t) => t.status === 'executed' || t.status === 'accepted')
    if (!allDone) {
      return { phase: 'executing', plan, startRound: 0 }
    }
    const lastRound = (cur.reviewRounds ?? []).at(-1)
    if (!lastRound || lastRound.result == null) {
      // continue：沿用已耗轮次（run 级预算不重置）；retry：重置返修预算（用户明确重试）
      const startRound = resume?.kind === 'retry' ? 0 : (cur.reviewRounds ?? []).length
      if (startRound > this.maxRepairRounds) {
        throw new MixedError(
          'resume_not_allowed',
          `审核/返修轮次已耗尽（上限 ${this.maxRepairRounds} 轮返修）：建议「用新需求重跑」而不是恢复`,
        )
      }
      return { phase: 'reviewing', plan, startRound }
    }
    if (lastRound.result.verdict === 'pass') {
      return { phase: 'finalizing', plan, startRound: 0 }
    }
    throw new MixedError(
      'resume_not_allowed',
      `最近审核结论为「${lastRound.result.verdict}」（返修/证据不足已耗尽）：建议「用新需求重跑」而不是恢复`,
    )
  }

  // ---------- 阶段 ----------

  /** 计划里仍有未回答的关键问题 → 进入 waiting_input，不派发实施。 */
  #unansweredOf(plan) {
    const answered = new Set(
      (this.#fresh().pendingQuestions ?? [])
        .filter((q) => typeof q.answer === 'string' && q.answer.trim() !== '')
        .map((q) => q.text),
    )
    return (plan?.openQuestions ?? []).map(String).filter((t) => t.trim() && !answered.has(t))
  }

  #needsInput(plan) {
    return this.#unansweredOf(plan).length > 0
  }

  async #enterWaitingInput(plan) {
    const unanswered = this.#unansweredOf(plan)
    await this.store.updateRun(this.run.runId, (cur) => {
      const existing = cur.pendingQuestions ?? []
      const nextId = existing.reduce((n, q) => {
        const m = /^q(\d+)$/.exec(q.questionId)
        return m ? Math.max(n, Number(m[1])) : n
      }, 0)
      const added = unanswered.map((text, i) => ({ questionId: `q${nextId + i + 1}`, text }))
      return advanceRun(cur, {
        ownerKey: cur.ownerKey,
        ownerEpoch: cur.ownerEpoch,
        to: 'waiting_input',
        event: { type: 'waiting_input', summary: `缺关键需求，等待补充：${added.map((q) => q.questionId).join('、')}` },
        patch: {
          // 草稿计划可见，但不把 tasks 写成可派发状态（恢复走重规划）
          planVersions: [...cur.planVersions, { ...plan, tasks: plan.tasks, taskRecords: plan.taskRecords }],
          pendingQuestions: [...existing, ...added],
        },
      })
    })
  }

  async #plan() {
    // 一次格式纠正：结构化输出缺失/图校验失败 → 重试一次（带错误说明）
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt =
        attempt === 0
          ? this.planPrompt(this.run)
          : `${this.planPrompt(this.run)}\n\n上一次输出未通过宿主校验：${this.#lastPlanError}\n请严格按 JSON schema 重新输出。`
      const res = await this.driver.startStage({
        stage: 'planning',
        prompt,
        outputSchema: this.planSchema,
        signal: this.signal,
        disableTools: attempt > 0,
      })
      const plan = this.#parsePlan(res.structured)
      if (plan) return plan
    }
    throw new MixedError('plan_invalid', `规划两次未通过宿主校验（格式或 DAG 非法）${this.#lastPlanError ? `：${this.#lastPlanError}` : ''}`)
  }

  #parsePlan(structured) {
    if (!structured || typeof structured !== 'object') {
      this.#lastPlanError = '缺少结构化输出'
      return null
    }
    const tasks = Array.isArray(structured.tasks) ? structured.tasks : []
    const acceptance = Array.isArray(structured.acceptance) ? structured.acceptance : []
    const graph = validatePlanGraph(tasks, acceptance)
    if (!graph.ok) {
      this.#lastPlanError = graph.errors.join('；')
      return null
    }
    const version = this.run.planVersions.length ? this.run.planVersions[this.run.planVersions.length - 1].version + 1 : 1
    return {
      version,
      goal: String(structured.goal ?? this.run.goal),
      interpretation: structured.interpretation ? String(structured.interpretation) : undefined,
      knownFacts: [],
      assumptions: Array.isArray(structured.assumptions) ? structured.assumptions : [],
      openQuestions: Array.isArray(structured.openQuestions) ? structured.openQuestions : [],
      acceptance,
      tasks: tasks.map((t) => t.taskId),
      verificationMethods: Array.isArray(structured.verificationMethods) ? structured.verificationMethods : [],
      taskRecords: tasks,
    }
  }

  async #execute(plan, { savePlan = true } = {}) {
    if (savePlan) {
      // 保存 planVersion + tasks，然后交给调度器（拓扑串行 + ready 集 + 依赖失败阻断）
      await this.store.updateRun(this.run.runId, (cur) =>
        advanceRun(cur, {
          ownerKey: cur.ownerKey,
          ownerEpoch: cur.ownerEpoch,
          event: { type: 'plan_saved', summary: `planVersion=${plan.version} 任务 ${plan.tasks.length} 个` },
          patch: { planVersions: [...cur.planVersions, { ...plan, tasks: plan.tasks }], tasks: plan.taskRecords },
        }),
      )
    } else {
      // 恢复：复用既有 planVersion（不新增版本；任务状态以 run.tasks 最新投影为准）
      await this.store.updateRun(this.run.runId, (cur) =>
        advanceRun(cur, {
          ownerKey: cur.ownerKey,
          ownerEpoch: cur.ownerEpoch,
          event: { type: 'resume_executing', summary: `恢复实施：复用 planVersion=${plan.version}（跳过 executed/accepted 任务）` },
        }),
      )
    }
    // T06：实施前采集工作区基线（Git 保留用户已有 staged/unstaged/untracked；对比基线才算本轮成果）
    if (this.collector) {
      if (savePlan) {
        this.baseline = await this.collector.collectBaseline(this.store, this.run)
      } else {
        // 恢复：复用原基线（产物 diff 仍以 run 开始时的基线为准——重启不重算「本轮成果」）；
        // 基线缺失（在基线采集前就中断）才重新采集
        this.baseline = (await this.#loadBaseline()) ?? (await this.collector.collectBaseline(this.store, this.run))
      }
    }
    // 工作区写锁：整个执行阶段（含返修轮）持有；规范化路径，阻止同宿主冲突 run
    const lock = acquireWorkspaceWriteLock(this.run.workspace.canonicalPath, this.run.runId, this.workspaceLocks)
    try {
      for (let round = 0; ; round++) {
        const result = await executeTaskGraph({
          store: this.store,
          driver: this.driver,
          run: this.run,
          plan,
          signal: this.signal,
          taskPrompt: this.taskPrompt,
        })
        if (result.complete) {
          // T06：宿主证据——产物清单（对基线内容级 diff）+ 宿主验证（实际执行测试进程）
          if (this.collector) {
            await this.collector.collectAfterExecution({
              store: this.store,
              run: this.run,
              baseline: this.baseline,
              plan,
              signal: this.signal,
            })
          }
          return
        }
        if (round >= this.maxReplans) {
          // 重新拆分次数耗尽 → execute() catch 路径持久化 blocked（code=task_failed）
          throw new MixedError(
            'task_failed',
            `实施未完成：失败 ${result.failed.join('、') || '无'}；受阻 ${result.blocked.join('、') || '无'}`,
            { result },
          )
        }
        // 有依据重新规划：executing → planning → 新 planVersion（失效传播）→ 回到 executing
        plan = await this.#replan(result, plan)
        await this.#transition('executing', { type: 'status_changed', summary: `重新拆分完成（planVersion=${plan.version}），继续实施` })
      }
    } finally {
      lock.release()
    }
  }

  /** 重新拆分：失败上下文 → 规划模型（一次格式纠正）→ 新 planVersion + 失效传播。 */
  async #replan(result, prevPlan) {
    await this.#transition('planning', { type: 'status_changed', summary: '有依据重新规划（实施失败）' })
    const cur = this.#fresh()
    const pick = (id) => {
      const t = cur.tasks.find((x) => x.taskId === id)
      return { taskId: id, title: t?.title ?? id, ...(t?.blockedReason ? { blockedReason: t.blockedReason } : {}) }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = this.planPrompt(cur, {
        replan: {
          reason: result.failed.length
            ? `任务 ${result.failed.join('、')} 实施失败`
            : '存在无法继续的任务，需要重新拆分',
          failedTasks: result.failed.map(pick),
          executedTasks: result.executed.map(pick),
        },
        formatError: attempt === 0 ? undefined : this.#lastPlanError,
      })
      const res = await this.driver.startStage({
        stage: 'planning',
        prompt,
        outputSchema: this.planSchema,
        signal: this.signal,
        disableTools: attempt > 0,
      })
      const plan = this.#parsePlan(res.structured)
      if (plan) {
        const { version } = await applyReplan({
          store: this.store,
          runId: this.run.runId,
          newPlan: plan,
          supersedes: prevPlan.version,
          reason: result.failed.length ? `任务 ${result.failed.join('、')} 失败后重新拆分` : '重新拆分',
          failedTaskIds: result.failed,
        })
        plan.version = version
        return plan
      }
    }
    throw new MixedError('plan_invalid', '重新拆分两次未通过宿主校验')
  }

  /**
   * 审核闭环（T06）：
   * 每轮 = 证据刷新（失效检查/返修后重跑验证）→ 宿主 manifest → 落盘轮次 → 派发审核
   * → 宿主 verdict 校验（一次格式纠正）→ 回填。pass 前复核「审后修改」（输入树再变 → 重审）；
   * changes_requested → findings 分派 taskId 返修 → 重跑受影响验证 → 整体再审；
   * 返修轮耗尽 / 审核两次非法 / 证据不足 → 上抛 blocked。
   */
  async #reviewLoop(plan, { startRound = 0 } = {}) {
    let staleRetries = 0
    for (let round = startRound; ; round++) {
      if (this.signal?.aborted) throw new MixedError('run_not_in_status', 'run 被停止')
      const root = this.run.workspace.canonicalPath

      // 1) 证据刷新：输入树变化 → 旧验证证据作废；返修轮重跑验证（绑定新指纹）
      if (this.collector) {
        const tree = hashTree(root)
        await this.collector.invalidateStale(this.store, this.run, tree.fingerprint)
        if (round > 0) {
          await this.collector.collectAfterExecution({
            store: this.store,
            run: this.run,
            baseline: this.baseline,
            plan: this.#fresh().planVersions.at(-1),
            signal: this.signal,
          })
        }
      }

      // 2) 宿主 manifest（权威；审核必须原样回填）
      const runNow = this.#fresh()
      const manifestHash = this.collector ? this.collector.manifestHash(runNow) : 'pending'
      const manifest = this.collector ? JSON.parse(this.collector.manifest(runNow)).items : []
      const hostVerification = this.collector ? this.collector.verificationExitsOf(runNow.runId) : new Map()

      // 3) 落盘审核轮（崩溃窗口保护：result 先 null）
      const roundId = newId('rev')
      await this.store.updateRun(this.run.runId, (cur) =>
        advanceRun(cur, {
          ownerKey: cur.ownerKey,
          ownerEpoch: cur.ownerEpoch,
          event: { type: 'review_started', summary: `第 ${round + 1} 轮审核（manifest ${manifestHash.slice(0, 12)}…）` },
          patch: {
            reviewRounds: [...cur.reviewRounds, { roundId, planVersion: plan.version, evidenceManifestHash: manifestHash, result: null, startedAt: new Date().toISOString() }],
          },
        }),
      )

      // 4) 派发审核（一次格式纠正：宿主校验错误带回去重写）
      let rawResult = null
      let lastError = null
      for (let attempt = 0; attempt < 2; attempt++) {
        const promptBase = this.reviewPrompt(this.#fresh(), plan, { manifestHash, manifest, hostVerification })
        const prompt =
          attempt === 0 ? promptBase : `${promptBase}\n\n上一次审核输出未通过宿主校验：${lastError}\n请严格按 schema 与宿主事实重新输出。`
        const res = await this.driver.startStage({
          stage: 'review',
          prompt,
          outputSchema: this.reviewSchema,
          signal: this.signal,
          disableTools: attempt > 0,
        })
        rawResult = res.structured
        const cur = this.#fresh()
        const validation = this.collector
          ? validateReviewOutput({
              run: cur,
              review: rawResult ?? {},
              manifestHash,
              planVersion: plan.version,
              verificationExits: this.collector.verificationExitsOf(cur.runId),
            })
          : {
              ok: !!rawResult && ['pass', 'changes_requested', 'blocked'].includes(rawResult?.verdict),
              errors: rawResult ? [] : ['缺少结构化审核结论'],
            }
        if (validation.ok) break
        lastError = validation.errors.join('；')
        if (attempt === 1) throw new MixedError('review_rejected', `审核输出两次未通过宿主校验：${lastError}`)
      }

      // 5) 宿主托管字段回填 + 落盘
      // 写边界形状兜底：store 记录 schema（contracts）是最终门槛，structured_output 通道不能
      // 假设 100% 合规——缺 string 字段补 ''、severity 收敛到 store 枚举、note 兼容映射到
      // explanation（历史上 LLM schema 误用 note/可选 → 回填写被 zod 拒收 → run 冻结）。
      const str = (v) => (typeof v === 'string' ? v : '')
      const result = {
        verdict: rawResult.verdict,
        planVersion: plan.version,
        evidenceManifestHash: manifestHash,
        criteria: (rawResult.criteria ?? []).map((c) => ({
          acceptanceId: c.acceptanceId,
          status: c.status,
          evidenceIds: Array.isArray(c.evidenceIds) ? c.evidenceIds : [],
          explanation: str(c.explanation) !== '' ? str(c.explanation) : str(c.note),
        })),
        findings: (rawResult.findings ?? []).map((f) => ({
          findingId: f.findingId,
          taskIds: Array.isArray(f.taskIds) ? f.taskIds : [],
          severity: f.severity === 'blocking' ? 'blocking' : 'nonblocking',
          evidenceIds: Array.isArray(f.evidenceIds) ? f.evidenceIds : [],
          expected: str(f.expected),
          actual: str(f.actual),
          repairInstruction: str(f.repairInstruction),
        })),
        summary: str(rawResult.summary),
      }
      const verdict = result.verdict
      await this.store.updateRun(this.run.runId, (cur) =>
        advanceRun(cur, {
          ownerKey: cur.ownerKey,
          ownerEpoch: cur.ownerEpoch,
          event: { type: 'review_round', summary: `第 ${round + 1} 轮结论 ${verdict}` },
          patch: {
            reviewRounds: cur.reviewRounds.map((r) =>
              r.roundId === roundId ? { ...r, result: structuredClone(result), endedAt: new Date().toISOString() } : r,
            ),
          },
        }),
      )

      // 6) pass：复核「审后修改」——验证绑定指纹之后工作区又变了 → 证据作废，重审（限一次）
      if (verdict === 'pass' && this.collector) {
        const cur = this.#fresh()
        const bound = [...cur.evidence].reverse().find((e) => e.type === 'verification')?.fingerprint
        const tree2 = hashTree(root)
        if (bound && tree2.fingerprint !== bound) {
          if (staleRetries++ >= 1) throw new MixedError('evidence_invalid', '重审后工作区再次变化，无法以当前证据交付')
          this.logger.warn?.('审后检测到工作区变化：验证证据作废，重新审核')
          continue
        }
      }
      if (verdict === 'pass') return 'pass'
      if (verdict === 'blocked') return 'blocked'
      // changes_requested
      if (round + 1 > this.maxRepairRounds) return 'changes_requested' // 返修轮耗尽

      // 7) 返修：findings 分派 taskId → 受影响任务重跑 → 回 reviewing（下一轮重跑验证+整体再审）
      await this.#transition('repairing', { type: 'status_changed', summary: `第 ${round + 1} 轮返修` })
      const { repairTaskIds } = await applyRepair({
        store: this.store,
        runId: this.run.runId,
        findings: result.findings,
        criteria: result.criteria,
      })
      if (repairTaskIds.length) {
        const planFresh = this.#fresh().planVersions.at(-1)
        const exec = await executeTaskGraph({
          store: this.store,
          driver: this.driver,
          run: this.run,
          plan: planFresh,
          signal: this.signal,
          taskPrompt: this.taskPrompt,
        })
        if (!exec.complete) {
          throw new MixedError('task_failed', `返修未完成：失败 ${exec.failed.join('、') || '无'}；受阻 ${exec.blocked.join('、') || '无'}`)
        }
      }
      await this.#transition('reviewing', { type: 'status_changed', summary: '返修完成，重新审核（重跑受影响验证）' })
    }
  }

  async #finalize(plan) {
    // 交付体（§8）：验收项、产物、验证结果、审核结论、限制
    const cur = this.#fresh()
    const review = cur.reviewRounds[cur.reviewRounds.length - 1]?.result
    return {
      runId: this.run.runId,
      goal: this.run.goal,
      planVersion: plan.version,
      accepted: review?.criteria?.filter((c) => c.status === 'pass')?.map((c) => c.acceptanceId) ?? [],
      unverified: review?.criteria?.filter((c) => c.status === 'unverified')?.map((c) => c.acceptanceId) ?? [],
      summary: review?.summary ?? '审核通过',
      tasks: cur.tasks.map((t) => ({ taskId: t.taskId, title: t.title, status: t.status })),
      limitations: ['本机指纹检测不覆盖其他机器/编辑器的并发修改'],
    }
  }

  // ---------- 状态迁移（写链内校验 owner/epoch/迁移合法性）----------

  #transition(to, event, patch = {}) {
    return this.store.updateRun(this.run.runId, (cur) =>
      advanceRun(cur, {
        ownerKey: cur.ownerKey,
        ownerEpoch: cur.ownerEpoch,
        to,
        event,
        patch,
      }),
    )
  }

  // ---------- Stop 收敛 ----------

  /** 停止请求（幂等）：先持久化取消意图，再级联 abort + agent.cancel（cause 可序列化——C6）。 */
  async requestStop(reason = 'user-stop') {
    if (this.aborted) return
    this.aborted = true
    try {
      await this.store.updateRun(this.run.runId, (cur) =>
        advanceRun(cur, {
          ownerKey: cur.ownerKey,
          ownerEpoch: cur.ownerEpoch,
          to: cur.status === 'cancelling' || RUN_IS_FINAL(cur.status) ? undefined : 'cancelling',
          cancelling: true, // →cancelling 迁移需要显式取消标志（§5.1）
          event: { type: 'cancel_requested', summary: reason },
          patch: { cancelRequestedAt: new Date().toISOString() },
        }),
      )
    } catch (error) {
      this.logger.error?.(`取消意图落盘失败: ${String(error)}`)
    }
    this.#self.abort()
    this.driver.abortAll()
    // agent.cancel 清空 inbox + abort 当前 phase；cause 必须是可序列化对象（C6 怪癖 1）
    if (this.agent?.cancel) {
      const curStatus = this.store.getRun(this.run.runId)?.status ?? this.run.status
      try {
        this.agent.cancel({ kind: 'user-stop', runId: this.run.runId, stage: curStatus })
      } catch {
        /* 已在取消/已结束 */
      }
    }
  }

  /** 等待收敛后写 cancelled（Stop API 调用；202 语义由 API 层保证）。 */
  async #convergeCancelled() {
    try {
      const cur = this.#fresh()
      // 意图落盘失败时状态可能还停在中间态：先补 cancelling，再 cancelled（两次条件更新）
      if (cur && !RUN_IS_FINAL(cur.status) && cur.status !== 'cancelling') {
        await this.store.updateRun(this.run.runId, (c) =>
          advanceRun(c, {
            ownerKey: c.ownerKey,
            ownerEpoch: c.ownerEpoch,
            to: 'cancelling',
            cancelling: true,
            event: { type: 'cancel_requested', summary: '停止收敛中（意图补记）' },
          }),
        )
      }
      await this.store.updateRun(this.run.runId, (cur2) =>
        advanceRun(cur2, {
          ownerKey: cur2.ownerKey,
          ownerEpoch: cur2.ownerEpoch,
          to: cur2.status === 'cancelled' ? undefined : 'cancelled',
          event: { type: 'status_changed', summary: '已停止，所有阶段收敛' },
        }),
      )
    } catch {
      // 已在 cancelled / 写失败：保留现状，诊断可见
    }
  }
}

function RUN_IS_FINAL(status) {
  return status === 'succeeded' || status === 'cancelled'
}
