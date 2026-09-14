/**
 * T04 交付物：mixed-driver 测试（阶段 driver + 会话桥接）。
 *
 * driver/桥接/控制器用真实 mixed-store（内核真实存储栈）+ 假 subagents（记录 spawn 参数、
 * 可控行为）。内核真桥接（pre-step 领取/交付/Stop 与 turn 状态同时正确）由 T01 真内核探测
 * 17/17 证明（docs/evidence/mixed/compatibility.md §2 L1 s1/s6/s7/s8/s9b）；本文件覆盖
 * 计划 T04 的宿主侧验收：显式角色路由（不切全局默认）、attempt 崩溃窗口、失败即停不静默继续、
 * 原消息只处理一次（重复领取）、交付步改道 reviewer、Stop 级联。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MixedStore } from '../../plugins/desk-host/lib/mixed/store.js'
import { MixedDriver, STAGE_ROLE, FORMAT_CORRECTION_TOOL_FILTER, spawnToolFilterOption } from '../../plugins/desk-host/lib/mixed/dsh-driver.js'
import { MixedRunController } from '../../plugins/desk-host/lib/mixed/service.js'
import { createMixedBridge, renderDelivery } from '../../plugins/desk-host/lib/mixed/session-bridge.js'
import {
  MixedError,
  submissionKeyOf,
  runIdOf,
  advanceRun,
  resumeMarkerText,
} from '../../plugins/desk-host/lib/mixed/contracts.js'

// ---------- 环境 ----------

const OWNER = { ownerKey: 'owner:aaaa', ownerEpoch: 0 }
const MODELS = {
  planner: { catalogProvider: 'deepseek', modelId: 'deepseek-v4-pro', runtimeModelId: 'deepseek-v4-pro', capabilities: { planner: true, executor: true, reviewer: true }, capabilitiesRevision: 'rev-abc123' },
  executor: { catalogProvider: 'xai', modelId: 'grok-4.6', runtimeModelId: 'grok-4.6', capabilities: { planner: false, executor: true, reviewer: true }, capabilitiesRevision: 'rev-abc123' },
  reviewer: { catalogProvider: 'deepseek', modelId: 'deepseek-v4-flash', runtimeModelId: 'deepseek-v4-flash', capabilities: { planner: false, executor: false, reviewer: true }, capabilitiesRevision: 'rev-abc123' },
}
const PLAN_OUTPUT = {
  goal: '修好登录 bug',
  interpretation: '登录接口 500',
  assumptions: [],
  openQuestions: [],
  acceptance: [{ id: 'a1', description: '登录成功', checkable: true }],
  verificationMethods: ['node --test'],
  tasks: [
    {
      taskId: 't1', dependsOnTaskIds: [], title: '修登录接口', goal: '修 500',
      inputRefs: [], expectedOutputs: ['src/login.js'], pathScope: ['src'], acceptanceIds: ['a1'],
      verificationHints: ['node --test'], role: 'executor', status: 'pending', attemptIds: [], evidenceIds: [],
    },
  ],
}
const REVIEW_PASS = {
  verdict: 'pass',
  evidenceManifestHash: 'e-1',
  criteria: [{ acceptanceId: 'a1', status: 'pass', evidenceIds: ['e1'], explanation: '测试通过' }],
  findings: [],
  summary: '全部验收通过',
}

function makeStore(t, { reuse } = {}) {
  const root = reuse ? reuse.root : fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-driver-'))
  if (!reuse) t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const stateDir = reuse ? reuse.stateDir : path.join(root, 'desk')
  const storageRoot = reuse ? reuse.storageRoot : path.join(root, 'storages')
  const backend = new JsonStorageBackend(storageRoot)
  const ctx = {
    storage: { backend: { get: (n) => (n === 'json' ? backend : undefined) } },
    logger: { warn: () => {}, error: () => {} },
    emit: () => {},
  }
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  const store = new MixedStore({ stateDir, storageRoot, hostId: 'host-test', ownershipTtlMs: 15000, logger: { warn: () => {}, error: () => {} } })
  const env = { root, stateDir, storageRoot, backend, facility, store }
  return env
}

/** 带超时标签的 await（避免测试里裸 sleep 造成的并发负载 flake）。 */
function awaitWithTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/** 假 subagents：按 label 返回可控结果。 */
function makeFakeSubagents(t, { onSpawn } = {}) {
  const spawns = []
  return {
    spawns,
    start: async (kind, opts) => {
      assert.equal(kind, 'spawn')
      spawns.push({ kind, opts })
      onSpawn?.(opts)
      const id = `child-${spawns.length}`
      const behavior = t._spawnBehavior?.(opts) ?? { output: 'done', stopReason: 'completed' }
      const result = behavior.abortable
        ? new Promise((resolve, reject) => {
            const onAbort = () => reject(new Error('aborted'))
            opts.signal.addEventListener('abort', onAbort, { once: true })
            behavior.resolve?.(resolve)
          })
        : Promise.resolve(behavior)
      const handle = { id, result, dispose: async () => {} }
      return handle
    },
  }
}

/** 完整依赖：store + driver + controller 工厂（桥接用）。 */
function makeDeps(t, { store, spawnBehavior } = {}) {
  const fakeSub = makeFakeSubagents(t, {
    onSpawn: () => {},
  })
  t._spawnBehavior = (opts) => {
    if (spawnBehavior) return spawnBehavior(opts)
    if (opts.label === 'mixed:planning') {
      return { output: 'plan', stopReason: 'completed', structured: structuredClone(PLAN_OUTPUT) }
    }
    if (opts.label.startsWith('mixed:execution')) return { output: 'executed', stopReason: 'completed' }
    if (opts.label === 'mixed:review') return { output: 'review', stopReason: 'completed', structured: structuredClone(REVIEW_PASS) }
    if (opts.label.startsWith('mixed:repair')) return { output: 'repaired', stopReason: 'completed' }
    return { output: 'ok', stopReason: 'completed' }
  }
  const controllers = new Map()
  const prompt = {
    planPrompt: (run) => `PLAN for: ${run.goal}`,
    taskPrompt: (run, task) => `TASK ${task.taskId}: ${task.title}`,
    reviewPrompt: () => 'REVIEW the run outputs.',
  }
  const planSchema = { type: 'object' }
  const reviewSchema = { type: 'object' }
  const runControllerFactory = ({ agent, run }) => {
    const driver = new MixedDriver({ ctx: { subagents: fakeSub }, store, parentAgent: agent, run, logger: { warn: () => {}, error: () => {} }, stageTimeoutMs: 10000 })
    const controller = new MixedRunController({
      store,
      driver,
      run,
      agent,
      planPrompt: prompt.planPrompt,
      taskPrompt: prompt.taskPrompt,
      reviewPrompt: prompt.reviewPrompt,
      planSchema,
      reviewSchema,
      logger: { warn: () => {}, error: () => {} },
    })
    controllers.set(run.runId, controller)
    return controller
  }
  return { store, fakeSub, controllers, runControllerFactory, prompt, planSchema, reviewSchema }
}

/** 假父会话 agent（作用域监听器捕获 + cancel 记录）。 */
function makeFakeAgent({ cwd = 'E:\\ws' } = {}) {
  const listeners = { preStep: null, onRequest: null }
  const cancels = []
  return {
    listeners,
    cancels,
    meta: { cwd },
    ctx: {
      on: (event, fn) => {
        if (event === 'agent/pre-step') listeners.preStep = fn
        if (event === 'agent/request') listeners.onRequest = fn
        return () => {
          if (event === 'agent/pre-step') listeners.preStep = null
          if (event === 'agent/request') listeners.onRequest = null
        }
      },
    },
    cancel: (cause) => cancels.push(cause),
  }
}

function userMessage(text, id) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** 启用 Mixed：偏好 + 会话模式（不 claim run）。 */
async function enableMixed(store) {
  await store.savePreferences(OWNER.ownerKey, { planner: MODELS.planner, executor: MODELS.executor, reviewer: MODELS.reviewer, ownerEpoch: 0 })
  await store.setSessionMode({ sessionId: 'sess-1', ownerKey: OWNER.ownerKey, ownerEpoch: 0, enabled: true })
}

async function claimForBridge(t, store, { text = '帮我修登录 bug', messageId = 'msg-1' } = {}) {
  const submissionKey = submissionKeyOf({ ownerKey: OWNER.ownerKey, profileId: 'desk', sessionId: 'sess-1', sourceMessageId: messageId })
  await store.savePreferences(OWNER.ownerKey, { planner: MODELS.planner, executor: MODELS.executor, reviewer: MODELS.reviewer, ownerEpoch: 0 })
  await store.setSessionMode({ sessionId: 'sess-1', ownerKey: OWNER.ownerKey, ownerEpoch: 0, enabled: true })
  const runId = runIdOf(submissionKey)
  const { run } = await store.claimRun({
    runId,
    ownerKey: OWNER.ownerKey,
    ownerEpoch: 0,
    profileId: 'desk',
    sessionId: 'sess-1',
    sourceMessageId: messageId,
    submissionKey,
    workspace: { canonicalPath: 'E:\\ws', baselineId: 'b-1' },
    models: structuredClone(MODELS),
    policy: {},
    goal: text,
    inputRefs: [{ kind: 'text', messageId, text }],
  })
  return run
}

// ---------- driver ----------

test('driver：startStage 派发前落盘 attempt（崩溃窗口）+ 显式角色路由 + maxDepth 1', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const run = await claimForBridge(t, env.store)
  const fakeSub = makeFakeSubagents(t)
  const driver = new MixedDriver({ ctx: { subagents: fakeSub }, store: env.store, parentAgent: makeFakeAgent(), run, logger: { warn: () => {}, error: () => {} } })

  // 崩溃窗口模拟：onSpawn 时记录“此刻存储里已有 starting attempt”
  let atSpawnTime = null
  fakeSub.start = async (kind, opts) => {
    fakeSub.spawns.push({ kind, opts })
    atSpawnTime = env.store.getRun(run.runId).attempts.find((a) => a.stage === 'execution')
    const id = 'child-x'
    return { id, result: Promise.resolve({ output: 'executed', stopReason: 'completed' }), dispose: async () => {} }
  }
  const res = await driver.startStage({ stage: 'execution', prompt: 'TASK t1', signal: new AbortController().signal, taskId: 't1' })
  assert.ok(atSpawnTime, 'spawn 时 starting attempt 必须已落盘（崩溃窗口保护）')
  assert.equal(atSpawnTime.childSessionId, undefined) // 派发前无 childSessionId
  assert.equal(res.attempt.childSessionId, 'child-x')
  assert.equal(res.stopReason, 'completed')

  const after = env.store.getRun(run.runId)
  const att = after.attempts.find((a) => a.stage === 'execution')
  assert.equal(att.childSessionId, 'child-x')
  assert.equal(att.stopReason, 'completed')
  assert.equal(att.endedAt, undefined || att.endedAt) // 有结束时间
  assert.ok(att.endedAt)

  // 路由断言：agentOptions = 角色路由（executor），provider = desk-gateway-<catalogProvider>，maxDepth 1
  const spawn = fakeSub.spawns.find((s) => s.opts.label === 'mixed:execution:t1')
  assert.equal(spawn.opts.agentOptions.model, MODELS.executor.modelId)
  assert.equal(spawn.opts.agentOptions.provider, 'desk-gateway-xai')
  assert.equal(spawn.opts.maxDepth, 1)
  assert.equal(STAGE_ROLE.execution, 'executor')
  await env.store.close()
})

test('spawnToolFilterOption：只 deny 当前作用域已注册的工具（Windows 无 bash 不得传 bash）', () => {
  assert.deepEqual(spawnToolFilterOption({ deny: ['write'] }).toolFilter.deny, ['write'])
  assert.equal(Object.keys(spawnToolFilterOption(['write'])).length, 0)
  const win = spawnToolFilterOption(FORMAT_CORRECTION_TOOL_FILTER, new Set(['write', 'edit', 'pwsh', 'read']))
  assert.ok(!win.toolFilter.deny.includes('bash'), '未注册的 bash 不得进入 restrict，否则内核 tools.restrict() 直接炸')
  assert.deepEqual(win.toolFilter.deny, ['write', 'edit', 'pwsh'])
  const posix = spawnToolFilterOption(FORMAT_CORRECTION_TOOL_FILTER, new Set(['write', 'edit', 'bash', 'read']))
  assert.ok(!posix.toolFilter.deny.includes('pwsh'))
  assert.deepEqual(posix.toolFilter.deny, ['write', 'edit', 'bash'])
})

test('spawnToolFilterOption：无目录时至少去掉本平台未挂载的 shell', () => {
  const deny = spawnToolFilterOption(FORMAT_CORRECTION_TOOL_FILTER).toolFilter.deny
  if (process.platform === 'win32') assert.ok(!deny.includes('bash'), 'win32 标准预设不挂 tool-bash')
  else assert.ok(!deny.includes('pwsh'), 'POSIX 标准预设不挂 tool-pwsh')
  assert.ok(deny.includes('write') && deny.includes('edit'))
})

test('driver：disableTools 把格式纠正 deny 列表传给 spawn（A30）', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const run = await claimForBridge(t, env.store)
  const fakeSub = makeFakeSubagents(t)
  fakeSub.start = async (kind, opts) => {
    fakeSub.spawns.push({ kind, opts })
    return { id: 'child-corr', result: Promise.resolve({ output: '{}', stopReason: 'completed', structured: {} }), dispose: async () => {} }
  }
  const parentAgent = makeFakeAgent()
  parentAgent.ctx.tools = {
    view: () => ({ restrictableNames: new Set(['write', 'edit', 'pwsh', 'read', 'grep']) }),
  }
  const driver = new MixedDriver({ ctx: { subagents: fakeSub }, store: env.store, parentAgent, run, logger: { warn: () => {}, error: () => {} } })
  await driver.startStage({ stage: 'review', prompt: 'retry', signal: new AbortController().signal, disableTools: true })
  const spawn = fakeSub.spawns[0]
  assert.deepEqual(spawn.opts.toolFilter.deny, ['write', 'edit', 'pwsh'])
  assert.ok(!spawn.opts.toolFilter.deny.includes('bash'))
  await env.store.close()
})

test('driver：stage 失败 → MixedError 上抛 + attempt 记 error（调用方据此 blocked，不静默继续）', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const run = await claimForBridge(t, env.store)
  const fakeSub = makeFakeSubagents(t)
  fakeSub.start = async () => {
    const id = 'child-fail'
    // 立即 reject 的 Promise 必须先挂 noop handler（否则 node:test 记 unhandledRejection）；
    // driver 的 await 仍会收到拒绝
    const result = Promise.reject(new Error('upstream 500'))
    result.catch(() => {})
    return { id, result, dispose: async () => {} }
  }
  const driver = new MixedDriver({ ctx: { subagents: fakeSub }, store: env.store, parentAgent: makeFakeAgent(), run, logger: { warn: () => {}, error: () => {} } })
  await assert.rejects(driver.startStage({ stage: 'execution', prompt: 'x', signal: new AbortController().signal }), (e) => e instanceof MixedError)
  const att = env.store.getRun(run.runId).attempts.find((a) => a.stage === 'execution')
  assert.equal(att.stopReason, 'error')
  await env.store.close()
})

test('driver：Stop 信号中止活动 stage（signal 级联）→ stopReason=aborted', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const run = await claimForBridge(t, env.store)
  const ac = new AbortController()
  let resolveResult
  const fakeSub = makeFakeSubagents(t)
  fakeSub.start = async (kind, opts) => {
    return {
      id: 'child-slow',
      result: new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error('aborted'))
        opts.signal.addEventListener('abort', onAbort, { once: true })
        resolveResult = resolve
      }),
      dispose: async () => {},
    }
  }
  const driver = new MixedDriver({ ctx: { subagents: fakeSub }, store: env.store, parentAgent: makeFakeAgent(), run, logger: { warn: () => {}, error: () => {} } })
  const p = driver.startStage({ stage: 'execution', prompt: 'x', signal: ac.signal }).catch((e) => e)
  await new Promise((r) => setTimeout(r, 50)) // 等 starting 落盘 + spawn
  ac.abort()
  const err = await p
  assert.ok(err instanceof MixedError)
  assert.equal(err.code, 'run_not_in_status')
  const att = env.store.getRun(run.runId).attempts.find((a) => a.stage === 'execution')
  assert.equal(att.stopReason, 'aborted')
  await env.store.close()
})

test('driver：stage 超时弃置（cancel 未生效、上游挂死）→ stage_timeout(retryable) + attempt=timeout_abandoned + 诊断事件', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const run = await claimForBridge(t, env.store)
  const fakeSub = makeFakeSubagents(t)
  fakeSub.start = async () => ({
    id: 'child-hang',
    // 模拟真内核 T09 实测的挂死：子代理对 cancel 不反应，result 永不落定（无 abort 监听）
    result: new Promise(() => {}),
    dispose: async () => {},
  })
  const driver = new MixedDriver({
    ctx: { subagents: fakeSub }, store: env.store, parentAgent: makeFakeAgent(), run,
    logger: { warn: () => {}, error: () => {} },
    stageTimeoutMs: 30, stageAbandonMs: 80,
  })
  const t0 = Date.now()
  const err = await driver.startStage({ stage: 'execution', prompt: 'x', signal: new AbortController().signal }).catch((e) => e)
  const elapsed = Date.now() - t0
  assert.ok(err instanceof MixedError, '弃置必须抛 MixedError')
  assert.equal(err.code, 'stage_timeout')
  assert.equal(err.retryable, true, 'stage_timeout 可恢复重试（run 收敛 blocked 后 resume{retry}）')
  assert.ok(elapsed < 5000, `弃置必须有界（宽限期后即止），实际 ${elapsed}ms`)
  const rec = env.store.getRun(run.runId)
  const att = rec.attempts.find((a) => a.stage === 'execution')
  assert.equal(att.stopReason, 'timeout_abandoned', 'attempt 结算为弃置（结果未知，不自动重放）')
  assert.ok(rec.events.some((e) => e.type === 'stage_diagnostic' && /超时弃置/.test(e.summary ?? '')), 'run 记录含弃置诊断事件（不悬挂不隐蔽）')
  await env.store.close()
})

// ---------- 桥接：完整闭环 ----------

test('桥接：Mixed 启用 + 新消息 → 完整 run（规划/执行/审核/交付），交付步改道 reviewer', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  await enableMixed(env.store)
  const deps = makeDeps(t, { store: env.store })
  const agent = makeFakeAgent()
  const bridge = createMixedBridge({
    store: env.store,
    profileId: 'desk',
    getOwner: () => OWNER,
    workspacePath: () => 'E:\\ws',
    deps: { runControllerFactory: deps.runControllerFactory, controllers: deps.controllers },
    findSession: () => ({ agent }),
    logger: { warn: () => {}, error: () => {} },
  })
  bridge.install(agent, 'sess-1')
  assert.ok(agent.listeners.preStep, 'pre-step 钩子已装')
  assert.ok(agent.listeners.onRequest, 'request 钩子已装')

  // 预领取（模拟 claim：真实路径里桥接自己 claim；这里先验证完整 run 闭环用已 claim 的 run）
  // —— 直接走桥接：桥接会自己 claimRun（store 里还没有该 run）
  const msg = userMessage('帮我修登录 bug', 'msg-1')
  const signal = new AbortController().signal
  const decision = await agent.listeners.preStep({ agent, messages: [msg, { id: 'ctx-1', role: 'user', content: [{ type: 'text', text: 'runtime context' }], source: { kind: 'plugin', plugin: 'system' } }], turn: 1, step: 0, signal }, async () => ({ kind: 'enter', messages: [msg] }))

  assert.equal(decision.kind, 'enter')
  const run = env.store.listRuns({ sessionId: 'sess-1' }).items[0]
  assert.equal(run.status, 'succeeded')
  const record = env.store.getRun(run.runId)
  assert.equal(record.planVersions[0].version, 1)
  assert.equal(record.tasks[0].status, 'executed')
  assert.equal(record.reviewRounds[0].result.verdict, 'pass')
  assert.equal(record.attempts.filter((a) => a.stage === 'planning').length, 1)
  assert.equal(record.attempts.filter((a) => a.stage === 'execution').length, 1)
  assert.equal(record.attempts.filter((a) => a.stage === 'review').length, 1)
  // 路由归属：每个 stage 的 attempt 用对应角色模型
  const planAtt = record.attempts.find((a) => a.stage === 'planning')
  const execAtt = record.attempts.find((a) => a.stage === 'execution')
  const revAtt = record.attempts.find((a) => a.stage === 'review')
  assert.equal(planAtt.route.modelId, MODELS.planner.modelId)
  assert.equal(execAtt.route.modelId, MODELS.executor.modelId)
  assert.equal(revAtt.route.modelId, MODELS.reviewer.modelId)

  // 交付消息在 enter messages 里（原消息 + 插件交付体）
  const texts = decision.messages.map((m) => (m.content ?? []).map((c) => c.text).join(''))
  assert.ok(texts.some((x) => x.includes('帮我修登录 bug')), '原消息放行（供汇总步引用）')
  assert.ok(texts.some((x) => x.includes('Mixed 交付') && x.includes('全部验收通过')), '交付插件消息附加')
  const deliveryMsg = decision.messages.find((m) => m.source?.kind === 'plugin' && m.source?.plugin === 'mixed')
  assert.ok(deliveryMsg)

  // 交付步改道 reviewer（agent/request 瀑布）
  const seed = { provider: 'desk-gateway-deepseek', model: 'deepseek-v4-pro', maxTokens: 1000 }
  const rerouted = await agent.listeners.onRequest({ turn: 1, step: 1, signal }, async () => seed)
  assert.equal(rerouted.model, MODELS.reviewer.modelId)
  assert.equal(rerouted.provider, 'desk-gateway-deepseek')
  assert.equal(rerouted.maxTokens, 1000) // 原 seed 字段保留
  // 非交付步不改道（flag 已消费）
  const normal = await agent.listeners.onRequest({ turn: 2, step: 0, signal }, async () => seed)
  assert.equal(normal.model, 'deepseek-v4-pro')
  await env.store.close()
})

test('桥接：重复消息/pre-step 重试 → 已认领 run，enter+[] 消费，不重跑不重复交付', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  await enableMixed(env.store)
  const deps = makeDeps(t, { store: env.store })
  const agent = makeFakeAgent()
  const bridge = createMixedBridge({
    store: env.store,
    profileId: 'desk',
    getOwner: () => OWNER,
    workspacePath: () => 'E:\\ws',
    deps: { runControllerFactory: deps.runControllerFactory, controllers: deps.controllers },
    logger: { warn: () => {}, error: () => {} },
  })
  bridge.install(agent, 'sess-1')

  const msg = userMessage('帮我修登录 bug', 'msg-1')
  const signal = new AbortController().signal
  const first = await agent.listeners.preStep({ agent, messages: [msg], turn: 1, step: 0, signal }, async () => ({ kind: 'enter', messages: [msg] }))
  assert.equal(first.kind, 'enter')

  // 同一消息再次进入 pre-step（重连/重试）：run 已 succeeded → enter+[]，无交付消息
  const second = await agent.listeners.preStep({ agent, messages: [msg], turn: 2, step: 0, signal }, async () => ({ kind: 'enter', messages: [msg] }))
  assert.equal(second.kind, 'enter')
  assert.deepEqual(second.messages, [])
  assert.equal(env.store.listRuns({ sessionId: 'sess-1' }).items.length, 1) // 仍然只有一个 run
  await env.store.close()
})

test('桥接：未启用 Mixed / 未登录 → 原样透传（普通模式不受影响）', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const deps = makeDeps(t, { store: env.store })
  const agent = makeFakeAgent()
  const bridge = createMixedBridge({
    store: env.store,
    profileId: 'desk',
    getOwner: () => OWNER,
    workspacePath: () => 'E:\\ws',
    deps: { runControllerFactory: deps.runControllerFactory, controllers: deps.controllers },
    logger: { warn: () => {}, error: () => {} },
  })
  bridge.install(agent, 'sess-1')
  const msg = userMessage('你好', 'msg-hi')
  const passthrough = { kind: 'enter', messages: [msg, { id: 'rc', role: 'user', content: [], source: { kind: 'plugin' } }] }
  const d1 = await agent.listeners.preStep({ agent, messages: passthrough.messages, turn: 1, step: 0, signal: new AbortController().signal }, async () => passthrough)
  assert.equal(d1, passthrough) // 未 setSessionMode → 完全透传

  // 未登录（owner=null）→ 透传
  const bridge2 = createMixedBridge({
    store: env.store,
    profileId: 'desk',
    getOwner: () => null,
    workspacePath: () => 'E:\\ws',
    deps: { runControllerFactory: deps.runControllerFactory, controllers: deps.controllers },
    logger: { warn: () => {}, error: () => {} },
  })
  const agent2 = makeFakeAgent()
  bridge2.install(agent2, 'sess-1')
  const d2 = await agent2.listeners.preStep({ agent: agent2, messages: [msg], turn: 1, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [msg] }))
  assert.equal(d2.kind, 'enter')
  assert.equal(d2.messages.length, 1)
  assert.equal(env.store.listRuns({}).items.length, 0) // 没有任何 run 被创建
  await env.store.close()
})

test('桥接：三路由配置缺失 → reject 且提示（不领取、不实施）', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  // 只存部分偏好：不经过 claimForBridge（它会存全量）
  await env.store.savePreferences(OWNER.ownerKey, { planner: MODELS.planner, executor: MODELS.executor, reviewer: null, ownerEpoch: 0 })
  await env.store.setSessionMode({ sessionId: 'sess-1', ownerKey: OWNER.ownerKey, ownerEpoch: 0, enabled: true })
  const deps = makeDeps(t, { store: env.store })
  const agent = makeFakeAgent()
  const bridge = createMixedBridge({
    store: env.store,
    profileId: 'desk',
    getOwner: () => OWNER,
    workspacePath: () => 'E:\\ws',
    deps: { runControllerFactory: deps.runControllerFactory, controllers: deps.controllers },
    logger: { warn: () => {}, error: () => {} },
  })
  bridge.install(agent, 'sess-1')
  const msg = userMessage('帮我修登录 bug', 'msg-1')
  const d = await agent.listeners.preStep({ agent, messages: [msg], turn: 1, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [msg] }))
  assert.equal(d.kind, 'reject')
  assert.match(d.reason, /三路由配置不齐全/)
  assert.equal(env.store.listRuns({}).items.length, 0)
  await env.store.close()
})

test('桥接：规划两次非法 → reject（失败即停，父模型不实施）', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  await enableMixed(env.store)
  const deps = makeDeps(t, {
    store: env.store,
    spawnBehavior: (opts) => (opts.label === 'mixed:planning' ? { output: 'bad', stopReason: 'completed', structured: null } : { output: 'ok', stopReason: 'completed' }),
  })
  const agent = makeFakeAgent()
  const bridge = createMixedBridge({
    store: env.store,
    profileId: 'desk',
    getOwner: () => OWNER,
    workspacePath: () => 'E:\\ws',
    deps: { runControllerFactory: deps.runControllerFactory, controllers: deps.controllers },
    logger: { warn: () => {}, error: () => {} },
  })
  bridge.install(agent, 'sess-1')
  const msg = userMessage('帮我修登录 bug', 'msg-1')
  const d = await agent.listeners.preStep({ agent, messages: [msg], turn: 1, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [msg] }))
  assert.equal(d.kind, 'reject')
  assert.match(d.reason, /plan_invalid|规划/)
  const run = env.store.listRuns({ sessionId: 'sess-1' }).items[0]
  assert.equal(run.status, 'blocked')
  // 规划 attempt 有 2 次（一次格式纠正）
  const record = env.store.getRun(run.runId)
  assert.equal(record.attempts.filter((a) => a.stage === 'planning').length, 2)
  assert.equal(record.tasks.length, 0) // 没有实施
  assert.equal(deps.controllers.has(run.runId), false, '失败后必须释放控制器')

  // 用户点「重试」：同一 run 的恢复 marker 必须重入，不能因为上一轮控制器残留而无响应
  let planAgain = 0
  t._spawnBehavior = (opts) => {
    if (opts.label === 'mixed:planning') {
      planAgain += 1
      return { output: 'plan', stopReason: 'completed', structured: structuredClone(PLAN_OUTPUT) }
    }
    if (opts.label.startsWith('mixed:execution')) return { output: 'executed', stopReason: 'completed' }
    if (opts.label === 'mixed:review') return { output: 'review', stopReason: 'completed', structured: structuredClone(REVIEW_PASS) }
    return { output: 'ok', stopReason: 'completed' }
  }
  const marker = {
    id: 'resume-1',
    role: 'user',
    content: [{ type: 'text', text: resumeMarkerText(run.runId, 'retry') }],
    source: { kind: 'plugin', plugin: 'mixed' },
  }
  const resumed = await agent.listeners.preStep({ agent, messages: [marker], turn: 2, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [marker] }))
  assert.equal(resumed.kind, 'enter')
  assert.match(String(resumed.messages?.[0]?.content?.[0]?.text ?? ''), /Mixed 交付/)
  assert.equal(env.store.getRun(run.runId).status, 'succeeded')
  assert.ok(planAgain >= 1, '规划失败后的重试必须重新规划')
  await env.store.close()
})

test('桥接：运行中用户新消息 → 排队为下一轮需求（queuedInputs），不修改当前目标', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  await enableMixed(env.store)
  let releaseExec
  let signalExecSpawned
  const execSpawned = new Promise((r) => { signalExecSpawned = r })
  const deps = makeDeps(t, {
    store: env.store,
    spawnBehavior: (opts) => {
      if (opts.label === 'mixed:planning') {
        return { output: 'plan', stopReason: 'completed', structured: structuredClone(PLAN_OUTPUT) }
      }
      if (opts.label.startsWith('mixed:execution')) {
        // 执行阶段挂起，制造“运行中”窗口；派发点即信号（releaseExec 在同步链内随后赋值）
        signalExecSpawned()
        return { abortable: true, resolve: (res) => { releaseExec = res } }
      }
      if (opts.label === 'mixed:review') return { output: 'review', stopReason: 'completed', structured: structuredClone(REVIEW_PASS) }
      return { output: 'ok', stopReason: 'completed' }
    },
  })
  const agent = makeFakeAgent()
  const bridge = createMixedBridge({
    store: env.store,
    profileId: 'desk',
    getOwner: () => OWNER,
    workspacePath: () => 'E:\\ws',
    deps: { runControllerFactory: deps.runControllerFactory, controllers: deps.controllers },
    logger: { warn: () => {}, error: () => {} },
  })
  bridge.install(agent, 'sess-1')

  const msg1 = userMessage('帮我修登录 bug', 'msg-1')
  const signal = new AbortController().signal
  const first = agent.listeners.preStep({ agent, messages: [msg1], turn: 1, step: 0, signal }, async () => ({ kind: 'enter', messages: [msg1] }))
  await awaitWithTimeout(execSpawned, 10_000, '执行阶段派发') // 确定性等到“运行中”窗口（不裸 sleep）

  // 运行中第二条消息
  const msg2 = userMessage('顺便加个登出按钮', 'msg-2')
  const d2 = await agent.listeners.preStep({ agent, messages: [msg2], turn: 1, step: 1, signal }, async () => ({ kind: 'enter', messages: [msg2] }))
  assert.equal(d2.kind, 'enter')
  assert.deepEqual(d2.messages, []) // 消费（不放行父模型）
  const run = env.store.listRuns({ sessionId: 'sess-1' }).items[0]
  const record = env.store.getRun(run.runId)
  assert.equal(record.queuedInputs.length, 1)
  assert.equal(record.queuedInputs[0].messageId, 'msg-2')
  assert.match(record.queuedInputs[0].text, /登出/)
  assert.equal(record.goal, '帮我修登录 bug') // 当前目标未被修改

  // 收尾：释放执行 → run 完成（审核通过 → succeeded）
  releaseExec({ output: 'executed', stopReason: 'completed' })
  const firstDecision = await first
  assert.equal(firstDecision.kind, 'enter')
  const finalRun = env.store.getRun(env.store.listRuns({ sessionId: 'sess-1' }).items[0].runId)
  assert.equal(finalRun.status, 'succeeded')
  await env.store.close()
})

test('桥接：Stop（turn 信号 abort）→ 收敛 cancelled + agent.cancel 可序列化 cause', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  await enableMixed(env.store)
  let releaseStage
  let signalExecSpawned
  const execSpawned = new Promise((r) => { signalExecSpawned = r })
  const deps = makeDeps(t, {
    store: env.store,
    spawnBehavior: (opts) => {
      if (opts.label === 'mixed:planning') return { output: 'plan', stopReason: 'completed', structured: structuredClone(PLAN_OUTPUT) }
      if (opts.label === 'mixed:review') return { output: 'review', stopReason: 'completed', structured: structuredClone(REVIEW_PASS) }
      if (opts.label.startsWith('mixed:execution')) {
        signalExecSpawned()
        return {
          abortable: true,
          resolve: (res) => {
            releaseStage = res
          },
        }
      }
      return { output: 'ok', stopReason: 'completed' }
    },
  })
  const agent = makeFakeAgent()
  const ac = new AbortController()
  const bridge = createMixedBridge({
    store: env.store,
    profileId: 'desk',
    getOwner: () => OWNER,
    workspacePath: () => 'E:\\ws',
    deps: { runControllerFactory: deps.runControllerFactory, controllers: deps.controllers },
    logger: { warn: () => {}, error: () => {} },
  })
  bridge.install(agent, 'sess-1')

  const msg = userMessage('帮我修登录 bug', 'msg-1')
  const first = agent.listeners.preStep({ agent, messages: [msg], turn: 1, step: 0, signal: ac.signal }, async () => ({ kind: 'enter', messages: [msg] }))
  await awaitWithTimeout(execSpawned, 10_000, '执行阶段派发') // 确定性等到 execution 挂起（不裸 sleep）
  const run = env.store.listRuns({ sessionId: 'sess-1' }).items[0]
  assert.equal(env.store.getRun(run.runId).status, 'executing')

  ac.abort() // 原生 Stop：turn 信号 abort
  const d = await first
  assert.equal(d.kind, 'enter')
  assert.deepEqual(d.messages, []) // Stop 后消费当前消息
  const record = env.store.getRun(run.runId)
  assert.equal(record.status, 'cancelled')
  assert.ok(record.cancelRequestedAt)
  // agent.cancel 被调用且 cause 是可序列化对象（C6）
  assert.ok(agent.cancels.length >= 1)
  const cause = agent.cancels[0]
  assert.equal(cause.kind, 'user-stop')
  assert.doesNotThrow(() => JSON.stringify(cause))
  await env.store.close()
})

test('driver：T10 用量归属——open 先于 spawn 落定、attempt 结束（成功/失败）都 close', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const run = await claimForBridge(t, env.store)
  const order = []
  const opens = []
  const closes = []
  const fakeSub = makeFakeSubagents(t)
  let mode = 'ok'
  fakeSub.start = async (kind, opts) => {
    order.push('spawn')
    if (mode === 'ok') {
      return { id: 'child-attr', result: Promise.resolve({ output: 'ok', stopReason: 'completed' }), dispose: async () => {} }
    }
    const result = Promise.reject(new Error('upstream 500'))
    result.catch(() => {})
    return { id: 'child-attr-fail', result, dispose: async () => {} }
  }
  const driver = new MixedDriver({
    ctx: { subagents: fakeSub },
    store: env.store,
    parentAgent: makeFakeAgent(),
    run,
    logger: { warn: () => {}, error: () => {} },
    attribution: {
      open: async (a) => {
        order.push('open')
        opens.push(a)
        return true
      },
      close: (a) => {
        closes.push(a)
        order.push('close')
      },
    },
  })
  // 成功路径：open 必须 AWAIT 完成且先于 spawn；结束后 close
  const res = await driver.startStage({ stage: 'execution', prompt: 'x', signal: new AbortController().signal, taskId: 't1' })
  const att = res.attempt.attemptId
  assert.deepEqual(order, ['open', 'spawn', 'close'])
  assert.equal(opens.length, 1)
  assert.deepEqual(opens[0], { runId: run.runId, taskId: 't1', stage: 'execution', attemptId: att })
  assert.equal(closes.length, 1)
  assert.equal(closes[0].attemptId, att)
  assert.equal(closes[0].stage, 'execution')
  assert.equal(closes[0].taskId, 't1')
  // 失败路径：child result reject → stage_failed 上抛，close 仍然发生
  order.length = 0
  mode = 'fail'
  await assert.rejects(driver.startStage({ stage: 'review', prompt: 'y', signal: new AbortController().signal }), (e) => e instanceof MixedError)
  assert.deepEqual(order, ['open', 'spawn', 'close'], '失败路径同样 open 先于 spawn、结束必 close')
  assert.equal(closes.length, 2)
  await env.store.close()
})

test('renderDelivery：验收项/任务/结论/限制齐全', () => {
  const text = renderDelivery({
    runId: 'run-1',
    goal: '修好登录 bug',
    planVersion: 1,
    accepted: ['a1'],
    unverified: ['a2'],
    summary: '全部通过',
    tasks: [{ taskId: 't1', title: '修登录', status: 'executed' }],
    limitations: ['指纹检测不覆盖其他机器'],
  })
  assert.match(text, /修好登录 bug/)
  assert.match(text, /a1/)
  assert.match(text, /a2/)
  assert.match(text, /t1 修登录（executed）/)
  assert.match(text, /全部通过/)
  assert.match(text, /指纹检测/)
})
