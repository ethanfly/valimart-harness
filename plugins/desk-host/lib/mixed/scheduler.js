/**
 * Mixed 任务调度器（T05）：ready 集、拓扑串行实施、依赖失败阻断、失效传播、工作区写锁。
 *
 * - P0 串行：一次只派发一个任务；工作区写锁在整个执行阶段持有（跨返修轮），
 *   阻止同宿主其他 Mixed run 并发写同一工作区（规范化路径，区分大小写按平台）。
 * - 任务可 ready 的条件：状态 pending/ready/stale 且全部依赖 ∈ {executed, accepted}
 *   （stale 重就绪 = 失效传播后的重新实施；依赖仍 stale 时后继继续等待）。
 * - 依赖失败不继续运行其后继：失败任务的传递后继标记 blocked（带原因），
 *   无依赖关系的独立分支继续执行（同模型多 taskId 独立跟踪）。
 * - 任务完成只进入 executed（等待审核）；accepted/stale 由审核层/失效传播写入。
 * - 重新拆分（applyReplan）：新 planVersion（supersedes+reason），已验证任务保留，
 *   失败根及其传递后继标记 stale 后重新实施；旧 attempt/证据保留来源不清除。
 */
import path from 'node:path'
import {
  MixedError,
  advanceRun,
  taskReady,
  TASK_DEP_SATISFIED,
} from './contracts.js'

// ---------- 工作区写锁（规范化、单宿主）----------
//
// 注册表可注入（控制器/测试各用独立表，避免并发测试互相清锁）；
// 生产宿主用模块级默认表（单进程单宿主）。

/** 生产默认注册表（单宿主进程内共享）。 */
export const defaultWorkspaceLocks = new Map() // normalizedPath -> { runId, acquiredAt }

/** 新建独立注册表（测试用）。 */
export function createWorkspaceLocks() {
  return new Map()
}

/** 规范化工作区路径（Windows 不区分大小写；去尾部分隔符——Windows normalize 会保留它）。 */
export function normalizeWorkspacePath(p) {
  let n = path.normalize(String(p ?? ''))
  if (process.platform === 'win32') {
    n = n.toLowerCase()
    // 盘符根（c:\，长度 3）保留；其余尾部 \ 或 / 去掉
    if (n.length > 3 && (n.endsWith('\\') || n.endsWith('/'))) n = n.slice(0, -1)
  }
  return n
}

/**
 * 获取工作区写锁。同一 run 重入幂等；其他 run 占用 → MixedError('workspace_conflict')。
 * @returns {{key: string, release: () => void}}
 */
export function acquireWorkspaceWriteLock(workspacePath, runId, locks = defaultWorkspaceLocks) {
  const key = normalizeWorkspacePath(workspacePath)
  if (!key) throw new MixedError('storage_unhealthy', '工作区路径为空，无法加写锁')
  const cur = locks.get(key)
  if (cur && cur.runId !== runId) {
    throw new MixedError('workspace_conflict', `工作区正被另一 Mixed run 写入：${key}（持有者 ${cur.runId}）`, {
      holderRunId: cur.runId,
    })
  }
  if (!cur) locks.set(key, { runId, acquiredAt: new Date().toISOString() })
  return { key, release: () => releaseWorkspaceWriteLock(key, runId, locks) }
}

/** 释放工作区写锁（仅持有者可释放）。 */
export function releaseWorkspaceWriteLock(workspacePath, runId, locks = defaultWorkspaceLocks) {
  const key = normalizeWorkspacePath(workspacePath)
  const cur = locks.get(key)
  if (cur && cur.runId === runId) locks.delete(key)
}

/** 当前持有者（测试/诊断用）。 */
export function workspaceLockHolder(workspacePath, locks = defaultWorkspaceLocks) {
  return locks.get(normalizeWorkspacePath(workspacePath)) ?? null
}

/** 测试用：清空锁表。 */
export function _resetWorkspaceLocks(locks = defaultWorkspaceLocks) {
  locks.clear()
}

// ---------- 图工具 ----------

/**
 * 传递后继集：所有（直接或传递）依赖 rootIds 中任意任务的任务 id（不含根自身）。
 * @param {object[]} tasks 任务记录
 * @param {string[]} rootIds 根任务 id
 * @returns {Set<string>}
 */
export function transitiveDependents(tasks, rootIds) {
  const byId = new Map(tasks.map((t) => [t.taskId, t]))
  const dependents = new Map() // depId -> [taskIds]
  for (const t of tasks) for (const dep of t.dependsOnTaskIds ?? []) {
    if (!dependents.has(dep)) dependents.set(dep, [])
    dependents.get(dep).push(t.taskId)
  }
  const out = new Set()
  const queue = [...rootIds]
  while (queue.length) {
    const id = queue.shift()
    for (const next of dependents.get(id) ?? []) {
      if (!out.has(next)) {
        out.add(next)
        queue.push(next)
      }
    }
  }
  return out
}

/** 某任务是否可调度（contracts.taskReady + stale 重就绪）。 */
export function isTaskReady(task, byId) {
  if (taskReady(task, byId)) return true
  if (task.status === 'stale') {
    for (const dep of task.dependsOnTaskIds ?? []) {
      const d = byId.get(dep)
      if (!d || !TASK_DEP_SATISFIED.has(d.status)) return false
    }
    return true
  }
  return false
}

/** 当前可调度任务（稳定排序由调用方按 plan 顺序定）。 */
export function readyTasks(tasks) {
  const byId = new Map(tasks.map((t) => [t.taskId, t]))
  return tasks.filter((t) => isTaskReady(t, byId))
}

/** 计划顺序稳定排序（plan.tasks 顺序；未知任务垫后）。 */
export function byPlanOrder(tasks, planTaskIds) {
  const order = new Map(planTaskIds.map((id, i) => [id, i]))
  return [...tasks].sort((a, b) => (order.get(a.taskId) ?? 9999) - (order.get(b.taskId) ?? 9999))
}

// ---------- 执行 ----------

/**
 * 串行执行 planVersion 的任务图（P0：一次一个）。
 *
 * 派发循环：读最新 run 投影 → 取 ready 集（plan 顺序）→ 落 ready/running →
 * driver.startStage(execution) → 落 executed；失败 → 落 failed 并把传递后继标 blocked，
 * 独立分支继续。循环结束条件：无 ready 或达到单轮派发上限。
 *
 * @param {object} params
 * @param {import('./store.js').MixedStore} params.store
 * @param {import('./dsh-driver.js').MixedDriver} params.driver
 * @param {object} params.run 初始 RunRecord 投影（runId 有效即可；循环内读最新）
 * @param {object} params.plan 当前 planVersion 对象（{version, tasks: string[], ...}）
 * @param {AbortSignal} [params.signal] run 取消信号
 * @param {(run: object, task: object, byId: Map) => string} params.taskPrompt 任务提示词构造
 * @param {number} [params.maxDispatches] 单轮派发安全上限（防 stale 抖动死循环）
 * @returns {Promise<{complete: boolean, executed: string[], failed: string[], blocked: string[], dispatches: number}>}
 */
export async function executeTaskGraph({ store, driver, run, plan, signal, taskPrompt, maxDispatches = 64 }) {
  const runId = run.runId
  const executed = []
  const failed = []
  let dispatches = 0

  for (;;) {
    if (signal?.aborted) throw new MixedError('run_not_in_status', 'run 被停止')
    if (dispatches >= maxDispatches) {
      throw new MixedError('scheduler_deadlock', `单轮派发超过上限 ${maxDispatches}，疑似 stale/依赖抖动`)
    }
    const cur = store.getRun(runId)
    if (!cur) throw new MixedError('run_not_found', `run 不存在: ${runId}`)
    const ready = byPlanOrder(readyTasks(cur.tasks), plan.tasks)
    if (!ready.length) break
    const task = ready[0]

    // pending/stale → ready（状态机 pending→ready→running→executed）
    await store.updateRun(runId, (c) =>
      advanceRun(c, {
        ownerKey: c.ownerKey,
        ownerEpoch: c.ownerEpoch,
        event: { type: 'task_ready', summary: `${task.taskId} ${task.title}` },
        patch: { tasks: c.tasks.map((t) => (t.taskId === task.taskId ? { ...t, status: 'ready' } : t)) },
      }),
    )
    // ready → running（派发前落盘）
    await store.updateRun(runId, (c) =>
      advanceRun(c, {
        ownerKey: c.ownerKey,
        ownerEpoch: c.ownerEpoch,
        event: { type: 'task_dispatched', summary: `${task.taskId} ${task.title}` },
        patch: { tasks: c.tasks.map((t) => (t.taskId === task.taskId ? { ...t, status: 'running' } : t)) },
      }),
    )
    dispatches++

    let stopReason = null
    try {
      const fresh = store.getRun(runId)
      const byId = new Map(fresh.tasks.map((t) => [t.taskId, t]))
      const res = await driver.startStage({
        stage: 'execution',
        prompt: taskPrompt(fresh, task, { byId }),
        signal,
        taskId: task.taskId,
        planVersion: plan.version,
      })
      stopReason = res.stopReason
    } catch (error) {
      // Stop/取消（driver 以 run_not_in_status 表达）→ 原样上抛，控制器收敛 cancelled
      if (error instanceof MixedError && error.code === 'run_not_in_status') throw error
      const detail = String(error?.message ?? error)
      await store.updateRun(runId, (c) =>
        advanceRun(c, {
          ownerKey: c.ownerKey,
          ownerEpoch: c.ownerEpoch,
          event: { type: 'task_failed', summary: `${task.taskId} ${detail}` },
          patch: {
            tasks: c.tasks.map((t) =>
              t.taskId === task.taskId ? { ...t, status: 'failed', blockedReason: detail } : t,
            ),
          },
        }),
      )
      failed.push(task.taskId)
      // 依赖失败阻断后继：传递后继标 blocked（不派发）
      const fresh = store.getRun(runId)
      const blocked = transitiveDependents(fresh.tasks, [task.taskId])
      if (blocked.size) {
        await store.updateRun(runId, (c) =>
          advanceRun(c, {
            ownerKey: c.ownerKey,
            ownerEpoch: c.ownerEpoch,
            event: { type: 'tasks_blocked', summary: `${task.taskId} 失败，阻断 ${[...blocked].join('、')}` },
            patch: {
              tasks: c.tasks.map((t) =>
                blocked.has(t.taskId) ? { ...t, status: 'blocked', blockedReason: `依赖 ${task.taskId} 失败` } : t,
              ),
            },
          }),
        )
      }
      continue
    }

    // executed（只到 executed，等待审核；accepted 由审核层写入）
    await store.updateRun(runId, (c) =>
      advanceRun(c, {
        ownerKey: c.ownerKey,
        ownerEpoch: c.ownerEpoch,
        event: { type: 'task_executed', summary: `${task.taskId} ${task.title}（${stopReason}）` },
        patch: {
          tasks: c.tasks.map((t) =>
            t.taskId === task.taskId ? { ...t, status: 'executed', attemptIds: [...t.attemptIds] } : t,
          ),
        },
      }),
    )
    executed.push(task.taskId)
  }

  const cur = store.getRun(runId)
  const blocked = cur.tasks.filter((t) => t.status === 'blocked').map((t) => t.taskId)
  const allDone = cur.tasks.length > 0 && cur.tasks.every((t) => t.status === 'executed' || t.status === 'accepted')
  return { complete: allDone && failed.length === 0 && blocked.length === 0, executed, failed, blocked, dispatches }
}

// ---------- 重新拆分与失效传播 ----------

/**
 * 应用重新拆分：新 planVersion 落盘 + 任务图合并。
 *
 * 合并规则（计划 §4.2「已经通过证据验证的任务保留，受影响的后继标记 stale 后重新执行」）：
 * - stale 集 = 失败根任务的传递后继（不含已 accepted 的：验收通过不再重做）。
 * - 新计划中每个任务：旧任务同 id 且状态 executed/accepted 且不在 stale 集 → 保留原状态；
 *   其余 → pending 重做（保留旧 attemptIds/evidenceIds 来源不清除）。
 * - 旧任务不在新计划中：executed/accepted 保留（供依赖引用/证据留存）；其余移除（被新图取代）。
 *
 * @returns {Promise<{staleIds: string[], retainedIds: string[]}>}
 */
export async function applyReplan({ store, runId, newPlan, supersedes, reason, failedTaskIds = [] }) {
  const cur = store.getRun(runId)
  if (!cur) throw new MixedError('run_not_found', `run 不存在: ${runId}`)
  // stale 集排除 accepted（已验证任务保留，不再重做）
  const staleIds = new Set(
    [...transitiveDependents(cur.tasks, failedTaskIds)].filter(
      (id) => cur.tasks.find((t) => t.taskId === id)?.status !== 'accepted',
    ),
  )
  const newByTaskId = new Map(newPlan.taskRecords.map((t) => [t.taskId, t]))

  const tasks = []
  const retained = []
  // 先处理新计划任务（按新计划顺序）
  for (const nt of newPlan.taskRecords) {
    const old = cur.tasks.find((t) => t.taskId === nt.taskId)
    const keepOldStatus = old && (old.status === 'executed' || old.status === 'accepted') && !staleIds.has(nt.taskId)
    if (keepOldStatus) {
      // 保留已验证任务：用新计划的契约字段 + 旧状态与历史
      tasks.push({
        ...structuredTaskDefaults(nt),
        ...nt,
        status: old.status,
        attemptIds: [...(old.attemptIds ?? []), ...(nt.attemptIds ?? [])],
        evidenceIds: [...(old.evidenceIds ?? []), ...(nt.evidenceIds ?? [])],
        blockedReason: undefined,
      })
      retained.push(nt.taskId)
    } else {
      const merged = { ...structuredTaskDefaults(nt), ...nt, status: 'pending' }
      if (old) {
        merged.attemptIds = [...(old.attemptIds ?? [])]
        merged.evidenceIds = [...(old.evidenceIds ?? [])]
      }
      tasks.push(merged)
    }
  }
  // 旧任务不在新计划：executed/accepted 保留
  for (const old of cur.tasks) {
    if (!newByTaskId.has(old.taskId) && (old.status === 'executed' || old.status === 'accepted')) {
      tasks.push({ ...old, blockedReason: undefined })
      retained.push(old.taskId)
    }
  }

  const version = (cur.planVersions.length ? cur.planVersions.at(-1).version : 0) + 1
  const planRecord = {
    version,
    goal: newPlan.goal,
    interpretation: newPlan.interpretation,
    knownFacts: newPlan.knownFacts ?? [],
    assumptions: newPlan.assumptions ?? [],
    openQuestions: newPlan.openQuestions ?? [],
    acceptance: newPlan.acceptance,
    tasks: newPlan.tasks,
    verificationMethods: newPlan.verificationMethods ?? [],
    supersedes,
    reason,
  }

  await store.updateRun(runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      event: {
        type: 'plan_replanned',
        summary: `planVersion=${version} 取代 ${supersedes}：${reason}；stale ${[...staleIds].join('、') || '无'}`,
      },
      patch: {
        planVersions: [...c.planVersions, planRecord],
        tasks,
      },
    }),
  )
  return { staleIds: [...staleIds], retainedIds: retained, version }
}

function structuredTaskDefaults(t) {
  return {
    dependsOnTaskIds: [],
    inputRefs: [],
    expectedOutputs: [],
    pathScope: [],
    acceptanceIds: [],
    verificationHints: [],
    role: 'executor',
    status: 'pending',
    attemptIds: [],
    evidenceIds: [],
    repairNotes: [],
  }
}

// ---------- 审核返修（T06）----------

/**
 * 把审核 findings 分派到 taskId（计划 T06：修复项分派到 taskId）。
 *
 * 规则：
 * - blocking finding 指向的任务 → pending 重跑，repairNotes 追加 expected/actual/repairInstruction；
 * - 审核中判 fail 的验收项 → 认领该验收项的 executed 任务同样回 pending（验收没过的实现必须重做）；
 * - unverified 验收项不强制返修（审核可能缺证据——整体结论由宿主 verdict 校验把关）；
 * - 依赖链不动（返修任务依赖仍已满足，直接 ready）；整体再审由控制器 loop 完成。
 *
 * @returns {Promise<{repairTaskIds: string[]}>}
 */
export async function applyRepair({ store, runId, findings = [], criteria = [] }) {
  const cur = store.getRun(runId)
  if (!cur) throw new MixedError('run_not_found', `run 不存在: ${runId}`)
  const plan = cur.planVersions.at(-1)
  const acceptanceById = new Map(plan.acceptance.map((a) => [a.id, a]))

  const byId = new Map(cur.tasks.map((t) => [t.taskId, t]))
  const repair = new Map() // taskId -> string[] notes
  const note = (taskId, text) => {
    if (!byId.has(taskId)) return
    if (!repair.has(taskId)) repair.set(taskId, [])
    repair.get(taskId).push(text)
  }

  for (const f of findings.filter((f) => f.severity === 'blocking')) {
    const text = `[${f.findingId}] 期望：${f.expected}\n实际：${f.actual}\n返修指令：${f.repairInstruction}`
    for (const t of f.taskIds ?? []) note(t, text)
  }
  for (const c of criteria.filter((c) => c.status === 'fail')) {
    const item = acceptanceById.get(c.acceptanceId)
    const owners = [...byId.values()].filter((t) => t.acceptanceIds?.includes(c.acceptanceId) && (t.status === 'executed' || t.status === 'accepted'))
    for (const t of owners) {
      note(t.taskId, `[验收 ${c.acceptanceId}${item ? `：${item.description}` : ''}] 审核判定 fail：${c.explanation}`)
    }
  }
  if (!repair.size) {
    await store.updateRun(runId, (c) =>
      advanceRun(c, {
        ownerKey: c.ownerKey,
        ownerEpoch: c.ownerEpoch,
        event: { type: 'repair_assigned', summary: '返修分派：无任务需要重跑（仅非阻塞发现）' },
      }),
    )
    return { repairTaskIds: [] }
  }

  const tasks = cur.tasks.map((t) => {
    const notes = repair.get(t.taskId)
    if (!notes) return t
    return {
      ...t,
      status: 'pending',
      blockedReason: undefined,
      repairNotes: [...(t.repairNotes ?? []), ...notes],
    }
  })
  const repairTaskIds = [...repair.keys()].filter((id) => byId.has(id))

  await store.updateRun(runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      event: { type: 'repair_assigned', summary: `返修分派：${repairTaskIds.join('、')}` },
      patch: { tasks },
    }),
  )
  return { repairTaskIds }
}
