/**
 * Mixed 审核准入（T06，计划 §4.5）：宿主侧 verdict 校验 + 审核专用证据接口。
 *
 * 宿主拒绝：不存在的 evidenceId/acceptanceId、缺失必验项、未验证项却整体 pass、
 * 过期/被作废证据、非法 verdict、manifest hash 不匹配、宿主验证失败却 pass、
 * 存在 blocking finding 却 pass。模型文字只算报告，宿主证据与校验是最终判定。
 */
import { MixedError, advanceRun, newId } from './contracts.js'
import { parseCommandLine, recordVerification, verificationPassed, gateExitCode, hostVerificationFailed, hashTree } from './evidence.js'

/**
 * 校验审核输出（宿主事实 vs 模型结论）。
 * @param {object} p
 * @param {object} p.run 最新 run 记录
 * @param {object} p.review 结构化审核输出（已 zod 解析）
 * @param {string} p.manifestHash 宿主当前证据清单 hash
 * @param {number} p.planVersion 当前 planVersion
 * @param {Map<string, number>} p.verificationExits 宿主验证命令 -> exitCode
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateReviewOutput({ run, review, manifestHash, planVersion, verificationExits }) {
  const errors = []
  const plan = run.planVersions.at(-1)
  if (!plan) return { ok: false, errors: ['run 无计划版本'] }

  // verdict / 版本 / manifest
  if (!['pass', 'changes_requested', 'blocked'].includes(review?.verdict)) {
    errors.push(`非法 verdict: ${String(review?.verdict)}`)
  }
  if (review?.planVersion !== planVersion) {
    errors.push(`planVersion 不匹配（宿主 ${planVersion}，审核 ${String(review?.planVersion)}）`)
  }
  if (review?.evidenceManifestHash !== manifestHash) {
    errors.push('evidenceManifestHash 与宿主清单不匹配（审核开始后证据已变化或使用了过期 hash）')
  }

  const evidenceById = new Map(run.evidence.map((e) => [e.evidenceId, e]))
  const taskIds = new Set(run.tasks.map((t) => t.taskId))
  const acceptanceIds = new Set(plan.acceptance.map((a) => a.id))

  // criteria：必验全覆盖、不重不漏、证据真实存在且未作废
  const seen = new Set()
  for (const c of review?.criteria ?? []) {
    if (!acceptanceIds.has(c.acceptanceId)) {
      errors.push(`未知 acceptanceId: ${c.acceptanceId}`)
      continue
    }
    if (seen.has(c.acceptanceId)) {
      errors.push(`重复验收项: ${c.acceptanceId}`)
      continue
    }
    seen.add(c.acceptanceId)
    const evs = c.evidenceIds ?? []
    for (const ev of evs) {
      const e = evidenceById.get(ev)
      if (!e) errors.push(`引用了不存在的 evidenceId: ${ev}`)
      else if (e.invalidated && c.status === 'pass') errors.push(`验收项 ${c.acceptanceId} 用已作废证据判 pass: ${ev}`)
    }
    if (c.status === 'pass' && evs.length === 0) {
      errors.push(`验收项 ${c.acceptanceId} 无证据判 pass（无证据不得 pass）`)
    }
  }
  for (const id of acceptanceIds) {
    if (!seen.has(id)) errors.push(`缺失必验验收项: ${id}`)
  }

  // findings：taskId/evidenceId 必须真实
  const blocking = []
  for (const f of review?.findings ?? []) {
    if (!f.taskIds?.length) errors.push(`finding ${f.findingId} 未指向任何任务`)
    for (const t of f.taskIds ?? []) {
      if (!taskIds.has(t)) errors.push(`finding ${f.findingId} 引用不存在任务: ${t}`)
    }
    for (const ev of f.evidenceIds ?? []) {
      if (!evidenceById.has(ev)) errors.push(`finding ${f.findingId} 引用不存在的 evidenceId: ${ev}`)
    }
    if (f.severity === 'blocking') blocking.push(f)
  }

  // pass 的硬门槛（模型自报不算证据）
  if (review?.verdict === 'pass') {
    if ((review.criteria ?? []).some((c) => c.status !== 'pass')) {
      errors.push('存在未通过/未验证验收项，不得整体 pass')
    }
    if (blocking.length) {
      errors.push(`存在 ${blocking.length} 个 blocking finding，不得整体 pass`)
    }
    const failed = hostVerificationFailed(verificationExits)
    if (failed.length) {
      errors.push(`宿主验证有失败命令（${failed.map(([c, code]) => `${c} exit=${code}`).join('；')}），不得 pass（模型自报不是测试证据）`)
    }
  }

  return { ok: errors.length === 0, errors }
}

/**
 * 审核专用证据接口（受控：只接受 evidenceId/计划内命令；路径经 realpath 边界复查）。
 * 宿主把它挂到审核子会话（T07 装配时经 scoped pre-step/toolFilter 注册）。
 */
export function createEvidenceTools({ collector, store, runId, workspaceRoot, signal }) {
  return {
    /** 证据清单（摘要）。 */
    listEvidence() {
      const run = store.getRun(runId)
      return run.evidence.map((e) => ({
        evidenceId: e.evidenceId,
        type: e.type,
        producer: e.producer,
        taskId: e.taskId ?? null,
        planVersion: e.planVersion ?? null,
        fingerprint: e.fingerprint.slice(0, 12),
        size: e.size ?? null,
        truncated: e.truncated,
        invalidated: e.invalidated,
      }))
    },

    /** 按 evidenceId 读证据（record/stdout/stderr；长文件分片）。 */
    readEvidence(evidenceId, opts) {
      return collector.readEvidence(runId, evidenceId, opts)
    },

    /** 受控再验证：只允许计划 verificationMethods 内的命令（宿主实际执行）。 */
    async runVerification(commandLine) {
      const run = store.getRun(runId)
      const plan = run.planVersions.at(-1)
      const allowed = plan?.verificationMethods ?? []
      if (!allowed.includes(commandLine)) {
        throw new MixedError('evidence_invalid', `未授权的验证命令（必须来自计划 verificationMethods）: ${commandLine}`)
      }
      const parsed = parseCommandLine(commandLine)
      const dir = collector.dirFor(runId)
      const wsRoot = workspaceRoot ?? run.workspace.canonicalPath
      const preFingerprint = hashTree(wsRoot).fingerprint
      const rec = await recordVerification({
        evidenceDir: dir,
        cwd: wsRoot,
        command: parsed.command,
        args: parsed.args,
        signal,
        logger: collector.logger,
      })
      const exits = collector.verificationExits.get(runId) ?? new Map()
      exits.set(commandLine, gateExitCode(rec))
      collector.verificationExits.set(runId, exits)
      await store.updateRun(runId, (cur) => {
        const evidenceId = newId('ev')
        return advanceRun(cur, {
          ownerKey: cur.ownerKey,
          ownerEpoch: cur.ownerEpoch,
          event: {
            type: 'evidence_added',
            summary: `审核再验证 \`${commandLine}\`：exit=${rec.exitCode ?? 'spawn-error'}（${verificationPassed(rec) ? '通过' : '失败'}）`,
          },
          patch: {
            evidence: [
              ...cur.evidence,
              {
                evidenceId,
                producer: 'reviewer',
                type: 'verification',
                producedAt: new Date().toISOString(),
                planVersion: plan?.version,
                fingerprint: preFingerprint,
                size: 0,
                ref: rec.id,
                truncated: false,
                invalidated: false,
              },
            ],
          },
        })
      })
      return { exitCode: rec.exitCode, passed: verificationPassed(rec), stdoutRef: rec.stdoutRef, stderrRef: rec.stderrRef }
    },
  }
}
