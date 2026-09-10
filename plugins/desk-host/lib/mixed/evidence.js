/**
 * Mixed 宿主证据（T06，计划 §4.4）：
 * - 运行前工作区基线：Git 项目保留已有 staged/unstaged/untracked（不能只拿 git diff HEAD
 *   把用户原有修改算作本轮成果）；非 Git 记产物清单 + 内容 hash。
 * - 实施后产物清单：对基线做内容级 diff（added/modified/deleted），二进制验证存在/大小。
 * - 验证：宿主实际执行测试进程，记录 command/args/cwd、退出码、起止时间、stdout/stderr
 *   文件与 hash。模型文字「测试通过」只算报告，不算测试证据。
 * - evidence manifest：run.evidence 的稳定序列化 + sha256；审核结论必须带回同一 hash。
 * - 时效：验证绑定输入树指纹（内容级，不只时间戳）；测试后代码/依赖/配置变化 → 证据作废。
 * - 受控读取：证据只落在本机受管状态目录（<storageRoot>/mixed-evidence/<runId>）；
 *   解析符号链接/junction 后再次验证访问边界，不允许任意路径读取。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { MixedError, advanceRun, newId } from './contracts.js'

const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
/** 容错版：文件不存在（流尚未落盘/被清理）返回 null，不让宿主崩。 */
const safeHashFile = (p) => {
  try {
    return sha256File(p)
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'EBADF') return null
    throw e
  }
}

/** 验证输入树指纹：排序 `rel\u0000sha256\u0000size` 行（内容级；mtime 不入指纹）。 */
export function hashTree(root, { maxFiles = 50000 } = {}) {
  const lines = []
  let files = 0
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (ent.name === '.git') continue
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(p)
        continue
      }
      if (!ent.isFile()) continue
      if (files >= maxFiles) return
      let st
      try {
        st = fs.statSync(p)
      } catch {
        continue
      }
      lines.push(`${path.relative(root, p)}\u0000${sha256File(p)}\u0000${st.size}`)
      files++
    }
  }
  walk(root)
  lines.sort()
  return { files, fingerprint: sha256Hex(lines.join('\n')) }
}

/** 受控路径解析：realpath 后必须仍在 root 内（防符号链接/junction 逃逸）。 */
export function resolveSafePath(root, rel) {
  const rootReal = fs.realpathSync(root)
  const joined = path.resolve(rootReal, String(rel ?? ''))
  let real
  try {
    real = fs.realpathSync(joined)
  } catch {
    throw new MixedError('evidence_invalid', `证据路径不存在或不可访问: ${rel}`)
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new MixedError('evidence_invalid', `证据路径解析后越界（符号链接/junction）: ${rel}`)
  }
  return real
}

function gitProbe(cwd, args) {
  try {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30000 })
    if (r.status !== 0) return null
    return (r.stdout ?? '').split(/\r?\n/).map((s) => s.trimEnd()).filter(Boolean)
  } catch {
    return null
  }
}

/**
 * 工作区基线。
 * git 工作区：head + 现有 porcelain 状态（用户已有修改原样保留，不算本轮成果）。
 * 非 git：全量内容清单。
 */
export function collectBaseline(root) {
  const head = gitProbe(root, ['rev-parse', 'HEAD'])?.[0] ?? null
  const status = head ? (gitProbe(root, ['status', '--porcelain=v1']) ?? []) : []
  const manifest = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (ent.name === '.git') continue
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(p)
        continue
      }
      if (!ent.isFile()) continue
      let st
      try {
        st = fs.statSync(p)
      } catch {
        continue
      }
      manifest.push({ rel: path.relative(root, p), hash: sha256File(p), size: st.size })
    }
  }
  walk(root)
  manifest.sort((a, b) => (a.rel < b.rel ? -1 : 1))
  return { git: !!head, head, status, manifest, manifestFingerprint: sha256Hex(manifest.map((m) => `${m.rel}\u0000${m.hash}`).join('\n')) }
}

/** 基线 → 当前 的内容级 diff（git 工作区排除用户基线内既有且未再变化的修改）。 */
export function diffAgainstBaseline(baseline, root) {
  const baseMap = new Map(baseline.manifest.map((m) => [m.rel, m]))
  const now = hashTree(root)
  const curMap = new Map()
  // 重新收集当前 manifest（hashTree 只有指纹，diff 需要逐文件）
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (ent.name === '.git') continue
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(p)
        continue
      }
      if (!ent.isFile()) continue
      let st
      try {
        st = fs.statSync(p)
      } catch {
        continue
      }
      curMap.set(path.relative(root, p), { hash: sha256File(p), size: st.size })
    }
  }
  walk(root)

  const diff = []
  const seen = new Set()
  for (const [rel, cur] of curMap) {
    seen.add(rel)
    const base = baseMap.get(rel)
    if (!base) diff.push({ rel, status: 'added', hash: cur.hash, size: cur.size })
    else if (base.hash !== cur.hash) diff.push({ rel, status: 'modified', hash: cur.hash, size: cur.size })
  }
  for (const rel of baseMap.keys()) {
    if (!seen.has(rel)) diff.push({ rel, status: 'deleted', hash: null, size: 0 })
  }
  diff.sort((a, b) => (a.rel < b.rel ? -1 : 1))

  if (baseline.git) {
    // 用户基线内既有修改（本轮未再变化的部分）不算本轮成果：
    // 只有基线 status 中已有、且当前内容 hash 与基线 manifest 相同的条目才排除；
    // 基线已有但内容又变了 → 保留（本轮继续修改了用户文件）。
    const baseStatusPaths = new Set(
      baseline.status.map((line) => line.slice(3).replace(/^"(.*)"$/, '$1').replace(/ => .*$/, '')),
    )
    const kept = diff.filter((d) => {
      if (d.status === 'added') return true // 新文件：无论 git 是否跟踪
      if (d.status === 'modified' && baseStatusPaths.has(d.rel)) {
        // 基线时已修改：若当前 hash 与基线时相同 → 不是本轮改动
        const base = baseMap.get(d.rel)
        return base ? base.hash !== d.hash : true
      }
      return true
    })
    return { diff: kept, tree: { files: now.files, fingerprint: now.fingerprint }, git: true }
  }
  return { diff, tree: { files: now.files, fingerprint: now.fingerprint }, git: false }
}

/** 解析命令行为 [command, ...args]（受控验证不用 shell）。 */
export function parseCommandLine(line) {
  const s = String(line).trim()
  if (!s) throw new MixedError('evidence_invalid', '验证命令为空')
  const parts = []
  let cur = ''
  let quote = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\' && i + 1 < s.length) {
        const n = s[i + 1]
        if (n === quote || n === '\\') {
          cur += n
          i++
          continue
        }
        cur += c
        continue
      }
      if (c === quote) {
        quote = null
        continue
      }
      cur += c
      continue
    }
    if ((c === '"' || c === "'") && cur === '') {
      quote = c
      continue
    }
    if (/\s/.test(c)) {
      if (cur) {
        parts.push(cur)
        cur = ''
      }
      continue
    }
    cur += c
  }
  if (quote) throw new MixedError('evidence_invalid', '验证命令引号未闭合')
  if (cur) parts.push(cur)
  if (!parts.length) throw new MixedError('evidence_invalid', '验证命令为空')
  return { command: parts[0], args: parts.slice(1) }
}

/**
 * 受控验证：宿主实际执行测试进程，stdout/stderr 落盘并记 hash。
 * 返回验证记录（raw 进证据目录；ref 指向验证记录 JSON）。
 */
export function recordVerification({ evidenceDir, cwd, command, args = [], timeoutMs = 300000, signal, logger = console }) {
  const id = newId('ver')
  fs.mkdirSync(evidenceDir, { recursive: true })
  const stdoutFile = path.join(evidenceDir, `${id}.stdout.log`)
  const stderrFile = path.join(evidenceDir, `${id}.stderr.log`)
  const recFile = path.join(evidenceDir, `${id}.json`)
  const startedAt = new Date().toISOString()
  logger.info?.(`[mixed-evidence] 验证 ${command} ${args.join(' ')}`)
  const MAX_LOG = 16 * 1024 * 1024 // 单流软上限，防超大输出撑爆内存
  const push = (buf, d) => (buf.length >= MAX_LOG ? buf : Buffer.concat([buf, d]))
  return new Promise((resolve) => {
    let child
    let spawnError = null
    try {
      child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      fs.writeFileSync(stdoutFile, '')
      fs.writeFileSync(stderrFile, '')
      const rec = { id, command, args, cwd, exitCode: null, spawnError: String(error?.message ?? error), startedAt, endedAt: new Date().toISOString(), stdoutRef: `${id}.stdout.log`, stderrRef: `${id}.stderr.log`, stdoutHash: safeHashFile(stdoutFile), stderrHash: safeHashFile(stderrFile) }
      fs.writeFileSync(recFile, JSON.stringify(rec, null, 2))
      resolve(rec)
      return
    }
    let outBuf = Buffer.alloc(0)
    let errBuf = Buffer.alloc(0)
    // 缓冲 + close 时同步落盘：规避「spawn 立即失败（命令不存在）→ close 先于写流异步 open →
    // readFileSync ENOENT 崩宿主」的竞态；也避免流 flush 竞态导致 hash 读半截文件。
    child.stdout.on('data', (d) => { outBuf = push(outBuf, d) })
    child.stderr.on('data', (d) => { errBuf = push(errBuf, d) })
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch { /* 已退出 */ }
    }, timeoutMs)
    const onAbort = () => {
      try {
        child.kill('SIGTERM')
      } catch { /* 已退出 */ }
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    child.on('error', (e) => {
      // spawn 失败（ENOENT 等，如把自然语言当命令）：记 spawnError，以 exitCode null 判失败
      spawnError = String(e?.message ?? e)
    })
    child.on('close', (code, signalName) => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      // 同步写盘后再 hash：文件此刻必存在，无 ENOENT / 无半截
      fs.writeFileSync(stdoutFile, outBuf)
      fs.writeFileSync(stderrFile, errBuf)
      const rec = {
        id,
        command,
        args,
        cwd,
        exitCode: code,
        killedBy: signalName,
        spawnError,
        startedAt,
        endedAt: new Date().toISOString(),
        stdoutRef: `${id}.stdout.log`,
        stderrRef: `${id}.stderr.log`,
        stdoutHash: safeHashFile(stdoutFile),
        stderrHash: safeHashFile(stderrFile),
      }
      fs.writeFileSync(recFile, JSON.stringify(rec, null, 2))
      resolve(rec)
    })
  })
}

/** 验证命令的成败判定：exit 0 = 通过。 */
export function verificationPassed(rec) {
  return rec?.spawnError == null && rec?.exitCode === 0
}

/** 进 pass 门槛的退出码：进程没启动（PowerShell cmdlet / 自然语言）不算测试失败。 */
export function gateExitCode(rec) {
  if (rec?.spawnError) return null
  return typeof rec?.exitCode === 'number' ? rec.exitCode : null
}

/** 只有真正跑起来且非 0 的验证才拦整体 pass。 */
export function hostVerificationFailed(exits) {
  return [...(exits ?? [])].filter(([, code]) => typeof code === 'number' && code !== 0)
}

/**
 * 证据收集器：证据落 <storageRoot>/mixed-evidence/<runId>/，引用追加进 run.evidence。
 */
export class EvidenceCollector {
  constructor({ storageRoot, store, logger = console }) {
    this.root = path.join(storageRoot, 'mixed-evidence')
    this.store = store
    this.logger = logger
    this.verificationExits = new Map() // runId -> Map(command -> exitCode)（内存投影；审计以磁盘记录为准）
  }

  dirFor(runId) {
    const dir = path.join(this.root, runId)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  #append(store, run, rec) {
    const runId = run.runId
    const evidenceId = newId('ev')
    const dir = this.dirFor(runId)
    const ref = rec.ref
    if (rec.raw != null) {
      fs.writeFileSync(path.join(dir, `${ref}.json`), JSON.stringify(rec.raw, null, 2))
    }
    const record = {
      evidenceId,
      producer: rec.producer,
      type: rec.type,
      producedAt: new Date().toISOString(),
      ...(rec.taskId ? { taskId: rec.taskId } : {}),
      ...(rec.attemptId ? { attemptId: rec.attemptId } : {}),
      ...(rec.planVersion ? { planVersion: rec.planVersion } : {}),
      fingerprint: rec.fingerprint,
      ...(rec.size != null ? { size: rec.size } : {}),
      ref,
      truncated: rec.truncated ?? false,
      invalidated: false,
    }
    return store.updateRun(runId, (cur) =>
      advanceRun(cur, {
        ownerKey: cur.ownerKey,
        ownerEpoch: cur.ownerEpoch,
        event: { type: 'evidence_added', summary: rec.eventSummary ?? `${rec.type} ${evidenceId}` },
        patch: { evidence: [...cur.evidence, record] },
      }),
    ).then(() => record)
  }

  /** 运行前基线（executing 之前采集）。 */
  async collectBaseline(store, run) {
    const root = run.workspace.canonicalPath
    const baseline = collectBaseline(root)
    const dir = this.dirFor(run.runId)
    const ref = 'baseline/baseline.json'
    fs.mkdirSync(path.join(dir, 'baseline'), { recursive: true })
    fs.writeFileSync(path.join(dir, ref), JSON.stringify(baseline, null, 2))
    await this.#append(store, run, {
      producer: 'host',
      type: 'baseline',
      fingerprint: baseline.manifestFingerprint,
      ref,
      size: baseline.manifest.length,
      eventSummary: `工作区基线（git=${baseline.git}${baseline.git ? `, head=${String(baseline.head).slice(0, 8)}` : ''}，已有状态 ${baseline.status.length} 条）`,
    })
    return baseline
  }

  /** 实施后：产物清单 + 宿主验证（实际执行测试进程）。 */
  async collectAfterExecution({ store, run, baseline, plan, workspaceRoot, signal, verificationMethods }) {
    const root = workspaceRoot ?? run.workspace.canonicalPath
    const dir = this.dirFor(run.runId)
    const planVersion = plan?.version ?? run.planVersions.at(-1)?.version ?? 1

    // 1) 产物清单（对基线内容级 diff）
    const { diff, tree } = diffAgainstBaseline(baseline, root)
    const added = diff.filter((d) => d.status === 'added').length
    const modified = diff.filter((d) => d.status === 'modified').length
    const deleted = diff.filter((d) => d.status === 'deleted').length
    fs.mkdirSync(dir, { recursive: true })
    const artifactRef = 'execution/artifacts.json'
    fs.mkdirSync(path.join(dir, 'execution'), { recursive: true })
    fs.writeFileSync(path.join(dir, artifactRef), JSON.stringify({ tree, diff, collectedAt: new Date().toISOString() }, null, 2))
    await this.#append(store, run, {
      producer: 'host',
      type: 'file-manifest',
      planVersion,
      fingerprint: tree.fingerprint,
      ref: artifactRef,
      size: diff.length,
      eventSummary: `产物清单：新增 ${added} / 修改 ${modified} / 删除 ${deleted}（指纹 ${tree.fingerprint.slice(0, 12)}…）`,
    })

    // 2) 验证（命令来自计划 verificationMethods；宿主实际执行）
    const methods = verificationMethods ?? plan?.verificationMethods ?? []
    const results = []
    const exits = this.verificationExits.get(run.runId) ?? new Map()
    this.verificationExits.set(run.runId, exits)
    for (const line of methods) {
      const parsed = parseCommandLine(line)
      const preFingerprint = hashTree(root).fingerprint // 绑定验证输入树指纹
      const rec = await recordVerification({ evidenceDir: dir, cwd: root, command: parsed.command, args: parsed.args, signal, logger: this.logger })
      exits.set(line, gateExitCode(rec))
      const passed = verificationPassed(rec)
      await this.#append(store, run, {
        producer: 'host',
        type: 'verification',
        planVersion,
        fingerprint: preFingerprint,
        ref: rec.id,
        size: rec.stdoutHash ? fs.statSync(path.join(dir, rec.stdoutRef)).size + fs.statSync(path.join(dir, rec.stderrRef)).size : 0,
        eventSummary: `验证 \`${line}\`：exit=${rec.exitCode ?? 'spawn-error'}（${passed ? '通过' : '失败'}）`,
      })
      results.push({ command: line, passed, exitCode: rec.exitCode })
    }
    return { diff, tree, verifications: results }
  }

  /** 稳定序列化 manifest（审核结论必须带回同一 hash）。 */
  #manifestItems(run) {
    return [...run.evidence]
      .sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : 1))
      .map((e) => ({
        evidenceId: e.evidenceId,
        type: e.type,
        producer: e.producer,
        taskId: e.taskId ?? null,
        planVersion: e.planVersion ?? null,
        fingerprint: e.fingerprint,
        size: e.size ?? null,
        ref: e.ref,
        truncated: e.truncated,
        invalidated: e.invalidated,
      }))
  }

  manifest(run) {
    return JSON.stringify({ v: 1, items: this.#manifestItems(run) })
  }

  manifestHash(run) {
    return sha256Hex(JSON.stringify({ v: 1, items: this.#manifestItems(run) }))
  }

  /** 输入树变化后：指纹不再匹配的验证证据作废（不只时间戳——内容级指纹）。 */
  async invalidateStale(store, run, currentFingerprint) {
    const cur = store.getRun(run.runId)
    const staleCount = cur.evidence.filter((e) => e.type === 'verification' && !e.invalidated && e.fingerprint !== currentFingerprint).length
    if (!staleCount) return 0
    await store.updateRun(run.runId, (c) =>
      advanceRun(c, {
        ownerKey: c.ownerKey,
        ownerEpoch: c.ownerEpoch,
        event: { type: 'evidence_invalidated', summary: `输入树变化，${staleCount} 条验证证据作废（重跑验证）` },
        patch: {
          evidence: c.evidence.map((e) =>
            e.type === 'verification' && !e.invalidated && e.fingerprint !== currentFingerprint ? { ...e, invalidated: true } : e,
          ),
        },
      }),
    )
    return staleCount
  }

  /** 该 run 的宿主验证 exit 投影（command -> exitCode）。 */
  verificationExitsOf(runId) {
    return new Map(this.verificationExits.get(runId) ?? [])
  }

  /** 受控证据读取（审核专用接口；只接受 evidenceId，路径经 realpath 边界复查）。 */
  readEvidence(runId, evidenceId, { kind = 'record', offset = 0, limit = 8000 } = {}) {
    const run = this.store.getRun(runId)
    const ev = run.evidence.find((e) => e.evidenceId === evidenceId)
    if (!ev) throw new MixedError('evidence_invalid', `证据不存在: ${evidenceId}`)
    const dir = this.dirFor(runId)
    let file
    if (ev.type !== 'verification' && kind !== 'record') {
      throw new MixedError('evidence_invalid', `${ev.type} 证据只有 record 内容（无 ${kind} 日志）`)
    }
    if (ev.type === 'verification' && (kind === 'stdout' || kind === 'stderr')) {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, `${ev.ref}.json`), 'utf8'))
      const rel = kind === 'stdout' ? rec.stdoutRef : rec.stderrRef
      if (!rel) throw new MixedError('evidence_invalid', `该验证无 ${kind} 日志`)
      file = path.join(dir, rel)
    } else if (ev.type === 'verification') {
      file = path.join(dir, `${ev.ref}.json`)
    } else {
      file = path.join(dir, ev.ref)
    }
    const safe = resolveSafePath(dir, path.relative(dir, file))
    const size = fs.statSync(safe).size
    const buf = Buffer.alloc(Math.min(limit, size))
    const fd = fs.openSync(safe, 'r')
    try {
      fs.readSync(fd, buf, 0, buf.length, offset)
    } finally {
      fs.closeSync(fd)
    }
    return {
      evidenceId: evidenceId,
      kind,
      offset,
      size,
      truncated: offset + buf.length < size,
      content: buf.toString('utf8'),
      invalidated: ev.invalidated,
    }
  }
}
