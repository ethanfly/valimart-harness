/**
 * Mixed 可靠存储（T03）：DSH storageDomain 'mixed' domain + 单宿主所有权 + 每 run 领取锁。
 *
 * 依据计划 §6.3（存储）与 §4（数据契约）：
 * - run 内 tasks/attempts/revision/eventSeq 同一记录条件更新（KvTable.update 写链原子）；
 * - 同一存储目录单宿主写入：独占所有权文件（心跳 + 失活接管），不能靠 Electron 单实例锁推断；
 * - 首次领取 = 独占宿主 + 每 run 锁内 get→缺则 put（KvTable.update 对缺失键报错，不能直接 update）；
 * - 保存 revision 检查预期值，失配 409（contracts.advanceRun）；存储写失败 → healthy=false 停止派发；
 * - per-record 布局 + invalidRecords: backup-and-skip：单条坏记录被移走备份（字节保留磁盘）并跳过，
 *   不当成空库；.bak 文件在 open 时扫描进诊断；
 * - 旧版遇新版运行记录禁写并提示升级：medium 级版本扫描（per-record 对未接受版本戳静默读作
 *   缺失，不报错）——发现 version 更高的文档 → 只读诊断 + 全部写操作拒绝；
 * - 索引是可重建投影（内存，open 时从 runs 表重建），不是领取的唯一依据。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  MixedError,
  MIXED_SCHEMA_VERSION,
  runRecordSchema,
  sessionModeSchema,
  mixedPreferencesSchema,
  storeGlobalSchema,
  newRunRecord,
  lastReviewSummaryOf,
} from './contracts.js'

export const mixedDomainSpec = defineDomain({
  name: 'mixed',
  version: 1,
  layout: 'per-record',
  /** 损坏记录：备份隔离（<key>.json.bak.<stamp>，字节保留）并跳过，不是空库。 */
  invalidRecords: 'backup-and-skip',
  global: {
    schema: storeGlobalSchema,
    initial: {
      schemaVersion: MIXED_SCHEMA_VERSION,
      ownerKey: null,
      ownerEpoch: 0,
      hostId: null,
      updatedAt: '1970-01-01T00:00:00.000Z',
    },
  },
  tables: {
    runs: domainTable(runRecordSchema),
    session_modes: domainTable(sessionModeSchema),
    /** 每个 owner 一份偏好（三角色快照），key = 路径安全化的 ownerKey。 */
    preferences: domainTable(mixedPreferencesSchema),
  },
})

/** 存储 key 必须匹配 /^[a-zA-Z0-9_-]+$/（内核 assertSafeKey）：'owner:hex' → 'owner-hex'。 */
export function pathSafeKey(key) {
  const safe = String(key).replace(/[^a-zA-Z0-9_-]/g, '-')
  if (!safe) throw new Error(`无法生成路径安全 key: ${key}`)
  return safe
}

/**
 * @param {object} opts
 * @param {string} opts.stateDir 本机状态目录（所有权文件位置，= $DSH_HOME/desk）。
 * @param {string} [opts.storageRoot] 内核 storage-json 后端根（= $DSH_HOME/storages）。
 *        缺省从 stateDir 推导（dirname(stateDir)/storages）；显式传入优先。
 * @param {string} [opts.hostId] 宿主实例 id（默认随机；测试可注入固定值）。
 * @param {number} [opts.ownershipTtlMs] 所有权失活判定（默认 15s = 3 次心跳未更新）。
 * @param {number} [opts.writeTimeoutMs] 单写超时兜底（默认 30s；超时 → healthy=false + storage_write_timeout）。
@param {object} [opts.logger] {info,warn,error}。
 */
export class MixedStore {
  #staleMarkerChecked = false
  constructor({ stateDir, storageRoot, hostId = crypto.randomUUID(), ownershipTtlMs = 15000, writeTimeoutMs = 30_000, logger = console } = {}) {
    if (!stateDir) throw new Error('MixedStore 需要 stateDir')
    this.stateDir = stateDir
    this.storageRoot = storageRoot ?? path.join(path.dirname(stateDir), 'storages')
    this.hostId = hostId
    this.ownershipTtlMs = ownershipTtlMs
    // 单写超时兜底（§6.3 韧性）：底层 writeAtomic（tmp 写/fsync/rename）若被文件系统层
    // 挂起（实测真内核环境曾出现：run 停在 attempt_ended 后 15+ 分钟无任何事件，事件循环存活），
    // 无界挂起会让整条写链与运行管道静默停摆。超时 → healthy=false 停止派发 + 明确
    // storage_write_timeout 上抛：有界失败 + 可见状态，优于无声永挂（恢复需宿主重启）。
    this.writeTimeoutMs = writeTimeoutMs
    this.logger = logger
    this.ownershipFile = path.join(stateDir, 'mixed-ownership.json')
    this.unitDir = path.join(this.storageRoot, 'mixed')
    this.domain = null
    this.runs = null
    this.session_modes = null
    this.preferences = null
    this.global = null
    this.index = new Map() // runId → 投影（可重建）
    this.lockChains = new Map() // 锁键 → 串行链（每 run/领取/模式 锁）
    this.healthy = false
    this.writeLocked = null // {reason, detail}
    this.#staleMarkerChecked = false
    this.corruption = [] // 已备份隔离的坏记录文件（open 时扫描 .bak）
    this.openedAt = null
  }

  // ---------- 所有权（单宿主写入，§6.3）----------

  #readOwnership() {
    try {
      return JSON.parse(fs.readFileSync(this.ownershipFile, 'utf8'))
    } catch {
      return null
    }
  }

  #writeOwnership(entry) {
    fs.mkdirSync(this.stateDir, { recursive: true })
    const tmp = `${this.ownershipFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(entry, null, 2))
    fs.renameSync(tmp, this.ownershipFile)
  }

  /**
   * 获取独占所有权：无主 → 取得；本宿主 → 续期；他宿主且未失活 → ownership_conflict；
   * 他宿主已失活（心跳超时，视为崩溃宿主）→ 接管。
   */
  async acquireOwnership() {
    const now = Date.now()
    const cur = this.#readOwnership()
    if (cur && cur.hostId === this.hostId) {
      this.#writeOwnership({ ...cur, updatedAt: new Date(now).toISOString() })
      return
    }
    if (cur && cur.hostId !== this.hostId) {
      const age = now - Date.parse(cur.updatedAt ?? '')
      if (Number.isFinite(age) && age < this.ownershipTtlMs) {
        throw new MixedError(
          'ownership_conflict',
          `存储目录由宿主 ${cur.hostId}（pid ${cur.pid ?? '?'}）独占，最近心跳 ${Math.round(age)}ms 前`,
        )
      }
      this.logger.warn?.(`mixed 存储所有权接管：旧宿主 ${cur.hostId} 心跳 ${Math.round(age)}ms 未更新（判定失活）`)
    }
    this.#writeOwnership({ hostId: this.hostId, pid: process.pid, startedAt: new Date().toISOString(), updatedAt: new Date(now).toISOString() })
  }

  /** 心跳：刷新所有权 updatedAt（宿主运行时周期调用）。 */
  heartbeat() {
    if (!this.ownsOwnership()) return false
    const cur = this.#readOwnership()
    this.#writeOwnership({ hostId: this.hostId, pid: process.pid, startedAt: cur?.startedAt, updatedAt: new Date().toISOString() })
    return true
  }

  ownsOwnership() {
    const cur = this.#readOwnership()
    return !!cur && cur.hostId === this.hostId
  }

  /** 释放所有权（只删自己的锁）。 */
  releaseOwnership() {
    if (this.ownsOwnership()) {
      try { fs.unlinkSync(this.ownershipFile) } catch { /* 已不存在 */ }
    }
  }

  // ---------- 生命周期 ----------

  /**
   * @param {object} storageDomain DomainFacility（宿主内 = ctx.storageDomain；测试 = 真实 facility 实例）
   */
  async open(storageDomain) {
    await this.acquireOwnership()
    let domain
    try {
      domain = await storageDomain.open(mixedDomainSpec)
    } catch (error) {
      this.releaseOwnership()
      if (error?.code === 'version-mismatch' || error?.code === 'malformed-medium') {
        // 整单元介质问题（版本不符/文件坏）：保留原文件，只读诊断，禁写。
        this.writeLocked = { reason: error.code === 'version-mismatch' ? 'schema_too_new' : 'storage_corrupted', detail: String(error.message) }
        this.openedAt = new Date().toISOString()
        this.logger.warn?.(`mixed 存储介质诊断（只读禁写）: ${String(error.message)}`)
        return
      }
      throw this.#wrapStorageError(error, 'open')
    }
    this.domain = domain
    this.runs = this.domain.table('runs')
    this.session_modes = this.domain.table('session_modes')
    this.preferences = this.domain.table('preferences')
    this.global = this.domain.global
    this.corruption = this.#scanBackedUpRecords()

    // 旧版遇新版运行记录禁写并提示升级（§6.3）：per-record 对未接受版本戳静默读作缺失，
    // 不报错——所以必须 medium 级扫描版本戳，防止旧宿主覆盖新版数据。
    const newer = this.#scanNewerVersions()
    if (newer > 0) {
      this.writeLocked = { reason: 'schema_too_new', detail: `存储含 ${newer} 个高于本宿主版本（v${mixedDomainSpec.version}）的文档` }
      this.logger.warn?.(`mixed 存储禁写：发现 ${newer} 个更新版本的文档，请升级宿主`)
    }

    // schemaVersion 规则（defense in depth）：global 记录级版本。
    const g = this.global.get()
    if (g.schemaVersion > MIXED_SCHEMA_VERSION && !this.writeLocked) {
      this.writeLocked = { reason: 'schema_too_new', stored: g.schemaVersion, supported: MIXED_SCHEMA_VERSION }
    } else if (g.schemaVersion < MIXED_SCHEMA_VERSION && !this.writeLocked) {
      this.global.set({ ...g, schemaVersion: MIXED_SCHEMA_VERSION, updatedAt: new Date().toISOString() })
    }
    if (!this.writeLocked) {
      this.global.set({ ...this.global.get(), hostId: this.hostId, updatedAt: new Date().toISOString() })
    }
    this.rebuildIndex()
    this.healthy = !this.writeLocked
    this.openedAt = new Date().toISOString()
  }

  async close() {
    const d = this.domain
    this.domain = null
    this.healthy = false
    this.index.clear()
    this.lockChains.clear()
    // 关闭时若处于写故障态且尚无标记（如非超时路径判 unhealthy）→ 补写，故障不留无声
    if (this.writeLocked && this.writeLocked.reason !== 'schema_too_new' && !this.readDegradedMarker()) {
      this.writeDegradedMarker({ reason: this.writeLocked.reason, detail: this.writeLocked.detail ?? 'close 时发现 unhealthy' })
    }
    if (d) {
      // 有界关闭：写链挂起时 domain close 的 inFlight drain 会无限等待 → 宿主关停不得被拖死
      // （挂起的底层写随进程退出自行消失；降级标记已持久故障事实）
      let settled = false
      await Promise.race([
        d.close().then(() => { settled = true }).catch(() => { settled = true }),
        new Promise((resolve) => setTimeout(resolve, 3_000).unref?.()),
      ])
      if (!settled) this.logger.warn?.('mixed 存储 domain close 超时（3s，写链挂起中）：跳过 drain 继续关停')
    }
    this.releaseOwnership()
  }

  diagnostics() {
    const cur = this.#readOwnership()
    return {
      hostId: this.hostId,
      openedAt: this.openedAt,
      healthy: this.healthy,
      writeLocked: this.writeLocked,
      degradation: this.readDegradedMarker(),
      corruption: this.corruption,
      ownership: cur ? { hostId: cur.hostId, pid: cur.pid, updatedAt: cur.updatedAt, ours: cur.hostId === this.hostId } : null,
      runCount: this.index.size,
    }
  }

  // ---------- 降级标记（带外，§6.3 韧性）----------
  // 存储写链挂起/写失败时，run 的 blocked 收敛本身也要走写链 → 无法落盘（v9/v10/v11 真内核
  // 复现：管道冻结在 reviewing，磁盘无任何故障痕迹）。降级标记走与所有权心跳相同的
  // 直接同步 fs 通道（心跳在写链挂起期间持续落盘，证明该通道独立可用）：故障可见、持久、
  // 可诊断（重启后对账读取并记录），不依赖挂起的写链。

  #degradedMarkerPath() {
    return path.join(this.stateDir, 'mixed-store-degraded.json')
  }

  readDegradedMarker() {
    try {
      const j = JSON.parse(fs.readFileSync(this.#degradedMarkerPath(), 'utf8'))
      return { at: j.at ?? null, hostId: j.hostId ?? null, reason: j.reason ?? null, detail: j.detail ?? null, runId: j.runId ?? null }
    } catch {
      return null
    }
  }

  /** 同步写（不 await 任何存储链）：调用方保证在故障路径上；失败仅 warn，绝不抛。 */
  writeDegradedMarker({ reason, detail, runId = null }) {
    try {
      const p = this.#degradedMarkerPath()
      const tmp = `${p}.tmp`
      fs.mkdirSync(this.stateDir, { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify({
        at: new Date().toISOString(),
        hostId: this.hostId,
        reason,
        detail: String(detail ?? '').slice(0, 500),
        runId,
      }, null, 2))
      fs.renameSync(tmp, p)
      return true
    } catch (error) {
      this.logger.warn?.(`mixed 降级标记写入失败（故障本身可能更严重）: ${String(error?.message ?? error)}`)
      return false
    }
  }

  /** 健康恢复（宿主重启后首次写成功）时清除。 */
  clearDegradedMarker() {
    try {
      fs.rmSync(this.#degradedMarkerPath(), { force: true })
    } catch { /* 不存在即已清除 */ }
  }

  getHealth() {
    return {
      healthy: this.healthy,
      writeLocked: this.writeLocked,
      degradation: this.readDegradedMarker(),
    }
  }

  /** 派发前调用：不可写（存储故障/schema 过新/介质坏/未打开）立即抛错，宿主据此停止派发。 */
  assertWritable() {
    if (this.writeLocked) {
      const code = this.writeLocked.reason === 'schema_too_new' ? 'schema_too_new'
        : this.writeLocked.reason === 'write_timeout' ? 'storage_write_timeout'
        : 'storage_corrupted'
      throw new MixedError(code, `存储禁写：${this.writeLocked.reason}`)
    }
    if (!this.domain) throw new MixedError('storage_unhealthy', 'mixed 存储未打开')
    if (!this.healthy) throw new MixedError('storage_unhealthy', 'mixed 存储写失败，已停止派发')
  }

  // ---------- medium 诊断扫描 ----------

  /** 已备份隔离的坏记录（backup-and-skip 产物），字节保留磁盘。 */
  #scanBackedUpRecords() {
    const out = []
    const walk = (dir) => {
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.includes('.json.bak.')) out.push(p) // 备份名 <key>.json.bak.<YYYYMMDDHHmm>
      }
    }
    walk(this.unitDir)
    return out
  }

  /** 版本戳高于 spec 的文档数（旧宿主检测新宿主数据）。 */
  #scanNewerVersions() {
    let n = 0
    const walk = (dir) => {
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.json')) {
          try {
            const doc = JSON.parse(fs.readFileSync(p, 'utf8'))
            if (typeof doc?.version === 'number' && doc.version > mixedDomainSpec.version) n++
          } catch { /* 非 JSON = 外部文件，unit 层按缺失处理 */ }
        }
      }
    }
    walk(this.unitDir)
    return n
  }

  // ---------- 索引（可重建投影，不是领取依据）----------

  rebuildIndex() {
    const idx = new Map()
    for (const [runId, record] of this.runs.entries()) {
      idx.set(runId, this.#indexOf(record))
    }
    this.index = idx
  }

  #indexOf(record) {
    return {
      runId: record.runId,
      ownerKey: record.ownerKey,
      sessionId: record.sessionId,
      status: record.status,
      revision: record.revision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      // 列表摘要需要的展示字段（终态横幅/额度卡片）：行内直接带，避免每行 getRun 全量克隆
      goal: record.goal,
      error: record.error ? { code: record.error.code, detail: record.error.detail ?? null } : null,
      pendingResume: record.pendingResume ?? null,
      usage: record.usage ?? null,
      tasks: (record.tasks ?? []).map((t) => ({ taskId: t.taskId, title: t.title, status: t.status })),
      lastReview: lastReviewSummaryOf(record),
    }
  }

  /**
   * 每键串行锁 + 单写超时兜底：底层 fs（writeAtomic 的写/fsync/rename）若被文件系统层挂起，
   * 无界等待会静默卡死整条写链与运行管道（真内核环境实测：review attempt_ended 后 15+ 分钟
   * 无后续事件、事件循环存活）。超时 → healthy=false（assertWritable 拦截后续写）+
   * storage_write_timeout 上抛（run 依 MixedError 收敛 blocked，状态可见）。
   * 注意：超时不取消底层写（fs 不可取消）——迟到的写会在后台自行了结并更新内存记录；
   * 但 healthy=false 后宿主不再派发新写，恢复需宿主重启。
   */
  #withLock(key, fn) {
    const prev = this.lockChains.get(key) ?? Promise.resolve()
    const work = prev.then(fn)
    const runIdMatch = /^update:(run-[0-9a-f]+)$/.exec(key)
    let timer = null
    const guard = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        this.healthy = false
        this.writeLocked = { reason: 'write_timeout', detail: `lock=${key} 超过 ${this.writeTimeoutMs}ms` }
        this.logger.error?.(`mixed 存储写超时: lock=${key} 超过 ${this.writeTimeoutMs}ms（文件系统层挂起？判 unhealthy 停止派发；恢复需宿主重启）`)
        // 带外降级标记：写链挂起时 blocked 收敛无法落盘，故障必须经独立通道可见（心跳同机制）
        this.writeDegradedMarker({ reason: 'write_timeout', detail: `lock=${key} 超过 ${this.writeTimeoutMs}ms`, runId: runIdMatch?.[1] ?? null })
        reject(new MixedError('storage_write_timeout', `mixed 存储写超时（lock ${key} 超过 ${this.writeTimeoutMs}ms）：存储判 unhealthy`, { cause: new Error('mixed storage write timeout') }))
      }, this.writeTimeoutMs)
      timer.unref?.()
    })
    const result = Promise.race([work, guard])
    result.then(
      () => { if (timer) clearTimeout(timer) },
      () => { if (timer) clearTimeout(timer) },
    )
    this.lockChains.set(key, result.then(() => undefined, () => undefined))
    return result
  }

  #wrapStorageError(error, op, runId = null) {
    if (error instanceof MixedError) {
      if (error.code === 'storage_write_timeout' || error.code === 'storage_unhealthy') {
        this.writeDegradedMarker({ reason: error.code, detail: String(error.message ?? error).slice(0, 300), runId })
      }
      return error
    }
    // 记录校验失败 = 本进程数据形状 bug，不是存储故障。两个来源：
    // (a) contracts.advanceRun 内 runRecordSchema.parse(next) 抛原始 ZodError（v9–v12 真实事故：
    //     审核回填写 shape 不符 → ZodError → 旧代码误判 storage_unhealthy → 其后所有写被
    //     assertWritable 拒绝 → run 冻结在 reviewing）；
    // (b) domain 层 DomainError('invalid-record')（open/load 或未来写路径校验）。
    // 现在：如实报数据错误上抛——run 控制器据此收敛 blocked（存储仍 healthy，收敛写能落盘），
    // 可恢复重试；降级标记留给真正的存储故障（I/O 挂起/介质错误）。
    if ((error?.name === 'DomainError' && error?.code === 'invalid-record') || error?.name === 'ZodError' || Array.isArray(error?.issues)) {
      let detail = String(error)
      try {
        const issues = Array.isArray(error.issues) ? error.issues : (Array.isArray(error.detail?.issues) ? error.detail.issues : null)
        if (issues) detail = JSON.stringify(issues)
        else if (error.detail) detail = JSON.stringify(error.detail)
      } catch { /* 保留 String 形态 */ }
      this.logger.error?.(`mixed 存储 ${op} 记录校验失败（数据形状问题，存储健康）: ${detail.slice(0, 400)}`)
      return new MixedError('record_validation_failed', `mixed 存储 ${op} 记录不符合 schema（数据形状问题，存储健康）: ${detail.slice(0, 300)}`, { cause: error })
    }
    this.healthy = false
    this.logger.error?.(`mixed 存储 ${op} 失败: ${String(error)}`)
    this.writeDegradedMarker({ reason: `write_${op}_failed`, detail: String(error).slice(0, 300), runId })
    return new MixedError('storage_unhealthy', `mixed 存储 ${op} 失败: ${String(error)}`, { cause: error })
  }

  /** 成功写入一次后调用（每进程一次）：清掉别的宿主留下的降级标记（写恢复 = 故障已过时）。 */
  #maybeClearStaleMarker() {
    if (this.#staleMarkerChecked) return
    this.#staleMarkerChecked = true
    const m = this.readDegradedMarker()
    if (m?.hostId && m.hostId !== this.hostId) {
      this.clearDegradedMarker()
      this.logger.warn?.(`mixed 清除陈旧降级标记（host ${m.hostId}，${m.at}，${m.reason}）：本宿主写已成功，存储恢复`)
    }
  }

  // ---------- 领取（T03 验收：重复领取一条消息只有一个 run）----------

  /**
   * 首次 get+put 领取（独占宿主 + 每 run 锁内）；已领取 → 返回已认领 run（created=false）。
   * 重复消息/页面重连/pre-step 重试经同一 submissionKey → 同一 runId → 返回既有 run。
   * 返回深拷贝，外部不可改坏存储内状态。
   */
  async claimRun(params) {
    this.assertWritable()
    const { runId } = params
    return this.#withLock(`claim:${runId}`, async () => {
      const existing = this.runs.get(runId)
      if (existing) {
        if (existing.submissionKey !== params.submissionKey) {
          throw new MixedError('owner_mismatch', `runId 已被不同 submissionKey 占用（键派生异常）`)
        }
        return { run: structuredClone(existing), created: false }
      }
      const record = newRunRecord(params)
      await this.#putRun(record)
      return { run: structuredClone(record), created: true }
    })
  }

  async #putRun(record) {
    try {
      await this.runs.put(record.runId, record)
    } catch (error) {
      throw this.#wrapStorageError(error, 'claim', record.runId)
    }
    this.index.set(record.runId, this.#indexOf(record))
    this.#maybeClearStaleMarker()
  }

  // ---------- 读取（内存投影同步读：KvTable.get 是同步的，读不触碰介质）----------

  getRun(runId, { ownerKey } = {}) {
    if (!this.runs) return null
    const record = this.runs.get(runId)
    if (!record) return null
    if (ownerKey && record.ownerKey !== ownerKey) {
      throw new MixedError('owner_mismatch', `run ${runId} 不属于当前 owner`)
    }
    return structuredClone(record)
  }

  /** 分页列出（按 createdAt 倒序）。cursor = offset（数字或数字字符串）。 */
  listRuns({ ownerKey, sessionId, limit = 50, cursor = 0 } = {}) {
    if (!this.runs) return { items: [], nextCursor: null }
    let rows = [...this.index.values()]
    if (ownerKey) rows = rows.filter((r) => r.ownerKey === ownerKey)
    if (sessionId) rows = rows.filter((r) => r.sessionId === sessionId)
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : (a.runId < b.runId ? 1 : -1)))
    const from = Number(cursor) || 0
    const slice = rows.slice(from, from + limit)
    return {
      items: slice,
      nextCursor: from + limit < rows.length ? from + limit : null,
    }
  }

  // ---------- 单 run 原子条件更新 ----------

  /**
   * 在 domain 写链内执行 mutator(current) → next（或抛 MixedError 中止，不落盘）。
   * mutator 应是纯状态推进（见 contracts.advanceRun）；写失败 → healthy=false（停止派发）。
   */
  async updateRun(runId, mutator) {
    this.assertWritable()
    return this.#withLock(`update:${runId}`, async () => {
      try {
        const next = await this.runs.update(runId, (current) => mutator(current))
        this.index.set(runId, this.#indexOf(next))
        this.#maybeClearStaleMarker()
        return structuredClone(next)
      } catch (error) {
        if (error?.code === 'missing-key') throw new MixedError('run_not_found', `run ${runId} 不存在`)
        if (error instanceof MixedError) throw error
        throw this.#wrapStorageError(error, 'update', runId)
      }
    })
  }

  // ---------- 会话模式（普通/Mixed 互斥）----------

  getSessionMode(sessionId, { ownerKey } = {}) {
    if (!this.session_modes) return null
    const record = this.session_modes.get(sessionId)
    if (!record) return null
    if (ownerKey && record.ownerKey !== ownerKey) return null // 跨 owner 视为未设置
    return structuredClone(record)
  }

  async setSessionMode({ sessionId, ownerKey, ownerEpoch, enabled, expectedRevision }) {
    this.assertWritable()
    return this.#withLock(`mode:${sessionId}`, async () => {
      const cur = this.session_modes.get(sessionId)
      const t = new Date().toISOString()
      if (!cur) {
        const record = { sessionId, ownerKey, ownerEpoch, enabled, revision: 1, updatedAt: t }
        try { await this.session_modes.put(sessionId, record) } catch (error) { throw this.#wrapStorageError(error, 'sessionMode') }
        return structuredClone(record)
      }
      if (cur.ownerKey !== ownerKey) return structuredClone(cur) // 他人 owner 的模式不动
      if (typeof expectedRevision === 'number' && cur.revision !== expectedRevision) {
        throw new MixedError('config_revision_conflict', `会话模式 revision=${cur.revision} 与预期 ${expectedRevision} 不符`)
      }
      try {
        const next = await this.session_modes.update(sessionId, (c) => ({ ...c, ownerEpoch, enabled, revision: c.revision + 1, updatedAt: t }))
        return structuredClone(next)
      } catch (error) {
        throw this.#wrapStorageError(error, 'sessionMode')
      }
    })
  }

  // ---------- owner 身份（epoch 栅栏持久化，§6.1/T02）----------

  /** 读取已持久化的 owner 身份（{ownerKey, ownerEpoch}）。未登录/首次 → {ownerKey:null, ownerEpoch:0}。 */
  getOwnerIdentity() {
    const g = this.global?.get?.()
    return { ownerKey: g?.ownerKey ?? null, ownerEpoch: g?.ownerEpoch ?? 0 }
  }

  /** 持久化 owner 身份（账号变化 fence 时 epoch+1；同宿主单写，global 表原子 set）。 */
  setOwnerIdentity({ ownerKey, ownerEpoch }) {
    const g = this.global?.get?.()
    if (!g) return
    this.global.set({ ...g, ownerKey, ownerEpoch, updatedAt: new Date().toISOString() })
  }

  // ---------- 偏好（三角色快照，key = 路径安全化 ownerKey）----------

  getPreferences(ownerKey) {
    if (!this.preferences) return null
    const record = this.preferences.get(pathSafeKey(ownerKey))
    return record ? structuredClone(record) : null
  }

  async savePreferences(ownerKey, { planner, executor, reviewer, ownerEpoch, expectedRevision }) {
    this.assertWritable()
    const key = pathSafeKey(ownerKey)
    return this.#withLock(`prefs:${key}`, async () => {
      const cur = this.preferences.get(key)
      const t = new Date().toISOString()
      const body = { schemaVersion: 1, ownerKey, ownerEpoch, planner, executor, reviewer, updatedAt: t }
      if (!cur) {
        const record = { ...body, revision: 1 }
        try { await this.preferences.put(key, record) } catch (error) { throw this.#wrapStorageError(error, 'preferences') }
        return structuredClone(record)
      }
      if (typeof expectedRevision === 'number' && cur.revision !== expectedRevision) {
        throw new MixedError('config_revision_conflict', `偏好 revision=${cur.revision} 与预期 ${expectedRevision} 不符`)
      }
      try {
        const next = await this.preferences.update(key, (c) => ({ ...structuredClone(c), ...structuredClone(body), revision: c.revision + 1 }))
        return structuredClone(next)
      } catch (error) {
        throw this.#wrapStorageError(error, 'preferences')
      }
    })
  }
}

export { runRecordSchema, mixedPreferencesSchema, sessionModeSchema, storeGlobalSchema }
