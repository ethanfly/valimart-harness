/**
 * T05 交付物：mixed-scheduler 测试（拓扑串行调度 + 依赖失败阻断 + 失效传播 + 工作区写锁）。
 *
 * 覆盖计划 T05 验收：
 * - 6 个任务共用一个 executor 正确执行（同模型多 taskId 独立跟踪；拓扑序而非列表序）；
 * - 依赖失败阻断后继（传递后继标 blocked，不派发；独立分支继续）；
 * - 重新拆分与 planVersion（supersedes+reason；已验证任务保留不重派；受影响任务重做）；
 * - 工作区写锁（规范化路径、同宿主冲突 run 被拒、不派发）；
 * - Stop 停止后续派发。
 *
 * 宿主侧用真实 mixed-store（内核真实存储栈）+ 假 subagents（脚本化阶段输出）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MixedStore } from '../../plugins/desk-host/lib/mixed/store.js'
import { MixedDriver } from '../../plugins/desk-host/lib/mixed/dsh-driver.js'
import { MixedRunController } from '../../plugins/desk-host/lib/mixed/service.js'
import {
  isTaskReady,
  transitiveDependents,
  acquireWorkspaceWriteLock,
  releaseWorkspaceWriteLock,
  workspaceLockHolder,
  createWorkspaceLocks,
} from '../../plugins/desk-host/lib/mixed/scheduler.js'
import { MixedError, submissionKeyOf, runIdOf } from '../../plugins/desk-host/lib/mixed/contracts.js'

const OWNER = { ownerKey: 'owner:aaaa', ownerEpoch: 0 }
const MODELS = {
  planner: { catalogProvider: 'deepseek', modelId: 'deepseek-v4-pro', runtimeModelId: 'deepseek-v4-pro', capabilities: { planner: true, executor: true, reviewer: true }, capabilitiesRevision: 'rev-abc123' },
  executor: { catalogProvider: 'xai', modelId: 'grok-4.6', runtimeModelId: 'grok-4.6', capabilities: { planner: false, executor: true, reviewer: true }, capabilitiesRevision: 'rev-abc123' },
  reviewer: { catalogProvider: 'deepseek', modelId: 'deepseek-v4-flash', runtimeModelId: 'deepseek-v4-flash', capabilities: { planner: false, executor: false, reviewer: true }, capabilitiesRevision: 'rev-abc123' },
}

const task = (taskId, dependsOnTaskIds = [], extra = {}) => ({
  taskId,
  dependsOnTaskIds,
  title: `任务 ${taskId}`,
  goal: `完成 ${taskId}`,
  inputRefs: [],
  expectedOutputs: [],
  pathScope: ['src'],
  acceptanceIds: ['a1'],
  verificationHints: ['node --test'],
  role: 'executor',
  status: 'pending',
  attemptIds: [],
  evidenceIds: [],
  ...extra,
})

const REVIEW_PASS = {
  verdict: 'pass',
  evidenceManifestHash: 'e-1',
  criteria: [{ acceptanceId: 'a1', status: 'pass', evidenceIds: ['e1'], explanation: '测试通过' }],
  findings: [],
  summary: '全部验收通过',
}

// ---------- 环境 ----------

function makeStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-sched-'))
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })
  const stateDir = path.join(root, 'desk')
  const storageRoot = path.join(root, 'storages')
  const backend = new JsonStorageBackend(storageRoot)
  const ctx = {
    storage: { backend: { get: (n) => (n === 'json' ? backend : undefined) } },
    logger: { warn: () => {}, error: () => {} },
    emit: () => {},
  }
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  const store = new MixedStore({ stateDir, storageRoot, hostId: 'host-test', ownershipTtlMs: 15000, logger: { warn: () => {}, error: () => {} } })
  return { root, store, facility }
}

function makeFakeSubagents({ behavior } = {}) {
  const spawns = []
  return {
    spawns,
    start: async (kind, opts) => {
      assert.equal(kind, 'spawn')
      spawns.push({ label: opts.label, prompt: opts.prompt?.[0]?.text ?? '' })
      const b = behavior ? behavior(opts) : { output: 'ok', stopReason: 'completed' }
      if (b.abortable) {
        const result = new Promise((resolve, reject) => {
          const onAbort = () => reject(new Error('aborted'))
          opts.signal?.addEventListener('abort', onAbort, { once: true })
          b.resolve?.(resolve)
        })
        return { id: `child-${spawns.length}`, result, dispose: async () => {} }
      }
      return { id: `child-${spawns.length}`, result: Promise.resolve(b), dispose: async () => {} }
    },
  }
}

async function claimRun(store, { messageId = 'msg-1', text = '构建六任务', workspace = 'E:\\ws' } = {}) {
  const submissionKey = submissionKeyOf({ ownerKey: OWNER.ownerKey, profileId: 'desk', sessionId: 'sess-1', sourceMessageId: messageId })
  const runId = runIdOf(submissionKey)
  const { run } = await store.claimRun({
    runId,
    ownerKey: OWNER.ownerKey,
    ownerEpoch: 0,
    profileId: 'desk',
    sessionId: 'sess-1',
    sourceMessageId: messageId,
    submissionKey,
    workspace: { canonicalPath: workspace, baselineId: 'b-1' },
    models: structuredClone(MODELS),
    policy: { maxRepairRounds: 2, maxReplans: 1 },
    goal: text,
    inputRefs: [{ kind: 'text', messageId, text }],
  })
  return run
}

/** 直接构造 driver + controller。每个 controller 用独立锁注册表（并行测试互不干扰）。 */
function makeController(store, fakeSub, run, { planPromptFn, taskPromptFn } = {}) {
  const workspaceLocks = createWorkspaceLocks()
  const driver = new MixedDriver({
    ctx: { subagents: fakeSub },
    store,
    parentAgent: { cancel: () => {} },
    run,
    logger: { warn: () => {}, error: () => {} },
    stageTimeoutMs: 10000,
  })
  const controller = new MixedRunController({
    store,
    driver,
    run,
    agent: { cancel: () => {} },
    workspaceLocks,
    planPrompt: planPromptFn ?? ((run) => `PLAN for: ${run.goal}`),
    taskPrompt: taskPromptFn ?? ((run, task) => `TASK ${task.taskId}`),
    reviewPrompt: () => 'REVIEW',
    planSchema: { type: 'object' },
    reviewSchema: { type: 'object' },
    logger: { warn: () => {}, error: () => {} },
  })
  return { driver, controller, workspaceLocks }
}

const execSpawnsOf = (spawns) => spawns.filter((s) => s.label.startsWith('mixed:execution:')).map((s) => s.label.slice('mixed:execution:'.length))

// ---------- 图工具（单测）----------

test('transitiveDependents：菱形依赖的传递后继', () => {
  const tasks = [task('a'), task('b', ['a']), task('c', ['a']), task('d', ['b', 'c'])]
  assert.deepEqual([...transitiveDependents(tasks, ['a'])].sort(), ['b', 'c', 'd'])
  assert.deepEqual([...transitiveDependents(tasks, ['b'])], ['d'])
  assert.deepEqual([...transitiveDependents(tasks, ['d'])], [])
})

test('isTaskReady：stale 重就绪（依赖满足才可再调度；failed/blocked/running 不可）', () => {
  const mk = (status) => task('x', [], { status })
  const byIdOf = (xs) => new Map(xs.map((t) => [t.taskId, t]))
  // 无依赖
  assert.ok(isTaskReady(mk('pending'), byIdOf([mk('pending')])))
  assert.ok(isTaskReady(mk('ready'), byIdOf([mk('ready')])))
  assert.ok(isTaskReady(mk('stale'), byIdOf([mk('stale')])), 'stale 无依赖 → 重就绪')
  assert.ok(!isTaskReady(mk('running'), byIdOf([mk('running')])))
  assert.ok(!isTaskReady(mk('failed'), byIdOf([mk('failed')])))
  assert.ok(!isTaskReady(mk('blocked'), byIdOf([mk('blocked')])))
  assert.ok(!isTaskReady(mk('executed'), byIdOf([mk('executed')])))
  // 有依赖
  const depExec = task('dep', [], { status: 'executed' })
  const depStale = task('dep', [], { status: 'stale' })
  const depFailed = task('dep', [], { status: 'failed' })
  assert.ok(isTaskReady(task('x', ['dep']), byIdOf([task('x', ['dep']), depExec])), '依赖 executed → ready')
  assert.ok(!isTaskReady(task('x', ['dep']), byIdOf([task('x', ['dep']), depFailed])), '依赖 failed → 不 ready')
  assert.ok(isTaskReady(task('x', ['dep'], { status: 'stale' }), byIdOf([task('x', ['dep'], { status: 'stale' }), depExec])), 'stale + 依赖 executed → 重就绪')
  assert.ok(!isTaskReady(task('x', ['dep'], { status: 'stale' }), byIdOf([task('x', ['dep'], { status: 'stale' }), depStale])), 'stale + 依赖 stale → 等依赖先重做')
})

// ---------- 工作区写锁（单测）----------

test('工作区写锁：冲突拒绝 / 同 run 幂等 / 仅持有者可释放 / 路径规范化 / 跨工作区独立', () => {
  const locks = createWorkspaceLocks()
  const a = acquireWorkspaceWriteLock('E:\\WS', 'run-A', locks)
  assert.throws(
    () => acquireWorkspaceWriteLock('e:\\ws\\', 'run-B', locks),
    (e) => e instanceof MixedError && e.code === 'workspace_conflict',
    '其他 run 占用同一规范化路径 → workspace_conflict',
  )
  const a2 = acquireWorkspaceWriteLock('E:\\WS', 'run-A', locks) // 幂等
  assert.equal(workspaceLockHolder('e:\\ws', locks)?.runId, 'run-A')
  // 非持有者释放无效
  releaseWorkspaceWriteLock('E:\\WS', 'run-B', locks)
  assert.equal(workspaceLockHolder('E:\\WS', locks)?.runId, 'run-A')
  // 持有者释放
  a.release()
  assert.equal(workspaceLockHolder('E:\\WS', locks), null)
  const b = acquireWorkspaceWriteLock('e:\\ws', 'run-B', locks)
  assert.equal(workspaceLockHolder('e:\\ws', locks)?.runId, 'run-B')
  // 不同工作区互不影响
  const c = acquireWorkspaceWriteLock('F:\\other', 'run-C', locks)
  assert.equal(workspaceLockHolder('F:\\other', locks)?.runId, 'run-C')
  b.release()
  c.release()
  a2.release() // 重复释放无副作用
})

// ---------- 拓扑串行 + 6 任务共用一个 executor ----------

test('调度：6 任务共用一个 executor（拓扑序派发、同模型独立 attempt、全部 executed）', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const run = await claimRun(env.store)
  const fakeSub = makeFakeSubagents({
    behavior: (opts) => {
      if (opts.label === 'mixed:planning') {
        return {
          output: 'plan',
          stopReason: 'completed',
          structured: {
            goal: run.goal,
            interpretation: 'i',
            knownFacts: [],
            assumptions: [],
            openQuestions: [],
            acceptance: [{ id: 'a1', description: '完成', checkable: true }],
            verificationMethods: ['node --test'],
            // 计划列表序刻意不是拓扑序
            tasks: [task('t3'), task('t1'), task('t2', ['t1']), task('t5', ['t2', 't4']), task('t4', ['t3']), task('t6')],
          },
        }
      }
      if (opts.label === 'mixed:review') return { output: 'review', stopReason: 'completed', structured: structuredClone(REVIEW_PASS) }
      return { output: 'executed', stopReason: 'completed' }
    },
  })
  const { controller } = makeController(env.store, fakeSub, run)
  const res = await controller.execute(new AbortController().signal)
  const record = env.store.getRun(run.runId)

  assert.equal(res.outcome, 'succeeded')
  // 拓扑序：t3 → t1 → t2 → t4 → t5 → t6（t5 等 t2+t4；不是列表序 t3,t1,t2,t5…）
  assert.deepEqual(execSpawnsOf(fakeSub.spawns), ['t3', 't1', 't2', 't4', 't5', 't6'])
  // 同模型多 taskId 独立跟踪：6 个执行 attempt 同 executor 路由、taskId 各自独立、attemptId 唯一
  const execAtts = record.attempts.filter((a) => a.stage === 'execution')
  assert.equal(execAtts.length, 6)
  assert.ok(execAtts.every((a) => a.route.modelId === MODELS.executor.modelId), '全部用 executor 模型')
  assert.deepEqual(execAtts.map((a) => a.taskId).sort(), ['t1', 't2', 't3', 't4', 't5', 't6'])
  assert.equal(new Set(execAtts.map((a) => a.attemptId)).size, 6, 'attemptId 唯一（独立跟踪）')
  assert.ok(record.tasks.every((x) => x.status === 'executed'))
  assert.equal(record.planVersions[0].version, 1)
  await env.store.close()
})

// ---------- 依赖失败阻断 + 重新拆分/planVersion/失效传播 ----------

test('调度：依赖失败阻断后继 → 重新拆分（planVersion 2，保留已验证任务，受影响任务重做）→ succeeded', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const run = await claimRun(env.store)

  const fourTasks = () => [task('t1'), task('t2', ['t1']), task('t5', ['t2']), task('t6')]
  const planOf = (tasks) => ({
    goal: run.goal,
    interpretation: 'i',
    knownFacts: [],
    assumptions: [],
    openQuestions: [],
    acceptance: [{ id: 'a1', description: '完成', checkable: true }],
    verificationMethods: ['node --test'],
    tasks: structuredClone(tasks),
  })

  let t2ExecCalls = 0
  const replanCalls = []
  const fakeSub = makeFakeSubagents({
    behavior: (opts) => {
      if (opts.label === 'mixed:planning') {
        return { output: 'plan', stopReason: 'completed', structured: planOf(fourTasks()) }
      }
      if (opts.label === 'mixed:review') return { output: 'review', stopReason: 'completed', structured: structuredClone(REVIEW_PASS) }
      if (opts.label.startsWith('mixed:execution:')) {
        const id = opts.label.slice('mixed:execution:'.length)
        if (id === 't2') {
          t2ExecCalls++
          if (t2ExecCalls === 1) return { output: 'boom', stopReason: 'error' } // 第一次失败
        }
        return { output: 'executed', stopReason: 'completed' }
      }
      return { output: 'ok', stopReason: 'completed' }
    },
  })
  const { controller } = makeController(env.store, fakeSub, run, {
    planPromptFn: (r, opts) => {
      if (opts?.replan) replanCalls.push(opts.replan)
      return `PLAN for: ${r.goal}`
    },
  })
  const res = await controller.execute(new AbortController().signal)
  const record = env.store.getRun(run.runId)

  assert.equal(res.outcome, 'succeeded')
  // 派发序列：轮1 t1 → t2(失败) → [t5 阻断] → t6；轮2（replan 后）t2 重做 → t5 重做
  assert.deepEqual(execSpawnsOf(fakeSub.spawns), ['t1', 't2', 't6', 't2', 't5'])
  // 阻断事件：t5 因 t2 失败被标 blocked（不派发）
  const blockedEvent = record.events.find((e) => e.type === 'tasks_blocked')
  assert.ok(blockedEvent, 'tasks_blocked 事件')
  assert.match(blockedEvent.summary, /t5/)
  // 重新拆分：planVersion 2，supersedes=1，原因含失败任务
  assert.equal(record.planVersions.length, 2)
  assert.equal(record.planVersions[1].version, 2)
  assert.equal(record.planVersions[1].supersedes, 1)
  assert.match(record.planVersions[1].reason, /t2/)
  // replan 提示词携带失败/保留上下文
  assert.equal(replanCalls.length, 1)
  assert.deepEqual(replanCalls[0].failedTasks.map((x) => x.taskId), ['t2'])
  assert.deepEqual(replanCalls[0].executedTasks.map((x) => x.taskId).sort(), ['t1', 't6'])
  // 已验证任务保留不重派：t1/t6 各 1 次执行；t2 两次（重做）；t5 一次
  const execByTask = {}
  for (const a of record.attempts.filter((a) => a.stage === 'execution')) execByTask[a.taskId] = (execByTask[a.taskId] ?? 0) + 1
  assert.deepEqual(execByTask, { t1: 1, t2: 2, t5: 1, t6: 1 })
  assert.equal(new Set(record.attempts.filter((a) => a.stage === 'execution' && a.taskId === 't2').map((a) => a.attemptId)).size, 2, 't2 两次独立 attempt')
  // 最终全部 executed（只到 executed，等待审核——审核已 pass → succeeded）
  assert.ok(record.tasks.every((x) => x.status === 'executed'))
  assert.equal(record.attempts.filter((a) => a.stage === 'planning').length, 2, '规划 2 次（初规划 + 重新拆分）')
  await env.store.close()
})

test('A31：A 拆为 A1/A2 后 A 不再派发，B 等 A1+A2 聚合后才执行', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const run = await claimRun(env.store, { text: '拆分 A 再做 B' })
  const planOf = (tasks) => ({
    goal: run.goal,
    interpretation: 'i',
    knownFacts: [],
    assumptions: [],
    openQuestions: [],
    acceptance: [{ id: 'a1', description: '完成', checkable: true }],
    verificationMethods: ['node --test'],
    tasks: structuredClone(tasks),
  })
  let planCalls = 0
  const fakeSub = makeFakeSubagents({
    behavior: (opts) => {
      if (opts.label === 'mixed:planning') {
        planCalls++
        if (planCalls === 1) return { output: 'plan', stopReason: 'completed', structured: planOf([task('tA'), task('tB', ['tA'])]) }
        return { output: 'plan', stopReason: 'completed', structured: planOf([task('tA1'), task('tA2'), task('tB', ['tA1', 'tA2'])]) }
      }
      if (opts.label === 'mixed:review') return { output: 'review', stopReason: 'completed', structured: structuredClone(REVIEW_PASS) }
      if (opts.label === 'mixed:execution:tA') return { output: 'boom', stopReason: 'error' }
      return { output: 'executed', stopReason: 'completed' }
    },
  })
  const { controller } = makeController(env.store, fakeSub, run)
  const res = await controller.execute(new AbortController().signal)
  const record = env.store.getRun(run.runId)
  assert.equal(res.outcome, 'succeeded')
  assert.deepEqual(execSpawnsOf(fakeSub.spawns), ['tA', 'tA1', 'tA2', 'tB'], 'A 失败后只派 A1/A2，B 在两者之后')
  assert.equal(execSpawnsOf(fakeSub.spawns).filter((id) => id === 'tA').length, 1, '被拆掉的 A 不再派发')
  assert.ok(!record.tasks.some((x) => x.taskId === 'tA' && x.status === 'pending'), '新图不再调度 A')
  assert.ok(record.tasks.find((x) => x.taskId === 'tB')?.status === 'executed')
  const bIdx = execSpawnsOf(fakeSub.spawns).lastIndexOf('tB')
  assert.ok(execSpawnsOf(fakeSub.spawns).indexOf('tA1') < bIdx && execSpawnsOf(fakeSub.spawns).indexOf('tA2') < bIdx)
  await env.store.close()
})

// ---------- 工作区写锁（控制器级）----------

test('调度：工作区被其他 run 占用 → workspace_conflict，0 次派发；释放后可运行', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const run = await claimRun(env.store, { messageId: 'msg-B' })
  const fakeSub = makeFakeSubagents({
    behavior: (opts) => {
      if (opts.label === 'mixed:planning') {
        return {
          output: 'plan',
          stopReason: 'completed',
          structured: {
            goal: run.goal,
            interpretation: 'i',
            knownFacts: [],
            assumptions: [],
            openQuestions: [],
            acceptance: [{ id: 'a1', description: '完成', checkable: true }],
            verificationMethods: [],
            tasks: [task('t1')],
          },
        }
      }
      return { output: 'ok', stopReason: 'completed', structured: opts.label === 'mixed:review' ? structuredClone(REVIEW_PASS) : undefined }
    },
  })
  const { controller, workspaceLocks } = makeController(env.store, fakeSub, run)

  const other = acquireWorkspaceWriteLock('E:\\ws', 'run-other', workspaceLocks) // 模拟并发 run 持锁
  const res = await controller.execute(new AbortController().signal)
  const record = env.store.getRun(run.runId)
  assert.equal(res.outcome, 'blocked')
  assert.equal(record.status, 'blocked')
  assert.equal(record.error.code, 'workspace_conflict')
  assert.equal(execSpawnsOf(fakeSub.spawns).length, 0, '冲突时不派发任何任务')
  other.release()

  // 释放后同一工作区可以运行
  const runC = await claimRun(env.store, { messageId: 'msg-C' })
  const fakeSubC = makeFakeSubagents({
    behavior: (opts) => {
      if (opts.label === 'mixed:planning') {
        return {
          output: 'plan',
          stopReason: 'completed',
          structured: {
            goal: runC.goal,
            interpretation: 'i',
            knownFacts: [],
            assumptions: [],
            openQuestions: [],
            acceptance: [{ id: 'a1', description: '完成', checkable: true }],
            verificationMethods: [],
            tasks: [task('t1')],
          },
        }
      }
      if (opts.label === 'mixed:review') return { output: 'review', stopReason: 'completed', structured: structuredClone(REVIEW_PASS) }
      return { output: 'ok', stopReason: 'completed' }
    },
  })
  const { controller: controllerC } = makeController(env.store, fakeSubC, runC)
  const resC = await controllerC.execute(new AbortController().signal)
  assert.equal(resC.outcome, 'succeeded', '锁释放后同一工作区正常完成')
  await env.store.close()
})

// ---------- Stop 停止后续派发 ----------

test('调度：执行中 Stop → cancelled，后续任务不派发', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const run = await claimRun(env.store, { messageId: 'msg-stop' })
  const fakeSub = makeFakeSubagents({
    behavior: (opts) => {
      if (opts.label === 'mixed:planning') {
        return {
          output: 'plan',
          stopReason: 'completed',
          structured: {
            goal: run.goal,
            interpretation: 'i',
            knownFacts: [],
            assumptions: [],
            openQuestions: [],
            acceptance: [{ id: 'a1', description: '完成', checkable: true }],
            verificationMethods: [],
            tasks: [task('t1'), task('t2')],
          },
        }
      }
      if (opts.label === 'mixed:execution:t1') {
        // 慢任务：Stop 前不完成
        return { output: 'slow', stopReason: 'completed', abortable: true }
      }
      return { output: 'ok', stopReason: 'completed' }
    },
  })
  const { controller } = makeController(env.store, fakeSub, run)

  const execP = controller.execute(new AbortController().signal)
  // 等 t1 派发后 Stop（确定性：等 execution:t1 spawn 出现）
  for (let i = 0; i < 100 && !fakeSub.spawns.some((s) => s.label === 'mixed:execution:t1'); i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.ok(fakeSub.spawns.some((s) => s.label === 'mixed:execution:t1'), 't1 已派发')
  await controller.requestStop('user-stop')
  const res = await execP
  const record = env.store.getRun(run.runId)

  assert.equal(res.outcome, 'cancelled')
  assert.equal(record.status, 'cancelled')
  assert.deepEqual(execSpawnsOf(fakeSub.spawns), ['t1'], '后续任务 t2 不派发')
  const t2 = record.tasks.find((x) => x.taskId === 't2')
  assert.equal(t2.status, 'pending', 't2 保持未派发')
  await env.store.close()
})
