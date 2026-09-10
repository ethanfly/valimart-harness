/**
 * T03 交付物：mixed-store 测试。
 * 直接驱动内核真实存储栈（@deepseek-ai/dsh-storage-json 后端 + dsh-storage-domain 域层），
 * 不起完整内核：DomainFacility.open(mixedDomainSpec) 走真实 zod 校验 / 写链 / backup-and-skip /
 * per-record 介质布局。
 *
 * 验收（计划 T03）：
 *  - 重复领取一条消息只有一个 run（含并发领取）；
 *  - 双宿主不能同时写同一目录（所有权独占 + 失活接管）；
 *  - 坏记录不清空（backup-and-skip：字节保留 .bak，记录读作缺失）；
 *  - 状态落盘失败时停止派发（healthy=false 后所有写立即拒绝）；
 *  - 崩溃窗口：attempt starting 已持久化、宿主死亡后重开仍在（结果未知，不自动重放）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import {
  MixedStore,
  mixedDomainSpec,
  pathSafeKey,
} from '../../plugins/desk-host/lib/mixed/store.js'
import {
  MixedError,
  submissionKeyOf,
  runIdOf,
  rerunRunIdOf,
  advanceRun,
  validatePlanGraph,
  MIXED_SCHEMA_VERSION,
} from '../../plugins/desk-host/lib/mixed/contracts.js'

// ---------- 测试环境：真实存储栈 + 临时目录 ----------

/**
 * reuse = 既有的 env（同一存储目录、不同宿主实例）；不传则新建临时目录。
 * 双宿主/重开测试必须 reuse 原 env 的目录——新目录 = 空库，测不到任何东西。
 */
function makeEnv(t, { hostId = 'host-a', ttlMs = 15000, reuse, writeTimeoutMs } = {}) {
  const root = reuse ? reuse.root : fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-store-'))
  if (!reuse) t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const stateDir = reuse ? reuse.stateDir : path.join(root, 'desk')
  const storageRoot = reuse ? reuse.storageRoot : path.join(root, 'storages')
  const backend = new JsonStorageBackend(storageRoot)
  const logs = []
  const ctx = {
    storage: { backend: { get: (name) => (name === 'json' ? backend : undefined) } },
    logger: { warn: (m) => logs.push(['warn', String(m)]), error: (m) => logs.push(['error', String(m)]) },
    emit: () => {},
  }
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  const store = new MixedStore({ stateDir, storageRoot, hostId, ownershipTtlMs: ttlMs, ...(writeTimeoutMs ? { writeTimeoutMs } : {}), logger: { warn: () => {}, error: () => {} } })
  return { root, stateDir, storageRoot, backend, facility, store, logs }
}

const MODELS = {
  planner: { catalogProvider: 'deepseek', modelId: 'deepseek-v4-pro', runtimeModelId: 'deepseek-v4-pro', capabilities: { planner: true, executor: true, reviewer: true }, capabilitiesRevision: 'rev-abc123' },
  executor: { catalogProvider: 'xai', modelId: 'grok-4.6', runtimeModelId: 'grok-4.6', capabilities: { planner: false, executor: true, reviewer: true }, capabilitiesRevision: 'rev-abc123' },
  reviewer: { catalogProvider: 'deepseek', modelId: 'deepseek-v4-flash', runtimeModelId: 'deepseek-v4-flash', capabilities: { planner: false, executor: false, reviewer: true }, capabilitiesRevision: 'rev-abc123' },
}

function claimParams(over = {}) {
  // 派生键必须基于覆写后的身份字段（否则不同消息会派生出同一 runId）
  const ownerKey = over.ownerKey ?? 'owner:aaaa'
  const profileId = over.profileId ?? 'desk'
  const sessionId = over.sessionId ?? 'sess-1'
  const sourceMessageId = over.sourceMessageId ?? 'msg-1'
  const submissionKey = over.submissionKey ?? submissionKeyOf({ ownerKey, profileId, sessionId, sourceMessageId })
  const runId = over.runId ?? runIdOf(submissionKey)
  return {
    runId,
    ownerKey,
    ownerEpoch: 0,
    profileId,
    sessionId,
    sourceMessageId,
    submissionKey,
    workspace: { canonicalPath: 'E:\\ws', baselineId: 'b-1' },
    models: structuredClone(MODELS),
    policy: { maxRepairRounds: 2 },
    goal: '修好登录 bug',
    inputRefs: [{ kind: 'text', messageId: sourceMessageId, text: '帮我修登录 bug' }],
    ...over,
  }
}

const runEvent = (type) => ({ type, summary: `${type} 测试事件` })

// ---------- 领取与去重 ----------

test('首次 get+put 领取；重复领取返回既有 run（created=false）', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  const p = claimParams()
  const first = await env.store.claimRun(p)
  assert.equal(first.created, true)
  assert.equal(first.run.status, 'queued')
  assert.equal(first.run.revision, 1)
  assert.equal(first.run.eventSeq, 1)
  assert.equal(first.run.events[0].type, 'claimed')

  const second = await env.store.claimRun(p)
  assert.equal(second.created, false)
  assert.equal(second.run.runId, first.run.runId)
  assert.equal(second.run.revision, 1)

  // 读取返回深拷贝：改坏副本不影响存储
  const copy = await env.store.getRun(p.runId)
  copy.goal = '被篡改'
  const fresh = await env.store.getRun(p.runId)
  assert.equal(fresh.goal, '修好登录 bug')

  const list = env.store.listRuns({ ownerKey: 'owner:aaaa' })
  assert.equal(list.items.length, 1)
  await env.store.close()
})

test('并发重复领取一条消息 → 只有一个 run（T03 验收）', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  const p = claimParams()
  const results = await Promise.all([env.store.claimRun(p), env.store.claimRun(p), env.store.claimRun(p), env.store.claimRun(p)])
  const created = results.filter((r) => r.created)
  assert.equal(created.length, 1)
  assert.equal(new Set(results.map((r) => r.run.runId)).size, 1)
  assert.equal(env.store.listRuns({}).items.length, 1)
  await env.store.close()
})

test('不同消息 → 不同 run；rerun runId 由原 run + rerunRequestId 派生且稳定', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  const a = await env.store.claimRun(claimParams({ sourceMessageId: 'msg-1' }))
  const b = await env.store.claimRun(claimParams({ sourceMessageId: 'msg-2' }))
  assert.notEqual(a.run.runId, b.run.runId)
  const r1 = rerunRunIdOf(a.run.runId, 'rer-1')
  assert.equal(r1, rerunRunIdOf(a.run.runId, 'rer-1'))
  assert.notEqual(r1, a.run.runId)
  assert.notEqual(r1, rerunRunIdOf(a.run.runId, 'rer-2'))
  await env.store.close()
})

// ---------- 单 run 原子条件更新 / 状态机 / 栅栏 ----------

test('advanceRun 经 updateRun 落盘：revision/eventSeq 递增、状态迁移校验', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  const { run } = await env.store.claimRun(claimParams())
  const ok = await env.store.updateRun(run.runId, (cur) => advanceRun(cur, { ownerKey: 'owner:aaaa', ownerEpoch: 0, to: 'planning', event: runEvent('plan_started') }))
  assert.equal(ok.status, 'planning')
  assert.equal(ok.revision, 2)
  assert.equal(ok.eventSeq, 2)
  assert.equal(ok.events[1].type, 'plan_started')

  // 非法迁移 planning → succeeded 被拒，记录不变
  await assert.rejects(
    env.store.updateRun(run.runId, (cur) => advanceRun(cur, { ownerKey: 'owner:aaaa', ownerEpoch: 0, to: 'succeeded' })),
    (e) => e instanceof MixedError && e.code === 'run_not_in_status',
  )
  const after = await env.store.getRun(run.runId)
  assert.equal(after.status, 'planning')
  assert.equal(after.revision, 2)
  await env.store.close()
})

test('owner/epoch 栅栏：旧 owner 或旧 epoch 不能推进（§4.3/§6.1）', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  const { run } = await env.store.claimRun(claimParams())
  await assert.rejects(
    env.store.updateRun(run.runId, (cur) => advanceRun(cur, { ownerKey: 'owner:bbbb', ownerEpoch: 0, to: 'planning' })),
    (e) => e instanceof MixedError && e.code === 'owner_mismatch',
  )
  await assert.rejects(
    env.store.updateRun(run.runId, (cur) => advanceRun(cur, { ownerKey: 'owner:aaaa', ownerEpoch: 5, to: 'planning' })),
    (e) => e instanceof MixedError && e.code === 'owner_epoch_stale',
  )
  await env.store.close()
})

test('revision 冲突：expectedRevision 高于当前 → run_revision_conflict（409）', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  const { run } = await env.store.claimRun(claimParams())
  await assert.rejects(
    env.store.updateRun(run.runId, (cur) => advanceRun(cur, { ownerKey: 'owner:aaaa', ownerEpoch: 0, expectedRevision: 99, to: 'planning' })),
    (e) => e instanceof MixedError && e.code === 'run_revision_conflict' && e.httpStatus === 409,
  )
  await env.store.close()
})

// ---------- 双宿主所有权（T03 验收）----------

test('双宿主不能同时写同一目录：新鲜锁 → ownership_conflict', async (t) => {
  const envA = makeEnv(t, { hostId: 'host-a' })
  const envB = makeEnv(t, { hostId: 'host-b', reuse: envA })
  await envA.store.open(envA.facility)
  const { run } = await envA.store.claimRun(claimParams())

  await assert.rejects(envB.store.open(envB.facility), (e) => e instanceof MixedError && e.code === 'ownership_conflict')
  // A 不受影响，继续写
  const ok = await envA.store.updateRun(run.runId, (cur) => advanceRun(cur, { ownerKey: 'owner:aaaa', ownerEpoch: 0, to: 'planning' }))
  assert.equal(ok.status, 'planning')

  // 释放后 B 可取得
  await envA.store.close()
  await envB.store.open(envB.facility)
  const got = await envB.store.getRun(run.runId)
  assert.equal(got.status, 'planning')
  await envB.store.close()
})

test('失活宿主（心跳超时）被接管；本宿主重开只续期', async (t) => {
  const env = makeEnv(t)
  const envA = makeEnv(t, { hostId: 'host-a', reuse: env })
  await envA.store.open(envA.facility)
  await envA.store.claimRun(claimParams())
  await envA.store.close() // 优雅退出会释放锁

  // 模拟崩溃残留：host-a 的锁文件留下（进程被杀，没来得及释放），心跳停在 20s 前（> 15s TTL）
  const lockFile = path.join(env.stateDir, 'mixed-ownership.json')
  fs.writeFileSync(lockFile, JSON.stringify({ hostId: 'host-a', pid: 1234, startedAt: new Date().toISOString(), updatedAt: new Date(Date.now() - 20000).toISOString() }))

  const envB = makeEnv(t, { hostId: 'host-b', reuse: envA })
  await envB.store.open(envB.facility) // 接管
  assert.equal(envB.store.ownsOwnership(), true)
  assert.equal(envB.store.listRuns({}).items.length, 1)
  await envB.store.close()

  // 本宿主重开 = 续期，不冲突
  await envB.store.open(envB.facility)
  assert.equal(envB.store.ownsOwnership(), true)
  await envB.store.close()
})

// ---------- 损坏记录（T03 验收：坏记录不清空）----------

test('坏记录被备份隔离（字节保留 .bak），读作缺失，不当成空库', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  const { run } = await env.store.claimRun(claimParams())
  await env.store.updateRun(run.runId, (cur) => advanceRun(cur, { ownerKey: 'owner:aaaa', ownerEpoch: 0, to: 'planning' }))
  await env.store.close()

  // 把该 run 文档改成 schema 非法内容（版本戳合法、record 违反 zod）
  const recordFile = path.join(env.storageRoot, 'mixed', 'runs', `${run.runId}.json`)
  assert.ok(fs.existsSync(recordFile))
  fs.writeFileSync(recordFile, JSON.stringify({ version: mixedDomainSpec.version, record: { garbage: true } }) + '\n')

  const env2 = makeEnv(t, { reuse: env })
  await env2.store.open(env2.facility)
  assert.equal(await env2.store.getRun(run.runId), null) // 读作缺失
  assert.equal(env2.store.diagnostics().corruption.length, 1) // 备份文件在诊断里
  const bak = env2.store.diagnostics().corruption[0]
  assert.ok(bak.endsWith('.json.bak.') || bak.includes('.bak.'))
  assert.ok(fs.existsSync(bak)) // 字节保留磁盘，不清空
  // 正常记录仍在（不是空库）：领一条新的
  const p2 = claimParams({ sourceMessageId: 'msg-2' })
  const { created } = await env2.store.claimRun(p2)
  assert.equal(created, true)
  await env2.store.close()
})

// ---------- schemaVersion 升降级（旧版遇新版禁写）----------

test('medium 含更高版本戳文档 → 只读诊断 + 全部写拒绝（schema_too_new）', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  const { run } = await env.store.claimRun(claimParams())
  await env.store.close()

  // 模拟新宿主写的 v2 文档
  fs.mkdirSync(path.join(env.storageRoot, 'mixed', 'runs'), { recursive: true })
  fs.writeFileSync(
    path.join(env.storageRoot, 'mixed', 'runs', 'run-newerhost.json'),
    JSON.stringify({ version: mixedDomainSpec.version + 1, record: { runId: 'run-newerhost' } }) + '\n',
  )

  const env2 = makeEnv(t, { reuse: env })
  await env2.store.open(env2.facility)
  assert.equal(env2.store.writeLocked?.reason, 'schema_too_new')
  assert.equal(env2.store.healthy, false)
  // 读仍然可用
  assert.ok(await env2.store.getRun(run.runId))
  // 写全部拒绝（assertWritable 是同步抛错）
  assert.throws(() => env2.store.assertWritable(), (e) => e instanceof MixedError && e.code === 'schema_too_new')
  const p = claimParams({ sourceMessageId: 'msg-9' })
  await assert.rejects(env2.store.claimRun(p), (e) => e instanceof MixedError && e.code === 'schema_too_new')
  await assert.rejects(env2.store.setSessionMode({ sessionId: 's', ownerKey: 'o', ownerEpoch: 0, enabled: true }), (e) => e instanceof MixedError && e.code === 'schema_too_new')
  await env2.store.close()
})

test('global schemaVersion 高于支持版本 → 禁写（defense in depth）', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  await env.store.close()
  const globalFile = path.join(env.storageRoot, 'mixed', 'global.json')
  const doc = JSON.parse(fs.readFileSync(globalFile, 'utf8'))
  doc.record.schemaVersion = MIXED_SCHEMA_VERSION + 1
  fs.writeFileSync(globalFile, JSON.stringify(doc) + '\n')

  const env2 = makeEnv(t, { reuse: env })
  await env2.store.open(env2.facility)
  assert.equal(env2.store.writeLocked?.reason, 'schema_too_new')
  assert.throws(() => env2.store.assertWritable(), (e) => e instanceof MixedError && e.code === 'schema_too_new')
  await env2.store.close()
})

// ---------- 写失败 → 停止派发（T03：状态落盘失败时停止派发）----------

test('存储写失败 → healthy=false，后续所有写立即拒绝（停止派发）', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  // 故障注入：put 失败（模拟磁盘写失败）
  const realRuns = env.store.runs
  env.store.runs = new Proxy(realRuns, {
    get(target, key) {
      if (key === 'put') return async () => { throw new Error('ENOSPC: no space left on device') }
      const v = target[key]
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  await assert.rejects(env.store.claimRun(claimParams()), (e) => e instanceof MixedError && e.code === 'storage_unhealthy')
  assert.equal(env.store.healthy, false)
  // 后续写（含更新）立即拒绝，不再触碰介质
  await assert.rejects(env.store.claimRun(claimParams({ sourceMessageId: 'msg-2' })), (e) => e instanceof MixedError && e.code === 'storage_unhealthy')
  await assert.rejects(env.store.setSessionMode({ sessionId: 's', ownerKey: 'o', ownerEpoch: 0, enabled: true }), (e) => e instanceof MixedError && e.code === 'storage_unhealthy')
  await assert.rejects(env.store.savePreferences('owner:aaaa', { planner: MODELS.planner, executor: MODELS.executor, reviewer: MODELS.reviewer, ownerEpoch: 0 }), (e) => e instanceof MixedError && e.code === 'storage_unhealthy')
  // 读仍可用
  assert.equal(env.store.listRuns({}).items.length, 0)
  await env.store.close()
})

// ---------- 写挂起 → 有界失败（真内核环境回归：fs 层挂起曾致管道静默停摆 15+ 分钟）----------

test('存储写挂起（fs 层 hang）→ writeTimeoutMs 后 storage_write_timeout + 停写 + 带外降级标记，锁链不被卡死', async (t) => {
  const env = makeEnv(t, { writeTimeoutMs: 60 })
  await env.store.open(env.facility)
  const { run } = await env.store.claimRun(claimParams())
  // 故障注入：domain update 永不结算（模拟 writeAtomic 的写/fsync/rename 被文件系统层挂起）
  const realRuns = env.store.runs
  env.store.runs = new Proxy(realRuns, {
    get(target, key) {
      if (key === 'update') return () => new Promise(() => {}) // 永不 resolve
      const v = target[key]
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  const t0 = Date.now()
  await assert.rejects(
    env.store.updateRun(run.runId, (cur) => ({ ...cur, revision: cur.revision + 1 })),
    (e) => e instanceof MixedError && e.code === 'storage_write_timeout',
  )
  assert.ok(Date.now() - t0 >= 50, `超时应约在 writeTimeoutMs 触发（实际 ${Date.now() - t0}ms）`)
  assert.equal(env.store.healthy, false)
  assert.equal(env.store.writeLocked?.reason, 'write_timeout')
  // 带外降级标记：不经过挂起的写链，故障可见持久（v9/v10/v11 真内核复现的无声停摆必须可见）
  const marker = env.store.readDegradedMarker()
  assert.ok(marker, '挂起时应写入降级标记')
  assert.equal(marker.reason, 'write_timeout')
  assert.equal(marker.runId, run.runId)
  assert.equal(marker.hostId, 'host-a')
  assert.ok(fs.existsSync(path.join(env.stateDir, 'mixed-store-degraded.json')))
  // 后续所有写立即拒绝（不再触碰介质/挂起链）；锁链本身不卡死（立即抛错而非等待）
  await assert.rejects(env.store.updateRun(run.runId, (cur) => cur), (e) => e instanceof MixedError && e.code === 'storage_write_timeout')
  await assert.rejects(env.store.setSessionMode({ sessionId: 's', ownerKey: 'o', ownerEpoch: 0, enabled: true }), (e) => e instanceof MixedError && e.code === 'storage_write_timeout')
  await assert.rejects(env.store.savePreferences('owner:aaaa', { planner: MODELS.planner, executor: MODELS.executor, reviewer: MODELS.reviewer, ownerEpoch: 0 }), (e) => e instanceof MixedError && e.code === 'storage_write_timeout')
  // 读仍可用
  assert.equal(env.store.getRun(run.runId)?.status, 'queued')
  // getHealth 暴露降级状态（宿主 API/UI 消费）
  const h = env.store.getHealth()
  assert.equal(h.healthy, false)
  assert.equal(h.writeLocked.reason, 'write_timeout')
  assert.equal(h.degradation.reason, 'write_timeout')
  await env.store.close()
})

test('降级标记：新宿主首写成功即清除（陈旧故障不留）；同宿主标记保留', async (t) => {
  const env = makeEnv(t, { hostId: 'host-b' })
  await env.store.open(env.facility)
  // 伪造上一个宿主（host-a）留下的降级标记
  fs.writeFileSync(
    path.join(env.stateDir, 'mixed-store-degraded.json'),
    JSON.stringify({ at: '2026-09-09T18:00:00.000Z', hostId: 'host-a', reason: 'write_timeout', detail: 'lock=update:run-x 超过 30000ms', runId: 'run-x' }),
  )
  assert.ok(env.store.readDegradedMarker(), 'open 后标记仍可读（不清除——等首写证明恢复）')
  const { run } = await env.store.claimRun(claimParams())
  assert.equal(env.store.readDegradedMarker(), null, '首写成功后陈旧（他宿主）标记应被清除')
  // 同宿主故障 → 标记保留（当前活跃降级，不得误清）
  env.store.writeDegradedMarker({ reason: 'write_timeout', detail: 'test', runId: run.runId })
  const before = env.store.readDegradedMarker()
  assert.equal(before.hostId, 'host-b')
  await env.store.close()
})

// ---------- 崩溃窗口：attempt starting 已持久化（§4.3）----------

test('崩溃窗口：attempt 已落盘（无 childSessionId/endedAt）→ 重开仍在，结果未知不重放', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  const { run } = await env.store.claimRun(claimParams())
  await env.store.updateRun(run.runId, (cur) => advanceRun(cur, { ownerKey: 'owner:aaaa', ownerEpoch: 0, to: 'planning' }))
  const attempt = {
    attemptId: 'att_001',
    stage: 'planning',
    planVersion: 1,
    route: structuredClone(MODELS.planner),
    startedAt: new Date().toISOString(),
    unknown: true,
  }
  await env.store.updateRun(run.runId, (cur) => {
    const next = advanceRun(cur, { ownerKey: 'owner:aaaa', ownerEpoch: 0, event: { type: 'attempt_started', summary: 'planning 派发前落盘' }, patch: { attempts: [...cur.attempts, attempt] } })
    return next
  })
  // 宿主“死亡”：直接 close（不写 attempt 结束）
  await env.store.close()

  const env2 = makeEnv(t, { reuse: env })
  await env2.store.open(env2.facility)
  const after = await env2.store.getRun(run.runId)
  assert.equal(after.attempts.length, 1)
  assert.equal(after.attempts[0].attemptId, 'att_001')
  assert.equal(after.attempts[0].childSessionId, undefined)
  assert.equal(after.attempts[0].endedAt, undefined)
  assert.equal(after.attempts[0].unknown, true) // 恢复侧：结果未知，不自动重放
  await env2.store.close()
})

// ---------- 会话模式 / 偏好 ----------

test('会话模式：set/get/revision 冲突/跨 owner 隔离', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  const m1 = await env.store.setSessionMode({ sessionId: 'sess-1', ownerKey: 'owner:aaaa', ownerEpoch: 0, enabled: true })
  assert.equal(m1.revision, 1)
  const m2 = await env.store.setSessionMode({ sessionId: 'sess-1', ownerKey: 'owner:aaaa', ownerEpoch: 0, enabled: false, expectedRevision: 1 })
  assert.equal(m2.revision, 2)
  assert.equal(m2.enabled, false)
  await assert.rejects(
    env.store.setSessionMode({ sessionId: 'sess-1', ownerKey: 'owner:aaaa', ownerEpoch: 0, enabled: true, expectedRevision: 1 }),
    (e) => e instanceof MixedError && e.code === 'config_revision_conflict',
  )
  // 跨 owner 读视为未设置
  assert.equal(env.store.getSessionMode('sess-1', { ownerKey: 'owner:bbbb' }), null)
  assert.ok(env.store.getSessionMode('sess-1', { ownerKey: 'owner:aaaa' }))
  await env.store.close()
})

test('偏好：保存/读取/revision 冲突；ownerKey 路径安全化', async (t) => {
  const env = makeEnv(t)
  await env.store.open(env.facility)
  const p1 = await env.store.savePreferences('owner:aaaa', { planner: MODELS.planner, executor: MODELS.executor, reviewer: MODELS.reviewer, ownerEpoch: 0 })
  assert.equal(p1.revision, 1)
  const p2 = await env.store.savePreferences('owner:aaaa', { planner: MODELS.planner, executor: MODELS.executor, reviewer: MODELS.reviewer, ownerEpoch: 0, expectedRevision: 1 })
  assert.equal(p2.revision, 2)
  const got = env.store.getPreferences('owner:aaaa')
  assert.equal(got.planner.modelId, 'deepseek-v4-pro')
  assert.equal(env.store.getPreferences('owner:bbbb'), null)
  assert.equal(pathSafeKey('owner:aaaa'), 'owner-aaaa')
  await env.store.close()
})

// ---------- 计划图契约（T05 调度器复用）----------

test('validatePlanGraph：合法 DAG 通过；环/未知依赖/漏验收/超限全部拒绝', () => {
  const acc = [{ id: 'a1', description: '登录成功', checkable: true }, { id: 'a2', description: '测试通过', checkable: true }]
  const mk = (taskId, over = {}) => ({
    taskId, parentTaskId: undefined, dependsOnTaskIds: [], title: taskId, goal: 'g',
    inputRefs: [], expectedOutputs: [], pathScope: [], acceptanceIds: [], verificationHints: [],
    role: 'executor', status: 'pending', attemptIds: [], evidenceIds: [], ...over,
  })
  const ok = validatePlanGraph(
    [
      mk('t1', { acceptanceIds: ['a1'] }),
      mk('t2', { dependsOnTaskIds: ['t1'], acceptanceIds: ['a2'] }),
    ],
    acc,
  )
  assert.ok(ok.ok, ok.errors.join('; '))

  const cycle = validatePlanGraph([mk('t1', { dependsOnTaskIds: ['t2'], acceptanceIds: ['a1'] }), mk('t2', { dependsOnTaskIds: ['t1'], acceptanceIds: ['a2'] })], acc)
  assert.ok(!cycle.ok && cycle.errors.some((e) => e.includes('环')))

  const unknown = validatePlanGraph([mk('t1', { dependsOnTaskIds: ['ghost'], acceptanceIds: ['a1', 'a2'] })], acc)
  assert.ok(!unknown.ok && unknown.errors.some((e) => e.includes('未知')))

  const uncovered = validatePlanGraph([mk('t1', { acceptanceIds: ['a1'] })], acc)
  assert.ok(!uncovered.ok && uncovered.errors.some((e) => e.includes('a2')))

  const selfDep = validatePlanGraph([mk('t1', { dependsOnTaskIds: ['t1'], acceptanceIds: ['a1', 'a2'] })], acc)
  assert.ok(!selfDep.ok && selfDep.errors.some((e) => e.includes('自身')))

  const badPath = validatePlanGraph([mk('t1', { pathScope: ['../etc'], acceptanceIds: ['a1', 'a2'] })], acc)
  assert.ok(!badPath.ok && badPath.errors.some((e) => e.includes('路径')))

  const manyLeaves = validatePlanGraph(Array.from({ length: 17 }, (_, i) => mk(`t${i}`, { acceptanceIds: i === 0 ? ['a1', 'a2'] : [] })), acc)
  assert.ok(!manyLeaves.ok && manyLeaves.errors.some((e) => e.includes('叶子')))

  const deep = validatePlanGraph([
    mk('d1', { acceptanceIds: ['a1', 'a2'] }),
    mk('d2', { dependsOnTaskIds: ['d1'] }),
    mk('d3', { dependsOnTaskIds: ['d2'] }),
    mk('d4', { dependsOnTaskIds: ['d3'] }),
    mk('d5', { dependsOnTaskIds: ['d4'] }),
  ], acc)
  assert.ok(!deep.ok && deep.errors.some((e) => e.includes('层级')))
})

// ---------- 键派生稳定性 ----------

test('键派生：submissionKey/runId 稳定；owner 不同 → 键不同', () => {
  const base = { ownerKey: 'owner:aaaa', profileId: 'desk', sessionId: 'sess-1', sourceMessageId: 'msg-1' }
  assert.equal(submissionKeyOf(base), submissionKeyOf(base))
  assert.notEqual(submissionKeyOf(base), submissionKeyOf({ ...base, ownerKey: 'owner:bbbb' }))
  assert.notEqual(submissionKeyOf(base), submissionKeyOf({ ...base, sourceMessageId: 'msg-2' }))
  const k = submissionKeyOf(base)
  assert.equal(runIdOf(k), runIdOf(k))
  assert.ok(/^run-[a-f0-9]{20}$/.test(runIdOf(k)))
})
