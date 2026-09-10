/**
 * Mixed 用量归属（T10）：宿主在 attempt 开始/结束时向网关登记「当前活跃 attempt」，
 * llm-proxy 在记账时把该 attempt 的 run/task/stage 维度写进账本 extra。
 *
 * 设计约束（见 docs/superpowers/plans/2026-09-09-mixed-mode-implementation.md T10）：
 * - 内核→网关请求体没有归属元数据通道（T01 wire 实测）→ 只能按「时间窗 + 用户」关联；
 * - 关联上下文只存活于网关内存：网关重启丢上下文 → 该窗口内的请求未关联（账本如实缺，
 *   UI 显示「未知」而不是 0——未知值可见）；
 * - 宿主被强杀时 close 不会来 → TTL（默认 45min，> 单 attempt 最长生命周期 35min 弃置）
 *   自动过期，避免把之后的无关请求错记到死 attempt 上；
 * - 同一用户多个活跃 attempt（并发 run）→ 请求记为 ambiguous（可见，不悄悄归错）。
 * - 内部元数据（run/task/attempt id、userId）只进本网关账本 extra，绝不注入上游请求体。
 */

const DEFAULT_TTL_MS = 45 * 60_000

const CTX_SHAPE = {
  runId: (v) => typeof v === 'string' && /^run-[0-9a-f]{16,32}$/.test(v) ? v : null,
  attemptId: (v) => typeof v === 'string' && /^att_[0-9a-f-]{8,64}$/.test(v) ? v : null,
  stage: (v) => typeof v === 'string' && v.length > 0 && v.length <= 32 ? v : null,
  taskId: (v) => (v == null ? null : typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null),
}

export class MixedAttribution {
  /**
   * @param {object} [opts]
   * @param {number} [opts.ttlMs] 上下文存活上限（默认 45min）
   * @param {number} [opts.maxPerUser] 每用户活跃上下文上限（默认 8；超出淘汰最旧）
   * @param {() => number} [opts.now] 时钟（测试注入）
   */
  constructor({ ttlMs = DEFAULT_TTL_MS, maxPerUser = 8, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs
    this.maxPerUser = maxPerUser
    this.now = now
    /** @type {Map<string, Array<{runId, taskId, stage, attemptId, openedAt, lastTouched}>>} userId → 活跃上下文 */
    this.ctxByUser = new Map()
  }

  #purge(userId) {
    const list = this.ctxByUser.get(userId)
    if (!list) return
    const t = this.now()
    const kept = list.filter((c) => t - c.openedAt < this.ttlMs)
    if (kept.length === list.length) return
    if (kept.length) this.ctxByUser.set(userId, kept)
    else this.ctxByUser.delete(userId)
  }

  /**
   * 登记一个活跃 attempt（幂等：同 attemptId 重开只刷新 lastTouched，不新增）。
   * @returns {{ok: boolean, reason?: string}}
   */
  open(userId, { runId, taskId, stage, attemptId, startedAt } = {}) {
    if (!userId) return { ok: false, reason: 'missing_user' }
    const clean = {
      runId: CTX_SHAPE.runId(runId),
      attemptId: CTX_SHAPE.attemptId(attemptId),
      stage: CTX_SHAPE.stage(stage),
      taskId: CTX_SHAPE.taskId(taskId),
    }
    if (!clean.runId) return { ok: false, reason: 'bad_runId' }
    if (!clean.attemptId) return { ok: false, reason: 'bad_attemptId' }
    if (!clean.stage) return { ok: false, reason: 'bad_stage' }
    this.#purge(userId)
    const list = this.ctxByUser.get(userId) ?? []
    const t = this.now()
    const existing = list.find((c) => c.attemptId === clean.attemptId)
    if (existing) {
      existing.lastTouched = t
      return { ok: true }
    }
    list.push({
      runId: clean.runId,
      taskId: clean.taskId ?? null,
      stage: clean.stage,
      attemptId: clean.attemptId,
      openedAt: typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : t,
      lastTouched: t,
    })
    // 上限淘汰最旧（防御性：正常 Mixed 每用户并发 attempt ≤ 少数）
    while (list.length > this.maxPerUser) list.shift()
    this.ctxByUser.set(userId, list)
    return { ok: true }
  }

  /** 关闭 attempt 上下文（幂等）。@returns {{ok: boolean}} */
  close(userId, { attemptId } = {}) {
    const clean = CTX_SHAPE.attemptId(attemptId)
    if (!userId || !clean) return { ok: false, reason: 'bad_attemptId' }
    const list = this.ctxByUser.get(userId)
    if (!list) return { ok: true }
    const idx = list.findIndex((c) => c.attemptId === clean)
    if (idx >= 0) list.splice(idx, 1)
    if (list.length) this.ctxByUser.set(userId, list)
    else this.ctxByUser.delete(userId)
    return { ok: true }
  }

  /**
   * 当前活跃上下文（已剔除过期）。
   * @returns {Array<{runId, taskId, stage, attemptId}>}
   */
  activeFor(userId) {
    this.#purge(userId)
    const list = this.ctxByUser.get(userId) ?? []
    return list.map(({ runId, taskId, stage, attemptId }) => ({ runId, taskId, stage, attemptId }))
  }

  /** 活跃上下文总数（健康/测试用）。 */
  size() {
    for (const u of [...this.ctxByUser.keys()]) this.#purge(u)
    let n = 0
    for (const list of this.ctxByUser.values()) n += list.length
    return n
  }
}
