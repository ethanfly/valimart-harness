/**
 * T05 交付物：mixed-planner 测试（结构化规划提示词 + 宿主校验 + 一次格式纠正）。
 *
 * 覆盖计划 T05 验收：
 * - 规划提示词声明完整契约（字段/规模上限/路径规则/验收覆盖/不泄漏 provider）；
 * - 一次格式纠正（错误说明进第二次规划提示词；两次不合格 → blocked）；
 * - 环、未知依赖、漏验收与超限均不派发（0 次执行阶段 spawn，run 落 blocked/plan_invalid）。
 *
 * 宿主侧用真实 mixed-store（内核真实存储栈）+ 假 subagents（脚本化规划/执行/审核输出）。
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
import { planPrompt, taskPrompt, PLAN_LIMITS } from '../../plugins/desk-host/lib/mixed/prompts.js'
import { submissionKeyOf, runIdOf } from '../../plugins/desk-host/lib/mixed/contracts.js'

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

const validPlan = {
  goal: '修好登录 bug',
  interpretation: '登录接口 500',
  knownFacts: [],
  assumptions: [],
  openQuestions: [],
  acceptance: [{ id: 'a1', description: '登录成功', checkable: true }],
  verificationMethods: ['node --test'],
  tasks: [task('t1'), task('t2', ['t1'])],
}

const REVIEW_PASS = {
  verdict: 'pass',
  evidenceManifestHash: 'e-1',
  criteria: [{ acceptanceId: 'a1', status: 'pass', evidenceIds: ['e1'], explanation: '测试通过' }],
  findings: [],
  summary: '全部验收通过',
}

// ---------- 环境 ----------

function makeStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-planner-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
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

function makeFakeSubagents(t, { planOutput, planOutputs } = {}) {
  const spawns = []
  let planCalls = 0
  return {
    spawns,
    start: async (kind, opts) => {
      assert.equal(kind, 'spawn')
      spawns.push({ label: opts.label, opts })
      let behavior
      if (opts.label === 'mixed:planning') {
        planCalls++
        const out = planOutputs ? (planOutputs[planCalls - 1] ?? planOutputs[planOutputs.length - 1]) : planOutput
        behavior = { output: 'plan', stopReason: 'completed', structured: out ? structuredClone(out) : undefined }
      } else if (opts.label.startsWith('mixed:execution')) {
        behavior = { output: 'executed', stopReason: 'completed' }
      } else if (opts.label === 'mixed:review') {
        behavior = { output: 'review', stopReason: 'completed', structured: structuredClone(REVIEW_PASS) }
      } else {
        behavior = { output: 'ok', stopReason: 'completed' }
      }
      const id = `child-${spawns.length}`
      return { id, result: Promise.resolve(behavior), dispose: async () => {} }
    },
  }
}

async function claimRun(store, { text = '帮我修登录 bug', messageId = 'msg-1' } = {}) {
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
    workspace: { canonicalPath: 'E:\\ws', baselineId: 'b-1' },
    models: structuredClone(MODELS),
    policy: { maxRepairRounds: 2, maxReplans: 1 },
    goal: text,
    inputRefs: [{ kind: 'text', messageId, text }],
  })
  return run
}

/** 直接构造 driver + controller（不经桥接），执行 run。 */
function makeController(store, fakeSub, run, { planPromptFn, taskPromptFn } = {}) {
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
    planPrompt: planPromptFn ?? ((run) => planPrompt(run)),
    taskPrompt: taskPromptFn ?? ((run, task) => taskPrompt(run, task)),
    reviewPrompt: () => 'REVIEW',
    planSchema: { type: 'object' },
    reviewSchema: { type: 'object' },
    logger: { warn: () => {}, error: () => {} },
  })
  return { driver, controller }
}

// ---------- 提示词契约 ----------

test('planPrompt：声明完整契约（目标/字段/上限/输入引用；不泄漏 provider）', () => {
  const run = {
    goal: '修好登录 bug',
    inputRefs: [
      { kind: 'text', messageId: 'msg-1', text: '登录 500 了' },
      { kind: 'attachment', messageId: 'msg-2', filePath: 'src/login.js', mediaType: 'text/javascript', size: 1200 },
    ],
  }
  const p = planPrompt(run)
  assert.ok(p.includes('修好登录 bug'))
  // 契约字段
  for (const field of ['taskId', 'dependsOnTaskIds', 'title', 'goal', 'scope', 'inputRefs', 'expectedOutputs', 'pathScope', 'acceptanceIds', 'verificationHints', 'role', 'acceptance', 'verificationMethods', 'openQuestions']) {
    assert.ok(p.includes(field), `缺少契约字段 ${field}`)
  }
  // 上限与规则
  assert.ok(p.includes(String(PLAN_LIMITS.maxLeaves)))
  assert.ok(p.includes(String(PLAN_LIMITS.maxTotal)))
  assert.ok(p.includes(String(PLAN_LIMITS.maxDepth)))
  assert.ok(p.includes('禁止环'), '声明无环规则')
  assert.ok(p.includes('不能漏'), '声明验收覆盖规则')
  assert.ok(p.includes('spawn') && p.includes('PowerShell'), 'verificationMethods 必须可 spawn，禁止 PS cmdlet')
  assert.ok(p.includes('不要单独建'), '禁止把宿主核验拆成独立执行任务')
  assert.ok(p.includes('相对路径'), '声明路径规则')
  assert.ok(p.includes('executor'), 'role 固定 executor')
  // 输入引用保留原始 messageId
  assert.ok(p.includes('messageId=msg-1'))
  assert.ok(p.includes('messageId=msg-2'))
  assert.ok(p.includes('src/login.js'))
  // 不泄漏 provider/模型选择权
  assert.ok(!p.includes('deepseek-v4-pro'))
  assert.ok(!p.includes('grok-4.6'))
  assert.ok(!/provider\s*[:=]\s*[a-z]/i.test(p.replace(/不要填其他值；模型路由由宿主解析，规划器不选 provider/g, '')))
})

test('planPrompt：一次格式纠正携带上次校验错误', () => {
  const run = { goal: 'g', inputRefs: [] }
  const first = planPrompt(run)
  const second = planPrompt(run, { formatError: '依赖环: t1 → t2 → t1' })
  assert.ok(second.includes('依赖环: t1 → t2 → t1'))
  assert.ok(second.includes('严格按上述契约重新输出'))
  assert.notEqual(first, second)
})

test('planPrompt：replan 上下文（失败任务/保留任务/不得删除验收）', () => {
  const run = { goal: 'g', inputRefs: [] }
  const p = planPrompt(run, {
    replan: {
      reason: '任务 t2 实施失败',
      failedTasks: [{ taskId: 't2', title: '修接口', blockedReason: '编译错误' }],
      executedTasks: [{ taskId: 't1', title: '建骨架' }],
    },
  })
  assert.ok(p.includes('重新拆分'))
  assert.ok(p.includes('任务 t2 实施失败'))
  assert.ok(p.includes('t2 修接口（编译错误）'))
  assert.ok(p.includes('t1 建骨架'))
  assert.ok(p.includes('不能从 acceptance 删除'))
})

test('taskPrompt：任务上下文（pathScope/验收/输入引用/依赖交接/验证建议）', () => {
  const run = {
    goal: '修好登录 bug',
    planVersions: [{ acceptance: [{ id: 'a1', description: '登录成功', checkable: true }, { id: 'a2', description: '其他', checkable: true }] }],
  }
  const t1 = task('t1', [], { title: '建骨架', goal: '搭结构', pathScope: ['src'], acceptanceIds: ['a1'], expectedOutputs: ['src/app.js'] })
  const t2 = task('t2', ['t1'], { title: '修接口', goal: '修 500', pathScope: ['src'], acceptanceIds: ['a1'], inputRefs: [{ kind: 'text', messageId: 'msg-1', text: '登录 500' }] })
  const byId = new Map([[t1.taskId, t1], [t2.taskId, t2]])
  const p = taskPrompt(run, t2, { byId })
  assert.ok(p.includes('修好登录 bug'))
  assert.ok(p.includes('t2：修接口'))
  assert.ok(p.includes('src'))
  assert.ok(p.includes('登录成功'), '验收项全文')
  assert.ok(!p.includes('其他'), '只列本任务负责的验收')
  assert.ok(p.includes('messageId=msg-1') && p.includes('登录 500'), '输入引用')
  assert.ok(p.includes('t1 建骨架'), '依赖交接')
  assert.ok(p.includes('验证建议'))
})

// ---------- 宿主校验：环/未知依赖/漏验收/超限均不派发 ----------

async function runPlanValidation(t, { planOutput, planOutputs, expect }) {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const run = await claimRun(env.store)
  const fakeSub = makeFakeSubagents(t, { planOutput, planOutputs })
  const { controller } = makeController(env.store, fakeSub, run)
  const res = await controller.execute(new AbortController().signal)
  const record = env.store.getRun(run.runId)
  const planSpawns = fakeSub.spawns.filter((s) => s.label === 'mixed:planning').length
  const execSpawns = fakeSub.spawns.filter((s) => s.label.startsWith('mixed:execution')).length
  expect({ res, record, planSpawns, execSpawns, fakeSub })
  await env.store.close()
}

test('规划校验：依赖环 → blocked(plan_invalid)，两次规划，0 次执行派发', async (t) => {
  const cyclic = structuredClone(validPlan)
  cyclic.tasks = [task('t1', ['t2']), task('t2', ['t1'])]
  await runPlanValidation(t, {
    planOutput: cyclic,
    expect: ({ res, record, planSpawns, execSpawns }) => {
      assert.equal(res.outcome, 'blocked')
      assert.equal(record.status, 'blocked')
      assert.equal(record.error.code, 'plan_invalid')
      assert.match(record.error.detail, /环/)
      assert.equal(planSpawns, 2, '一次格式纠正：共两次规划')
      assert.equal(execSpawns, 0, '不派发任何执行')
      assert.equal(record.planVersions.length, 0)
    },
  })
})

test('规划校验：未知依赖 → blocked(plan_invalid)，0 次执行派发', async (t) => {
  const unknownDep = structuredClone(validPlan)
  unknownDep.tasks = [task('t1', ['ghost'])]
  await runPlanValidation(t, {
    planOutput: unknownDep,
    expect: ({ res, record, execSpawns }) => {
      assert.equal(res.outcome, 'blocked')
      assert.equal(record.status, 'blocked')
      assert.equal(record.error.code, 'plan_invalid')
      assert.match(record.error.detail, /未知任务 ghost/)
      assert.equal(execSpawns, 0)
    },
  })
})

test('规划校验：漏验收 → blocked(plan_invalid)，0 次执行派发', async (t) => {
  const uncovered = structuredClone(validPlan)
  uncovered.tasks = [task('t1', [], { acceptanceIds: ['a9'] })] // a1 无人覆盖
  await runPlanValidation(t, {
    planOutput: uncovered,
    expect: ({ res, record, execSpawns }) => {
      assert.equal(res.outcome, 'blocked')
      assert.equal(record.error.code, 'plan_invalid')
      assert.match(record.error.detail, /验收项 a1 未被任何任务覆盖/)
      assert.equal(execSpawns, 0)
    },
  })
})

test('规划校验：叶子超限（17） → blocked(plan_invalid)，0 次执行派发', async (t) => {
  const oversized = structuredClone(validPlan)
  oversized.tasks = Array.from({ length: 17 }, (_, i) => task(`t${i + 1}`))
  await runPlanValidation(t, {
    planOutput: oversized,
    expect: ({ res, record, execSpawns }) => {
      assert.equal(res.outcome, 'blocked')
      assert.equal(record.error.code, 'plan_invalid')
      assert.match(record.error.detail, /叶子任务 17 超过上限 16/)
      assert.equal(execSpawns, 0)
    },
  })
})

test('规划校验：非法路径（绝对路径/..） → blocked(plan_invalid)，0 次执行派发', async (t) => {
  const badPath = structuredClone(validPlan)
  badPath.tasks = [task('t1', [], { pathScope: ['E:\\evil'] })]
  await runPlanValidation(t, {
    planOutput: badPath,
    expect: ({ res, record, execSpawns }) => {
      assert.equal(res.outcome, 'blocked')
      assert.equal(record.error.code, 'plan_invalid')
      assert.match(record.error.detail, /路径非法/)
      assert.equal(execSpawns, 0)
    },
  })
})

test('规划：无结构化输出 → 两次规划后 blocked(plan_invalid)，0 次执行派发', async (t) => {
  await runPlanValidation(t, {
    planOutput: null,
    expect: ({ res, record, planSpawns, execSpawns }) => {
      assert.equal(res.outcome, 'blocked')
      assert.equal(record.error.code, 'plan_invalid')
      assert.match(record.error.detail, /缺少结构化输出|两次/)
      assert.equal(planSpawns, 2)
      assert.equal(execSpawns, 0)
    },
  })
})

test('规划：一次格式纠正成功（第一次环，第二次合法）→ succeeded；2 次规划 + 2 次执行', async (t) => {
  const cyclic = structuredClone(validPlan)
  cyclic.tasks = [task('t1', ['t2']), task('t2', ['t1'])]
  await runPlanValidation(t, {
    planOutputs: [cyclic, structuredClone(validPlan)],
    expect: ({ res, record, planSpawns, execSpawns }) => {
      assert.equal(res.outcome, 'succeeded')
      assert.equal(record.status, 'succeeded')
      assert.equal(planSpawns, 2, '第一次不合格 → 纠正一次')
      assert.equal(execSpawns, 2, '合法计划正常派发')
      assert.equal(record.planVersions.length, 1)
      assert.equal(record.planVersions[0].version, 1)
      assert.equal(record.tasks.length, 2)
      assert.ok(record.tasks.every((x) => x.status === 'executed'))
    },
  })
})

test('A30：规划第一次已写文件但 JSON 非法 → 纠正禁用 write/exec，文件不被再改，第二次才实施', async (t) => {
  const env = makeStore(t)
  await env.store.open(env.facility)
  const ws = path.join(env.root, 'ws')
  fs.mkdirSync(ws, { recursive: true })
  const touched = path.join(ws, 'notes.txt')
  const cyclic = structuredClone(validPlan)
  cyclic.tasks = [task('t1', ['t2']), task('t2', ['t1'])]
  const fakeSub = makeFakeSubagents(t, { planOutputs: [cyclic, structuredClone(validPlan)] })
  const inner = fakeSub.start
  fakeSub.start = async (kind, opts) => {
    if (opts.label === 'mixed:planning') {
      const n = fakeSub.spawns.filter((s) => s.label === 'mixed:planning').length
      if (n === 0) fs.writeFileSync(touched, 'first-attempt-write\n')
      else if (!opts.toolFilter?.deny?.includes('write')) fs.writeFileSync(touched, 'correction-wrote\n')
    }
    return inner(kind, opts)
  }
  const run = await claimRun(env.store)
  const { controller } = makeController(env.store, fakeSub, run)
  const res = await controller.execute(new AbortController().signal)
  assert.equal(res.outcome, 'succeeded')
  const planSpawns = fakeSub.spawns.filter((s) => s.label === 'mixed:planning')
  assert.equal(planSpawns.length, 2)
  assert.equal(planSpawns[0].opts.toolFilter, undefined, '第一次规划保留工具（模型可能已写文件）')
  assert.deepEqual(planSpawns[1].opts.toolFilter?.deny, ['write', 'edit', 'bash', 'pwsh'], '纠正必须 deny 写入/执行工具')
  assert.equal(fs.readFileSync(touched, 'utf8'), 'first-attempt-write\n', '纠正因 deny write 不得再改文件')
  const execSpawns = fakeSub.spawns.filter((s) => s.label.startsWith('mixed:execution'))
  assert.ok(fakeSub.spawns.findIndex((s) => s.label.startsWith('mixed:execution')) > fakeSub.spawns.findIndex((s) => s.label === 'mixed:planning' && s.opts.toolFilter), '纠正前不实施')
  assert.equal(execSpawns.length, 2)
  await env.store.close()
})
