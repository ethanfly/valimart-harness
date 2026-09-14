/**
 * T06 交付物：mixed-review 测试（证据闭环 + 审核准入 + 返修调度 + blocked 边界）。
 *
 * 覆盖计划 T06 验收：
 * - 执行者谎报成功但测试失败时不能交付（宿主验证退出码是硬门槛，审核模型放行也无效）；
 * - 缺证据、伪造 evidenceId 不能通过；
 * - 审后修改（工作区再变）→ 证据作废、重新审核；
 * - changes_requested → findings 分派 taskId 返修 → 重跑受影响验证 → 整体再审；
 * - 两轮返修耗尽 / 审核输出两次非法 → 明确 blocked。
 *
 * 宿主侧用真实 mixed-store + 真实 EvidenceCollector（真实执行验证进程）+ 假 subagents。
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
import { EvidenceCollector } from '../../plugins/desk-host/lib/mixed/evidence.js'
import { validateReviewOutput, createEvidenceTools, formatReviewRejectionDetail } from '../../plugins/desk-host/lib/mixed/review.js'
import { planPrompt, taskPrompt, reviewPrompt } from '../../plugins/desk-host/lib/mixed/prompts.js'
import { createWorkspaceLocks } from '../../plugins/desk-host/lib/mixed/scheduler.js'
import { MixedError, advanceRun, submissionKeyOf, runIdOf } from '../../plugins/desk-host/lib/mixed/contracts.js'

const OWNER = { ownerKey: 'owner:aaaa', ownerEpoch: 0 }
const MODELS = {
  planner: { catalogProvider: 'deepseek', modelId: 'deepseek-v4-pro', runtimeModelId: 'deepseek-v4-pro', capabilities: { planner: true, executor: true, reviewer: true }, capabilitiesRevision: 'rev-abc123' },
  executor: { catalogProvider: 'xai', modelId: 'grok-4.6', runtimeModelId: 'grok-4.6', capabilities: { planner: false, executor: true, reviewer: true }, capabilitiesRevision: 'rev-abc123' },
  reviewer: { catalogProvider: 'deepseek', modelId: 'deepseek-v4-flash', runtimeModelId: 'deepseek-v4-flash', capabilities: { planner: false, executor: false, reviewer: true }, capabilitiesRevision: 'rev-abc123' },
}
const QUIET = { warn: () => {}, error: () => {}, info: () => {} }
const CHECK = 'import fs from "node:fs"; import path from "node:path"; import assert from "node:assert"; import { fileURLToPath } from "node:url"; const dir = path.dirname(fileURLToPath(import.meta.url)); const app = fs.readFileSync(path.join(dir, "app.mjs"), "utf8"); assert.match(app, /APP_OK/); console.log("check passed")'
const BROKEN_APP = 'export const s = "broken"\n'
const FIXED_APP = 'export const s = "APP_OK"\n'

function makeEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-rev-'))
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-rev-ws-'))
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(ws, { recursive: true, force: true })
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
  const store = new MixedStore({ stateDir, storageRoot, hostId: 'host-t06', ownershipTtlMs: 15000, logger: QUIET })
  return { root, ws, store, facility }
}

async function claimRun(env, { messageId = 'msg-1', goal = '实现 app.mjs 并通过 check.mjs 校验' } = {}) {
  const submissionKey = submissionKeyOf({ ownerKey: OWNER.ownerKey, profileId: 'desk', sessionId: `sess-${messageId}`, sourceMessageId: messageId })
  const runId = runIdOf(submissionKey)
  const { run } = await env.store.claimRun({
    runId,
    ownerKey: OWNER.ownerKey,
    ownerEpoch: 0,
    profileId: 'desk',
    sessionId: `sess-${messageId}`,
    sourceMessageId: messageId,
    submissionKey,
    workspace: { canonicalPath: env.ws, baselineId: 'b-1' },
    models: structuredClone(MODELS),
    policy: { maxRepairRounds: 2, maxReplans: 1 },
    goal,
    inputRefs: [{ kind: 'text', messageId, text: goal }],
  })
  return run
}

const PLAN_TASK = {
  taskId: 't1',
  title: '实现 app.mjs',
  goal: '让 check.mjs 通过',
  dependsOnTaskIds: [],
  inputRefs: [],
  expectedOutputs: ['app.mjs'],
  pathScope: ['app.mjs'],
  acceptanceIds: ['a1'],
  verificationHints: ['node check.mjs'],
  role: 'executor',
  status: 'pending',
  attemptIds: [],
  evidenceIds: [],
}
const planStructured = (goal) => ({
  goal,
  interpretation: '实现 app.mjs 使宿主校验通过',
  knownFacts: [],
  assumptions: [],
  openQuestions: [],
  acceptance: [{ id: 'a1', description: 'check.mjs 校验通过', checkable: true }],
  verificationMethods: ['node check.mjs'],
  tasks: [structuredClone(PLAN_TASK)],
})

function makeFakeSubagents({ exec, review, plan }) {
  const spawns = []
  const counts = {}
  return {
    spawns,
    start: async (kind, opts) => {
      assert.equal(kind, 'spawn')
      const label = opts.label
      counts[label] = (counts[label] ?? 0) + 1
      const n = counts[label]
      spawns.push({ label, n, prompt: opts.prompt?.[0]?.text ?? '' })
      let b
      if (label === 'mixed:planning') {
        b = plan
          ? plan(n, opts)
          : { output: 'plan', stopReason: 'completed', structured: planStructured('实现 app.mjs 并通过 check.mjs 校验') }
      } else if (label.startsWith('mixed:execution:')) {
        b = exec(n, opts)
      } else if (label === 'mixed:review') {
        b = review(n, opts)
      } else {
        throw new Error(`意外 label: ${label}`)
      }
      return { id: `child-${spawns.length}`, result: Promise.resolve(b), dispose: async () => {} }
    },
  }
}

function makeController(env, run, fakeSub, collector) {
  const driver = new MixedDriver({
    ctx: { subagents: fakeSub },
    store: env.store,
    parentAgent: { cancel: () => {} },
    run,
    logger: QUIET,
    stageTimeoutMs: 20000,
  })
  const controller = new MixedRunController({
    store: env.store,
    driver,
    run,
    agent: { cancel: () => {} },
    collector,
    workspaceLocks: createWorkspaceLocks(),
    planPrompt,
    taskPrompt,
    reviewPrompt,
    planSchema: { type: 'object' },
    reviewSchema: { type: 'object' },
    logger: QUIET,
  })
  return { driver, controller }
}

const parseManifestHash = (prompt) => (String(prompt).match(/sha256=([a-f0-9]{64})/) ?? [])[1]

/** 审核假模型：读 run 现状（证据 id）+ 从提示词回填 manifestHash。 */
function makeReviewer(env, runId, { verdict = 'pass', criteriaOf, findingsOf, sideEffect } = {}) {
  return (n, opts) => {
    sideEffect?.(n, opts)
    const run = env.store.getRun(runId)
    const manifestHash = parseManifestHash(opts.prompt?.[0]?.text ?? '')
    const latestVerification = run.evidence.filter((e) => e.type === 'verification').at(-1)?.evidenceId
    const criteria = criteriaOf
      ? criteriaOf(run)
      : run.planVersions.at(-1).acceptance.map((a) => ({
          acceptanceId: a.id,
          status: 'pass',
          evidenceIds: latestVerification ? [latestVerification] : [],
          explanation: '证据核验通过',
        }))
    return {
      output: 'review',
      stopReason: 'completed',
      structured: {
        verdict,
        planVersion: run.planVersions.at(-1).version,
        evidenceManifestHash: manifestHash,
        criteria,
        findings: findingsOf ? findingsOf(run) : [],
        summary: '测试审核',
      },
    }
  }
}

function seedWorkspace(env) {
  fs.writeFileSync(path.join(env.ws, 'check.mjs'), CHECK)
}

function executionAttempts(store, runId, taskId = 't1') {
  return store.getRun(runId).attempts.filter((a) => a.stage === 'execution' && a.taskId === taskId).length
}

// ---------- 验收 A：执行者谎报成功但测试失败 → 不能交付 ----------

test('审核：执行者谎报成功但宿主验证失败 → 审核放行也无效，run blocked(review_rejected)', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  seedWorkspace(env)
  const run = await claimRun(env, { messageId: 'msg-A' })
  const collector = new EvidenceCollector({ storageRoot: env.root, store: env.store, logger: QUIET })

  const fakeSub = makeFakeSubagents({
    // 执行者：写出坏产物，却自报「测试通过」（谎报）
    exec: () => {
      fs.writeFileSync(path.join(env.ws, 'app.mjs'), BROKEN_APP)
      return { output: '完成，所有测试已通过（自报）', stopReason: 'completed' }
    },
    // 审核者：轻信执行者自述，两次都尝试判 pass
    review: makeReviewer(env, run.runId),
  })
  const { controller } = makeController(env, run, fakeSub, collector)
  const res = await controller.execute(new AbortController().signal)
  const rec = env.store.getRun(run.runId)

  assert.equal(res.outcome, 'blocked', '验证失败时绝不能交付')
  assert.equal(rec.status, 'blocked')
  assert.equal(rec.error.code, 'review_rejected')
  assert.match(rec.error.detail, /宿主验证有失败命令/, 'blocked 原因必须指向宿主验证失败')
  assert.equal(res.delivery, undefined)
  // 审核派发了两次（一次格式纠正），轮次未回填结论
  assert.equal(fakeSub.spawns.filter((s) => s.label === 'mixed:review').length, 2)
  assert.equal(rec.reviewRounds.length, 1)
  assert.equal(rec.reviewRounds[0].result, null)
  // 宿主验证证据记录了真实退出码 1
  const ver = rec.evidence.find((e) => e.type === 'verification')
  assert.ok(ver, '宿主验证证据已落盘')
})

// ---------- 验收 B：缺证据不能 pass ----------

test('审核：无证据判 pass → 宿主拒绝（两次）→ blocked，详情指明缺证据', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  seedWorkspace(env)
  const run = await claimRun(env, { messageId: 'msg-B' })
  const collector = new EvidenceCollector({ storageRoot: env.root, store: env.store, logger: QUIET })

  const fakeSub = makeFakeSubagents({
    exec: () => {
      fs.writeFileSync(path.join(env.ws, 'app.mjs'), FIXED_APP)
      return { output: '完成', stopReason: 'completed' }
    },
    review: makeReviewer(env, run.runId, {
      criteriaOf: (r) => r.planVersions.at(-1).acceptance.map((a) => ({ acceptanceId: a.id, status: 'pass', evidenceIds: [], explanation: '我觉得可以' })),
    }),
  })
  const { controller } = makeController(env, run, fakeSub, collector)
  const res = await controller.execute(new AbortController().signal)
  const rec = env.store.getRun(run.runId)

  assert.equal(res.outcome, 'blocked')
  assert.equal(rec.error.code, 'review_rejected')
  assert.match(rec.error.detail, /无证据判 pass/)
  assert.equal(fakeSub.spawns.filter((s) => s.label === 'mixed:review').length, 2)
})

// ---------- 验收 C：伪造 evidenceId 不能通过 ----------

test('审核：引用不存在的 evidenceId（伪造）→ 宿主拒绝 → blocked，详情指明伪造', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  seedWorkspace(env)
  const run = await claimRun(env, { messageId: 'msg-C' })
  const collector = new EvidenceCollector({ storageRoot: env.root, store: env.store, logger: QUIET })

  const fakeSub = makeFakeSubagents({
    exec: () => {
      fs.writeFileSync(path.join(env.ws, 'app.mjs'), FIXED_APP)
      return { output: '完成', stopReason: 'completed' }
    },
    review: makeReviewer(env, run.runId, {
      criteriaOf: (r) => r.planVersions.at(-1).acceptance.map((a) => ({ acceptanceId: a.id, status: 'pass', evidenceIds: ['ev_forged_123'], explanation: '看这里' })),
    }),
  })
  const { controller } = makeController(env, run, fakeSub, collector)
  const res = await controller.execute(new AbortController().signal)
  const rec = env.store.getRun(run.runId)

  assert.equal(res.outcome, 'blocked')
  assert.equal(rec.error.code, 'review_rejected')
  assert.match(rec.error.detail, /不存在的 evidenceId: ev_forged_123/)
})

// ---------- 验收 D：审后修改 → 证据作废 → 重新审核 ----------

test('审核：审后工作区再变化 → 验证证据作废并重新审核（不直接交付）', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  seedWorkspace(env)
  const run = await claimRun(env, { messageId: 'msg-D' })
  const collector = new EvidenceCollector({ storageRoot: env.root, store: env.store, logger: QUIET })

  const fakeSub = makeFakeSubagents({
    exec: () => {
      fs.writeFileSync(path.join(env.ws, 'app.mjs'), FIXED_APP)
      return { output: '完成', stopReason: 'completed' }
    },
    review: makeReviewer(env, run.runId, {
      // 第一轮审核进行中被外部改动了工作区（审后修改）
      sideEffect: (n) => {
        if (n === 1) fs.writeFileSync(path.join(env.ws, 'stray.txt'), 'external change during review')
      },
    }),
  })
  const { controller } = makeController(env, run, fakeSub, collector)
  const res = await controller.execute(new AbortController().signal)
  const rec = env.store.getRun(run.runId)

  assert.equal(res.outcome, 'succeeded', '重审后仍可交付（变化本身不破坏产物）')
  assert.equal(rec.reviewRounds.length, 2, '发生了一轮重审')
  const verifications = rec.evidence.filter((e) => e.type === 'verification')
  assert.equal(verifications.length, 2, '重审前重跑了验证')
  assert.equal(verifications[0].invalidated, true, '第一轮的验证证据因输入树变化作废')
  assert.equal(verifications[1].invalidated, false)
  assert.equal(fakeSub.spawns.filter((s) => s.label === 'mixed:review').length, 2)
})

// ---------- 验收 E：changes_requested → 返修 → 重跑验证 → 整体再审 → 交付 ----------

test('审核：返修闭环（findings 分派 taskId → 小模型返修 → 重跑受影响验证 → 整体再审 → succeeded）', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  seedWorkspace(env)
  const run = await claimRun(env, { messageId: 'msg-E' })
  const collector = new EvidenceCollector({ storageRoot: env.root, store: env.store, logger: QUIET })

  const fakeSub = makeFakeSubagents({
    exec: (n) => {
      if (n === 1) {
        fs.writeFileSync(path.join(env.ws, 'app.mjs'), BROKEN_APP)
        return { output: '完成了，应该没问题', stopReason: 'completed' }
      }
      // 返修：按 repairNotes 修复
      fs.writeFileSync(path.join(env.ws, 'app.mjs'), FIXED_APP)
      return { output: '已修复', stopReason: 'completed' }
    },
    review: (n, opts) => {
      if (n === 1) {
        const runNow = env.store.getRun(run.runId)
        const ev = runNow.evidence.filter((e) => e.type === 'verification').at(-1).evidenceId
        return {
          output: 'review',
          stopReason: 'completed',
          structured: {
            verdict: 'changes_requested',
            planVersion: 1,
            evidenceManifestHash: parseManifestHash(opts.prompt?.[0]?.text ?? ''),
            criteria: [{ acceptanceId: 'a1', status: 'fail', evidenceIds: [ev], explanation: 'check.mjs exit=1' }],
            findings: [
              {
                findingId: 'f1',
                taskIds: ['t1'],
                severity: 'blocking',
                evidenceIds: [ev],
                expected: 'check.mjs 通过',
                actual: 'assert.match 失败（app.mjs 无 APP_OK）',
                repairInstruction: '修复 app.mjs：内容必须包含 APP_OK 标记',
              },
            ],
            summary: '产物未通过校验',
          },
        }
      }
      // 第二轮：整体再审 → pass
      const runNow = env.store.getRun(run.runId)
      const ev = runNow.evidence.filter((e) => e.type === 'verification' && !e.invalidated).at(-1).evidenceId
      return {
        output: 'review',
        stopReason: 'completed',
        structured: {
          verdict: 'pass',
          planVersion: 1,
          evidenceManifestHash: parseManifestHash(opts.prompt?.[0]?.text ?? ''),
          criteria: [{ acceptanceId: 'a1', status: 'pass', evidenceIds: [ev], explanation: '重跑验证 exit=0' }],
          findings: [],
          summary: '返修后通过',
        },
      }
    },
  })
  const { controller } = makeController(env, run, fakeSub, collector)
  const res = await controller.execute(new AbortController().signal)
  const rec = env.store.getRun(run.runId)

  assert.equal(res.outcome, 'succeeded')
  assert.deepEqual(res.delivery.accepted, ['a1'])
  assert.equal(rec.reviewRounds.length, 2)
  assert.equal(rec.reviewRounds[0].result.verdict, 'changes_requested')
  assert.equal(rec.reviewRounds[1].result.verdict, 'pass')
  // 返修分派与重跑
  assert.equal(executionAttempts(env.store, run.runId), 2, 't1 初始实施 + 一次返修')
  const t1 = rec.tasks.find((x) => x.taskId === 't1')
  assert.equal(t1.status, 'executed')
  assert.ok(t1.repairNotes.some((s) => s.includes('修复 app.mjs')), '返修指令落到任务')
  const repairSpawns = fakeSub.spawns.filter((s) => s.label === 'mixed:execution:t1' && s.n === 2)
  assert.equal(repairSpawns.length, 1)
  assert.match(repairSpawns[0].prompt, /修复 app\.mjs/, '返修提示词携带 findings 指令')
  assert.ok(rec.events.some((e) => e.type === 'repair_assigned'))
  // 验证重跑：两轮验证证据，旧的作废
  const verifications = rec.evidence.filter((e) => e.type === 'verification')
  assert.equal(verifications.length, 2)
  assert.equal(verifications[0].invalidated, true)
  assert.equal(verifications[1].invalidated, false)
})

test('formatReviewRejectionDetail：必须写出摘要、未过验收、期望/实际/返修指令', () => {
  const text = formatReviewRejectionDetail({
    verdict: 'changes_requested',
    result: {
      summary: 'HMAC webhook 仍未通过',
      criteria: [
        { acceptanceId: 'a1', status: 'fail', explanation: '签名校验失败' },
        { acceptanceId: 'a2', status: 'pass', explanation: '健康检查通过' },
      ],
      findings: [{
        findingId: 'f1',
        taskIds: ['t3'],
        severity: 'blocking',
        expected: 'HMAC 校验绿',
        actual: 'docker-compose 未起 webhook',
        repairInstruction: '补 docker-compose 并跑签名用例',
      }],
    },
  })
  assert.match(text, /changes_requested/)
  assert.match(text, /HMAC webhook 仍未通过/)
  assert.match(text, /a1/)
  assert.match(text, /签名校验失败/)
  assert.doesNotMatch(text, /健康检查通过/)
  assert.match(text, /期望：HMAC 校验绿/)
  assert.match(text, /实际：docker-compose 未起 webhook/)
  assert.match(text, /返修：补 docker-compose 并跑签名用例/)
})

// ---------- 验收 F：两轮返修耗尽 → 明确 blocked ----------

test('审核：changes_requested 两轮返修耗尽 → blocked(review_rejected)，不无限循环', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  seedWorkspace(env)
  const run = await claimRun(env, { messageId: 'msg-F' })
  const collector = new EvidenceCollector({ storageRoot: env.root, store: env.store, logger: QUIET })

  const finding = (run) => {
    const ev = run.evidence.filter((e) => e.type === 'verification').at(-1).evidenceId
    return [
      {
        findingId: 'f1',
        taskIds: ['t1'],
        severity: 'blocking',
        evidenceIds: [ev],
        expected: 'check.mjs 通过',
        actual: '仍失败',
        repairInstruction: '再试一次',
      },
    ]
  }
  const fakeSub = makeFakeSubagents({
    // 永远修不好
    exec: () => {
      fs.writeFileSync(path.join(env.ws, 'app.mjs'), BROKEN_APP)
      return { output: '完成', stopReason: 'completed' }
    },
    review: makeReviewer(env, run.runId, {
      verdict: 'changes_requested',
      criteriaOf: (r) => {
        const ev = r.evidence.filter((e) => e.type === 'verification').at(-1).evidenceId
        return r.planVersions.at(-1).acceptance.map((a) => ({ acceptanceId: a.id, status: 'fail', evidenceIds: [ev], explanation: '仍失败' }))
      },
      findingsOf: finding,
    }),
  })
  const { controller } = makeController(env, run, fakeSub, collector)
  const res = await controller.execute(new AbortController().signal)
  const rec = env.store.getRun(run.runId)

  assert.equal(res.outcome, 'blocked')
  assert.equal(rec.status, 'blocked')
  assert.equal(rec.error.code, 'review_rejected')
  assert.match(rec.error.detail, /审核摘要|仍失败/)
  assert.match(rec.error.detail, /期望：check\.mjs 通过/)
  assert.match(rec.error.detail, /实际：仍失败/)
  assert.match(rec.error.detail, /返修：再试一次/)
  assert.equal(rec.reviewRounds.length, 3, '审核 3 轮 = 初始 + 2 次返修后重审')
  assert.equal(executionAttempts(env.store, run.runId), 3, '初始 + 2 次返修')
  assert.ok(rec.events.filter((e) => e.type === 'repair_assigned').length >= 2)
})

// ---------- 验收 G：审核异常（两次无有效结构化输出）→ blocked ----------

test('审核：审核输出两次无效（无结构化结论）→ blocked(review_rejected)，轮次不落结论', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  seedWorkspace(env)
  const run = await claimRun(env, { messageId: 'msg-G' })
  const collector = new EvidenceCollector({ storageRoot: env.root, store: env.store, logger: QUIET })

  const fakeSub = makeFakeSubagents({
    exec: () => {
      fs.writeFileSync(path.join(env.ws, 'app.mjs'), FIXED_APP)
      return { output: '完成', stopReason: 'completed' }
    },
    review: () => ({ output: '（模型只输出了闲聊，无结构化结论）', stopReason: 'completed', structured: undefined }),
  })
  const { controller } = makeController(env, run, fakeSub, collector)
  const res = await controller.execute(new AbortController().signal)
  const rec = env.store.getRun(run.runId)

  assert.equal(res.outcome, 'blocked')
  assert.equal(rec.error.code, 'review_rejected')
  assert.equal(rec.reviewRounds.length, 1)
  assert.equal(rec.reviewRounds[0].result, null)
  assert.equal(fakeSub.spawns.filter((s) => s.label === 'mixed:review').length, 2)
})

// ---------- 宿主 verdict 校验矩阵（纯函数）----------

test('validateReviewOutput：拒绝规则矩阵（未知/缺失/重复验收、过期 manifest、作废证据、blocking、宿主验证失败）', () => {
  const run = {
    planVersions: [{ version: 1, acceptance: [{ id: 'a1' }, { id: 'a2' }] }],
    tasks: [{ taskId: 't1', acceptanceIds: ['a1', 'a2'] }],
    evidence: [
      { evidenceId: 'ev1', type: 'verification', invalidated: false },
      { evidenceId: 'ev2', type: 'verification', invalidated: true },
    ],
  }
  const ok = {
    verdict: 'pass',
    planVersion: 1,
    evidenceManifestHash: 'H',
    criteria: [
      { acceptanceId: 'a1', status: 'pass', evidenceIds: ['ev1'], explanation: 'x' },
      { acceptanceId: 'a2', status: 'pass', evidenceIds: ['ev1'], explanation: 'x' },
    ],
    findings: [],
    summary: 's',
  }
  const V = (review, verificationExits = new Map(), manifestHash = 'H') =>
    validateReviewOutput({ run, review, manifestHash, planVersion: 1, verificationExits })

  assert.ok(V(ok).ok, '合法 pass 通过')

  assert.ok(!V({ ...ok, verdict: 'maybe' }).ok, '非法 verdict')
  assert.ok(!V(ok, new Map(), 'OTHER').ok, 'manifest hash 不匹配（过期）')
  assert.ok(!V({ ...ok, planVersion: 2 }).ok, 'planVersion 不匹配')
  assert.ok(!V({ ...ok, criteria: [ok.criteria[0]] }).ok, '缺失必验项')
  assert.ok(!V({ ...ok, criteria: [...ok.criteria, { acceptanceId: 'a9', status: 'pass', evidenceIds: ['ev1'], explanation: '' }] }).ok, '未知 acceptanceId')
  assert.ok(!V({ ...ok, criteria: [...ok.criteria, ok.criteria[0]] }).ok, '重复验收项')
  assert.ok(!V({ ...ok, criteria: [{ acceptanceId: 'a1', status: 'unverified', evidenceIds: [], explanation: '' }, ok.criteria[1]] }).ok, '未验证项却整体 pass')
  assert.ok(!V({ ...ok, criteria: [{ acceptanceId: 'a1', status: 'pass', evidenceIds: [], explanation: '' }, ok.criteria[1]] }).ok, '无证据判 pass')
  assert.ok(!V({ ...ok, criteria: [{ acceptanceId: 'a1', status: 'pass', evidenceIds: ['ev2'], explanation: '' }, ok.criteria[1]] }).ok, '作废证据判 pass')
  assert.ok(!V({ ...ok, criteria: [{ acceptanceId: 'a1', status: 'pass', evidenceIds: ['ev_fake'], explanation: '' }, ok.criteria[1]] }).ok, '伪造 evidenceId')
  assert.ok(
    !V({ ...ok, findings: [{ findingId: 'f1', taskIds: ['t1'], severity: 'blocking', evidenceIds: ['ev1'], expected: 'e', actual: 'a', repairInstruction: 'r' }] }).ok,
    'blocking finding 不得 pass',
  )
  assert.ok(
    !V(ok, new Map([['node check.mjs', 1]])).ok,
    '宿主验证失败不得 pass（模型自报不是测试证据）',
  )
  assert.ok(
    V(ok, new Map([['Test-Path t12-notes.txt 确认存在', null]])).ok,
    '未启动的验证（PowerShell/自然语言）不得拦 pass',
  )
  assert.ok(!V({ ...ok, findings: [{ findingId: 'f1', taskIds: ['tX'], severity: 'blocking', evidenceIds: [], expected: 'e', actual: 'a', repairInstruction: 'r' }], verdict: 'changes_requested' }).ok, 'finding 引用不存在任务')
  // changes_requested 允许携带 blocking finding
  assert.ok(V({ ...ok, verdict: 'changes_requested', findings: [{ findingId: 'f1', taskIds: ['t1'], severity: 'blocking', evidenceIds: ['ev1'], expected: 'e', actual: 'a', repairInstruction: 'r' }] }).ok)
})

// ---------- 审核专用证据接口（受控）----------

test('createEvidenceTools：未授权验证命令被拒；计划内命令可执行并落 reviewer 证据', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  seedWorkspace(env)
  fs.writeFileSync(path.join(env.ws, 'app.mjs'), FIXED_APP)
  const run = await claimRun(env, { messageId: 'msg-T' })
  await env.store.updateRun(run.runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      event: { type: 'plan_saved', summary: '测试计划' },
      patch: {
        planVersions: [
          {
            version: 1,
            goal: run.goal,
            acceptance: [{ id: 'a1', description: 'check 通过', checkable: true }],
            tasks: ['t1'],
            verificationMethods: ['node check.mjs'],
          },
        ],
        tasks: [structuredClone(PLAN_TASK)],
      },
    }),
  )
  const collector = new EvidenceCollector({ storageRoot: env.root, store: env.store, logger: QUIET })
  const tools = createEvidenceTools({ collector, store: env.store, runId: run.runId, workspaceRoot: env.ws })

  // 未授权命令（不在计划 verificationMethods 内）→ 拒绝
  await assert.rejects(
    () => tools.runVerification('node -e "process.exit(0)"'),
    (e) => e instanceof MixedError && e.code === 'evidence_invalid',
  )
  // 计划内命令 → 宿主实际执行
  const res = await tools.runVerification('node check.mjs')
  assert.equal(res.exitCode, 0)
  assert.equal(res.passed, true)
  const rec = env.store.getRun(run.runId)
  const ev = rec.evidence.find((e) => e.type === 'verification')
  assert.ok(ev, '审核再验证证据落盘')
  assert.equal(ev.producer, 'reviewer')
  // 清单与读取
  const list = tools.listEvidence()
  assert.ok(list.some((e) => e.evidenceId === ev.evidenceId))
  const out = tools.readEvidence(ev.evidenceId, { kind: 'stdout' })
  assert.match(out.content, /check passed/)
  // 不存在的 evidenceId
  assert.throws(() => tools.readEvidence('ev_nope'), (e) => e instanceof MixedError)
})

// ---------- 回归：LLM 旧形状（note 而非 explanation / severity minor / 缺 expected、actual） ----------
// 真内核 v9–v12 五次确定性复现的根因：REVIEW_OUTPUT_SCHEMA 与 store 记录 schema 字段不一致
// （criteria 用可选 note，store 必填 explanation；severity 枚举 minor/info vs blocking/nonblocking）
// → 审核轮回填写被 store zod 拒收 →（旧代码）误判存储 unhealthy → 其后所有写被拒 → run 冻结在
// reviewing。现在：LLM schema 已对齐 + 写边界兜底归一 → 旧形状也能落盘，且存储保持健康。

test('回归：审核输出为旧/残缺形状（note、minor、缺 expected/actual）→ 归一后落盘，run 成功，存储保持健康', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  seedWorkspace(env)
  const run = await claimRun(env, { messageId: 'msg-LEGACY' })
  const collector = new EvidenceCollector({ storageRoot: env.root, store: env.store, logger: QUIET })

  const fakeSub = makeFakeSubagents({
    exec: () => {
      fs.writeFileSync(path.join(env.ws, 'app.mjs'), FIXED_APP)
      return { output: '完成', stopReason: 'completed' }
    },
    review: (n, opts) => {
      const runNow = env.store.getRun(run.runId)
      const ev = runNow.evidence.filter((e) => e.type === 'verification').at(-1)?.evidenceId
      // 完全按旧 LLM schema 的形状输出（note 代替 explanation、severity=minor、description 代替三要素、缺 repairInstruction）
      return {
        output: 'review',
        stopReason: 'completed',
        structured: {
          verdict: 'pass',
          planVersion: runNow.planVersions.at(-1).version,
          evidenceManifestHash: parseManifestHash(opts.prompt?.[0]?.text ?? ''),
          criteria: runNow.planVersions.at(-1).acceptance.map((a) => ({
            acceptanceId: a.id,
            status: 'pass',
            evidenceIds: ev ? [ev] : [],
            note: '旧字段 note 的说明',
          })),
          findings: [
            { findingId: 'f1', taskIds: ['t1'], severity: 'minor', description: '旧字段 description', evidenceIds: [] },
          ],
          summary: '旧形状审核',
        },
      }
    },
  })
  const { controller } = makeController(env, run, fakeSub, collector)
  const res = await controller.execute(new AbortController().signal)
  const rec = env.store.getRun(run.runId)

  assert.equal(res.outcome, 'succeeded', '旧形状归一后应能正常交付（而不是冻结在 reviewing）')
  assert.equal(rec.status, 'succeeded')
  // 回填写必须落盘（根因场景：这一步曾整写被拒）
  assert.ok(rec.reviewRounds[0].result, '审核轮结论已回填（不再 result=null 悬空）')
  const c0 = rec.reviewRounds[0].result.criteria[0]
  assert.equal(c0.explanation, '旧字段 note 的说明', 'note 兼容映射到 explanation')
  const f0 = rec.reviewRounds[0].result.findings[0]
  assert.equal(f0.severity, 'nonblocking', 'minor 收敛到 store 枚举 nonblocking')
  assert.equal(f0.expected, '')
  assert.equal(f0.actual, '')
  assert.equal(f0.repairInstruction, '')
  // 关键回归点：存储不得被数据形状问题误判 unhealthy（否则 blocked 收敛写也会被拒 → 冻结）
  assert.equal(env.store.healthy, true, '数据形状问题不得误判存储 unhealthy')
})

// ---------- 回归：store 层 invalid-record 分类（数据错误 ≠ 存储故障） ----------

test('存储：记录校验失败（advanceRun 内 ZodError）→ record_validation_failed，存储保持健康、后续写可用', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  const run = await claimRun(env, { messageId: 'msg-INVALID' })
  // 经 advanceRun（真实校验门槛）注入一条不符合 runRecordSchema 的写：
  // criteria 缺 explanation = 真内核 v9–v12 事故的形状（旧 LLM schema 只有可选 note）
  await assert.rejects(
    env.store.updateRun(run.runId, (cur) =>
      advanceRun(cur, {
        ownerKey: cur.ownerKey,
        ownerEpoch: cur.ownerEpoch,
        event: { type: 'review_round', summary: '形状错误的回填写' },
        patch: {
          reviewRounds: [{ roundId: 'rev_x', planVersion: 1, evidenceManifestHash: 'a'.repeat(64), result: { verdict: 'pass', planVersion: 1, evidenceManifestHash: 'a'.repeat(64), criteria: [{ acceptanceId: 'a1', status: 'pass', evidenceIds: [] }], findings: [], summary: 'x' }, startedAt: new Date().toISOString() }],
        },
      }),
    ),
    (e) => e instanceof MixedError && e.code === 'record_validation_failed',
  )
  // 数据错误不得判存储故障：healthy 仍为 true、无降级标记、后续合法写正常
  assert.equal(env.store.healthy, true)
  assert.equal(env.store.readDegradedMarker(), null)
  const next = await env.store.updateRun(run.runId, (cur) => advanceRun(cur, {
    ownerKey: cur.ownerKey,
    ownerEpoch: cur.ownerEpoch,
    event: { type: 'updated', summary: '后续合法写' },
    patch: {},
  }))
  assert.equal(next.revision, run.revision + 1, '失败的推进不落盘不 bump revision，后续写从原 rev 继续')
  await env.store.close()
})

// ---------- A27：非 Git 工作区 + 文档/二进制产物 ----------

test('A27：非 Git 工作区文档+二进制产物有自身验收证据，审核可据此交付', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  assert.equal(fs.existsSync(path.join(env.ws, '.git')), false, '工作区无 Git')
  const checkDocs = [
    'import fs from "node:fs"',
    'import assert from "node:assert"',
    'const md = fs.readFileSync("GUIDE.md", "utf8")',
    'assert.match(md, /^# Mixed 文档任务/m)',
    'const bin = fs.readFileSync("icon.bin")',
    'assert.equal(bin.length, 16)',
    'assert.equal(bin[0], 0x89)',
    'console.log("docs-binary-ok")',
  ].join(';')
  fs.writeFileSync(path.join(env.ws, 'check-docs.mjs'), checkDocs)
  const goal = '写 GUIDE.md（一级标题）和 16 字节 icon.bin，不要改代码模块'
  const run = await claimRun(env, { messageId: 'msg-A27', goal })
  const collector = new EvidenceCollector({ storageRoot: env.root, store: env.store, logger: QUIET })
  const baseline = await collector.collectBaseline(env.store, run)
  assert.equal(baseline.git, false, '非 Git 基线')
  assert.ok(baseline.manifest.some((m) => m.rel === 'check-docs.mjs'))

  const docTask = {
    ...PLAN_TASK,
    taskId: 'tDoc',
    title: '写说明与图标',
    goal: '产出 GUIDE.md 与 icon.bin',
    expectedOutputs: ['GUIDE.md', 'icon.bin'],
    pathScope: ['GUIDE.md', 'icon.bin'],
    verificationHints: ['node check-docs.mjs'],
  }
  const fakeSub = makeFakeSubagents({
    plan: () => ({
      output: 'plan',
      stopReason: 'completed',
      structured: {
        goal,
        interpretation: '文档与二进制产物，无代码模块',
        knownFacts: [],
        assumptions: [],
        openQuestions: [],
        acceptance: [{ id: 'a1', description: 'GUIDE.md 有标题且 icon.bin 为 16 字节 PNG 头', checkable: true }],
        verificationMethods: ['node check-docs.mjs'],
        tasks: [structuredClone(docTask)],
      },
    }),
    exec: () => {
      fs.writeFileSync(path.join(env.ws, 'GUIDE.md'), '# Mixed 文档任务\n\n验收说明。\n')
      fs.writeFileSync(path.join(env.ws, 'icon.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]))
      return { output: '已写 GUIDE.md 与 icon.bin', stopReason: 'completed' }
    },
    review: makeReviewer(env, run.runId),
  })
  const { controller } = makeController(env, run, fakeSub, collector)
  const res = await controller.execute(new AbortController().signal)
  const rec = env.store.getRun(run.runId)
  assert.equal(res.outcome, 'succeeded')
  assert.equal(rec.status, 'succeeded')
  const artifacts = rec.evidence.find((e) => e.type === 'file-manifest')
  assert.ok(artifacts, '产物清单已落盘')
  const listed = JSON.parse(fs.readFileSync(path.join(env.root, 'mixed-evidence', run.runId, artifacts.ref), 'utf8'))
  const byRel = Object.fromEntries((listed.diff ?? []).map((d) => [d.rel, d.status]))
  assert.equal(byRel['GUIDE.md'], 'added')
  assert.equal(byRel['icon.bin'], 'added')
  const ver = rec.evidence.find((e) => e.type === 'verification' && !e.invalidated)
  assert.ok(ver, '文档/二进制校验由宿主执行')
  const stdout = collector.readEvidence(run.runId, ver.evidenceId, { kind: 'stdout' })
  assert.match(stdout.content, /docs-binary-ok/)
  assert.equal(fs.readFileSync(path.join(env.ws, 'icon.bin')).length, 16)
})
