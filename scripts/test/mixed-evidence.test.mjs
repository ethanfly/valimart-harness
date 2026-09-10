// T06 证据层单测：基线 / 产物清单 / 受控验证 / manifest / 时效作废 / 受控读取（计划 §4.4）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  hashTree,
  resolveSafePath,
  collectBaseline,
  diffAgainstBaseline,
  recordVerification,
  verificationPassed,
  gateExitCode,
  hostVerificationFailed,
  EvidenceCollector,
  parseCommandLine,
} from '../../plugins/desk-host/lib/mixed/evidence.js'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MixedStore } from '../../plugins/desk-host/lib/mixed/store.js'
import { MixedError, advanceRun, submissionKeyOf, runIdOf } from '../../plugins/desk-host/lib/mixed/contracts.js'

const OWNER = { ownerKey: 'owner:aaaa', ownerEpoch: 0 }
const MODELS = {
  planner: { catalogProvider: 'deepseek', modelId: 'deepseek-v4-pro', runtimeModelId: 'deepseek-v4-pro', capabilities: { planner: true, executor: true, reviewer: true }, capabilitiesRevision: 'rev-abc123' },
  executor: { catalogProvider: 'xai', modelId: 'grok-4.6', runtimeModelId: 'grok-4.6', capabilities: { planner: false, executor: true, reviewer: true }, capabilitiesRevision: 'rev-abc123' },
  reviewer: { catalogProvider: 'deepseek', modelId: 'deepseek-v4-flash', runtimeModelId: 'deepseek-v4-flash', capabilities: { planner: false, executor: false, reviewer: true }, capabilitiesRevision: 'rev-abc123' },
}

async function claimRun(store, { messageId = 'msg-ev', text = '证据测试', workspace = 'E:\\ws' } = {}) {
  const submissionKey = submissionKeyOf({ ownerKey: OWNER.ownerKey, profileId: 'desk', sessionId: 'sess-ev', sourceMessageId: messageId })
  const runId = runIdOf(submissionKey)
  const { run } = await store.claimRun({
    runId,
    ownerKey: OWNER.ownerKey,
    ownerEpoch: 0,
    profileId: 'desk',
    sessionId: 'sess-ev',
    sourceMessageId: messageId,
    submissionKey,
    workspace: { canonicalPath: workspace, baselineId: 'b-ev' },
    models: structuredClone(MODELS),
    policy: { maxRepairRounds: 2, maxReplans: 1 },
    goal: text,
    inputRefs: [{ kind: 'text', messageId, text }],
  })
  return run
}

function tmpdir(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

function git(cwd, ...args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

function makeGitRepo(root, files) {
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@local')
  git(root, 'config', 'user.name', 'test')
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  git(root, 'add', '-A')
  const r = git(root, 'commit', '-m', 'init')
  if (r.status !== 0) throw new Error(`git commit failed: ${r.stderr}`)
}

test('hashTree：内容级指纹（内容变 → 指纹变；仅 mtime 变 → 指纹不变）', (t) => {
  const ws = tmpdir(t, 'mixed-ev-tree-')
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello')
  const f1 = hashTree(ws).fingerprint
  // 只改 mtime，内容不变
  const p = path.join(ws, 'a.txt')
  const future = new Date(Date.now() + 60000)
  fs.utimesSync(p, future, future)
  const f2 = hashTree(ws).fingerprint
  assert.equal(f2, f1, 'mtime 变化不影响内容指纹')
  // 内容变
  fs.writeFileSync(p, 'hello!')
  const f3 = hashTree(ws).fingerprint
  assert.notEqual(f3, f1, '内容变化必须改变指纹')
})

test('resolveSafePath：边界内可解析；.. 逃逸与 junction 逃逸被拒', (t) => {
  const ws = tmpdir(t, 'mixed-ev-safe-')
  fs.writeFileSync(path.join(ws, 'ok.txt'), 'x')
  const outside = tmpdir(t, 'mixed-ev-outside-')
  const secret = path.join(outside, 'secret.txt')
  fs.writeFileSync(secret, 'secret')

  assert.ok(fs.existsSync(resolveSafePath(ws, 'ok.txt')))
  assert.throws(() => resolveSafePath(ws, '..\\..\\evil.txt'), (e) => e instanceof MixedError && e.code === 'evidence_invalid')
  assert.throws(() => resolveSafePath(ws, 'missing.txt'), (e) => e instanceof MixedError && e.code === 'evidence_invalid')

  // Windows junction（不需要管理员权限）指向工作区外 → realpath 后越界
  if (process.platform === 'win32') {
    fs.symlinkSync(outside, path.join(ws, 'link'), 'junction')
    assert.throws(() => resolveSafePath(ws, 'link\\secret.txt'), (e) => e instanceof MixedError && e.code === 'evidence_invalid')
  }
})

test('collectBaseline：非 Git 记清单；Git 保留已有 staged/unstaged/untracked 状态', (t) => {
  const ws = tmpdir(t, 'mixed-ev-base-')
  fs.writeFileSync(path.join(ws, 'a.txt'), 'A')
  const base1 = collectBaseline(ws)
  assert.equal(base1.git, false)
  assert.equal(base1.manifest.length, 1)
  assert.equal(base1.manifest[0].rel, 'a.txt')
  assert.ok(base1.manifest[0].hash.length === 64)

  const gws = tmpdir(t, 'mixed-ev-git-')
  makeGitRepo(gws, { 'tracked.txt': 'T' })
  // 用户既有修改（未提交）+ 未跟踪文件
  fs.writeFileSync(path.join(gws, 'tracked.txt'), 'T-modified')
  fs.writeFileSync(path.join(gws, 'untracked.txt'), 'U')
  const base2 = collectBaseline(gws)
  assert.equal(base2.git, true)
  assert.ok(base2.head, 'git 工作区记录 HEAD')
  const joined = base2.status.join('\n')
  assert.match(joined, /tracked\.txt/, '保留用户已有 unstaged 修改')
  assert.match(joined, /untracked\.txt/, '保留 untracked 状态')
})

test('A27：非 Git 文档与二进制按内容 hash，改一字节指纹变、只改 mtime 不变', (t) => {
  const ws = tmpdir(t, 'mixed-ev-a27-')
  fs.writeFileSync(path.join(ws, 'GUIDE.md'), '# 说明\n')
  fs.writeFileSync(path.join(ws, 'icon.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]))
  const base = collectBaseline(ws)
  assert.equal(base.git, false)
  assert.equal(base.manifest.length, 2)
  const md = base.manifest.find((m) => m.rel === 'GUIDE.md')
  const bin = base.manifest.find((m) => m.rel === 'icon.bin')
  assert.equal(md.hash.length, 64)
  assert.equal(bin.hash.length, 64)
  const fp1 = hashTree(ws).fingerprint
  const icon = path.join(ws, 'icon.bin')
  const future = new Date(Date.now() + 60_000)
  fs.utimesSync(icon, future, future)
  assert.equal(hashTree(ws).fingerprint, fp1, '二进制仅 mtime 变不影响指纹')
  const buf = Buffer.from(fs.readFileSync(icon))
  buf[7] = 9
  fs.writeFileSync(icon, buf)
  assert.notEqual(hashTree(ws).fingerprint, fp1, '二进制改一字节必须变指纹')
  fs.writeFileSync(path.join(ws, 'GUIDE.md'), '# 说明改\n')
  const { diff } = diffAgainstBaseline(base, ws)
  const by = Object.fromEntries(diff.map((d) => [d.rel, d.status]))
  assert.equal(by['GUIDE.md'], 'modified')
  assert.equal(by['icon.bin'], 'modified')
})

test('diffAgainstBaseline（非 Git）：added/modified/deleted 内容级识别', (t) => {
  const ws = tmpdir(t, 'mixed-ev-diff-')
  fs.writeFileSync(path.join(ws, 'a.txt'), 'A')
  fs.writeFileSync(path.join(ws, 'b.txt'), 'B')
  const base = collectBaseline(ws)
  fs.writeFileSync(path.join(ws, 'a.txt'), 'A2')
  fs.rmSync(path.join(ws, 'b.txt'))
  fs.writeFileSync(path.join(ws, 'c.txt'), 'C')
  const { diff } = diffAgainstBaseline(base, ws)
  const by = Object.fromEntries(diff.map((d) => [d.rel, d.status]))
  assert.deepEqual(by, { 'a.txt': 'modified', 'b.txt': 'deleted', 'c.txt': 'added' })
})

test('diffAgainstBaseline（Git）：用户基线内既有修改不算本轮成果；本轮再改才算', (t) => {
  const ws = tmpdir(t, 'mixed-ev-gdiff-')
  makeGitRepo(ws, { 'clean.txt': 'C', 'dirty.txt': 'D' })
  // 用户既有未提交修改（本轮之前）
  fs.writeFileSync(path.join(ws, 'dirty.txt'), 'D-user')
  const base = collectBaseline(ws)
  assert.match(base.status.join('\n'), /dirty\.txt/)

  // 场景 1：本轮只改 clean.txt，dirty.txt 保持用户原样 → dirty 不算本轮成果
  fs.writeFileSync(path.join(ws, 'clean.txt'), 'C2')
  let { diff } = diffAgainstBaseline(base, ws)
  let rels = diff.map((d) => d.rel)
  assert.ok(rels.includes('clean.txt'), '本轮修改计入')
  assert.ok(!rels.includes('dirty.txt'), '用户既有且未再变化的修改不计入本轮成果')

  // 场景 2：本轮又改了 dirty.txt → 计入
  fs.writeFileSync(path.join(ws, 'dirty.txt'), 'D-again')
  ;({ diff } = diffAgainstBaseline(base, ws))
  assert.ok(diff.some((d) => d.rel === 'dirty.txt' && d.status === 'modified'), '本轮再改用户文件 → 计入')
})

test('recordVerification：宿主实际执行，退出码/stdout/stderr 落盘并记 hash', async (t) => {
  const ws = tmpdir(t, 'mixed-ev-ver-')
  const dir = tmpdir(t, 'mixed-ev-vedir-')

  const ok = await recordVerification({ evidenceDir: dir, cwd: ws, command: 'node', args: ['-e', 'console.log("hello-stdout")'] })
  assert.equal(ok.exitCode, 0)
  assert.ok(verificationPassed(ok))
  assert.ok(fs.existsSync(path.join(dir, ok.stdoutRef)))
  assert.match(fs.readFileSync(path.join(dir, ok.stdoutRef), 'utf8'), /hello-stdout/)
  assert.equal(ok.stdoutHash.length, 64)
  assert.ok(fs.existsSync(path.join(dir, `${ok.id}.json`)), '验证记录 JSON 落盘')

  const bad = await recordVerification({ evidenceDir: dir, cwd: ws, command: 'node', args: ['-e', 'console.error("boom"); process.exit(3)'] })
  assert.equal(bad.exitCode, 3)
  assert.ok(!verificationPassed(bad))
  assert.match(fs.readFileSync(path.join(dir, bad.stderrRef), 'utf8'), /boom/)

  fs.writeFileSync(path.join(ws, 't12-notes.txt'), 'hello-t12\n')
  const parsed = parseCommandLine(`node -e "const fs=require('fs'); process.exit(fs.existsSync('t12-notes.txt')&&fs.statSync('t12-notes.txt').isFile()?0:1)"`)
  const quoted = await recordVerification({ evidenceDir: dir, cwd: ws, command: parsed.command, args: parsed.args })
  assert.equal(quoted.exitCode, 0, '带空格的 quoted node -e 必须真正跑通，不能被拆碎后 exit=1')
  assert.ok(verificationPassed(quoted))

  const contentLine = parseCommandLine(`node -e "const s=require('fs').readFileSync('t12-notes.txt','utf8');process.exit((s==='hello-t12'||s==='hello-t12\\n')?0:1)"`)
  const content = await recordVerification({ evidenceDir: dir, cwd: ws, command: contentLine.command, args: contentLine.args })
  assert.equal(content.exitCode, 0, '内容比对里的 \\\\n 必须留给 node 解释成换行，不能变成 hello-t12n')
  assert.ok(verificationPassed(content))
})

test('recordVerification：spawn 立即失败（命令不存在/自然语言伪命令）→ 不崩宿主，记 spawnError 且判失败', async (t) => {
  // 回归：e2e 真内核 run 中 planner 产出自然语言「验证命令」，spawn 立即失败，
  // close 先于日志文件创建 → 旧实现 readFileSync 命中 ENOENT 未捕获，整个宿主进程崩溃
  const ws = tmpdir(t, 'mixed-ev-verfail-')
  const dir = tmpdir(t, 'mixed-ev-verfaildir-')
  const cmd = process.platform === 'win32' ? '不存在的命令：检查文件' : 'definitely-not-a-real-cmd-xyz'
  const rec = await recordVerification({ evidenceDir: dir, cwd: ws, command: cmd, args: [] })
  // Windows：CreateProcess 失败可能表现为 error 事件（exitCode null + spawnError），
  // 也可能立即以非零码退出（如 -4058）；两种都必须判失败且不崩
  assert.ok(rec.exitCode === null || rec.exitCode !== 0, '不得判为成功退出')
  if (rec.exitCode === null) assert.ok(rec.spawnError, 'spawn error 必须记录')
  assert.ok(!verificationPassed(rec), '必须判失败（fail-closed）')
  assert.ok(fs.existsSync(path.join(dir, rec.stdoutRef)), 'stdout 日志存在（空文件）')
  assert.ok(fs.existsSync(path.join(dir, rec.stderrRef)), 'stderr 日志存在（空文件）')
  assert.ok(fs.existsSync(path.join(dir, `${rec.id}.json`)), '验证记录 JSON 落盘')
  assert.equal(gateExitCode(rec), null, '未启动不得进入 pass 门槛')
  assert.deepEqual(hostVerificationFailed(new Map([['Test-Path foo 确认存在', gateExitCode(rec)]])), [])
})

test('parseCommandLine：拆 command/args，拒绝空命令', () => {
  assert.deepEqual(parseCommandLine('node --test scripts/t.mjs'), { command: 'node', args: ['--test', 'scripts/t.mjs'] })
  assert.deepEqual(
    parseCommandLine(`node -e "const fs=require('fs'); process.exit(fs.existsSync('a.txt')?0:1)"`),
    { command: 'node', args: ['-e', "const fs=require('fs'); process.exit(fs.existsSync('a.txt')?0:1)"] },
    '双引号包住的 -e 脚本含空格时必须是单个 argv，不能按空白拆碎',
  )
  assert.deepEqual(
    parseCommandLine('node -e console.log("hello-stdout")'),
    { command: 'node', args: ['-e', 'console.log("hello-stdout")'] },
    'token 中间的引号是字面量，不能当分组',
  )
  assert.deepEqual(
    parseCommandLine(`node -e "process.exit((s==='hello-t12'||s==='hello-t12\\n')?0:1)"`),
    { command: 'node', args: ['-e', "process.exit((s==='hello-t12'||s==='hello-t12\\n')?0:1)"] },
    'JS 源码里的 \\n 必须原样留给 node -e，不能吃掉反斜杠',
  )
  assert.throws(() => parseCommandLine('   '), (e) => e instanceof MixedError)
  assert.throws(() => parseCommandLine('node -e "const x=1'), (e) => e instanceof MixedError)
})

test('EvidenceCollector：基线 → 产物清单 → 验证证据 → manifest 稳定 hash → 时效作废 → 受控读取', async (t) => {
  const root = tmpdir(t, 'mixed-ev-col-')
  const stateDir = path.join(root, 'desk')
  const storageRoot = path.join(root, 'storages')
  const backend = new JsonStorageBackend(storageRoot)
  const facilityCtx = {
    storage: { backend: { get: (n) => (n === 'json' ? backend : undefined) } },
    logger: { warn: () => {}, error: () => {} },
    emit: () => {},
  }
  const facility = new DomainFacility(facilityCtx, { backend: 'json', routes: {} })
  const store = new MixedStore({ stateDir, storageRoot, hostId: 'host-ev', ownershipTtlMs: 15000, logger: { warn: () => {}, error: () => {} } })
  await store.open(facility)

  const ws = tmpdir(t, 'mixed-ev-col-ws-')
  const collector = new EvidenceCollector({ storageRoot: root, store, logger: { info: () => {}, warn: () => {}, error: () => {} } })
  const run = await claimRun(store, { workspace: ws })

  // 1) 基线
  fs.writeFileSync(path.join(ws, 'base.txt'), 'B')
  const baseline = await collector.collectBaseline(store, run)
  assert.equal(baseline.git, false)
  assert.equal(store.getRun(run.runId).evidence.length, 1)
  assert.equal(store.getRun(run.runId).evidence[0].type, 'baseline')

  // 2) 实施后：产物清单 + 验证（宿主实际执行检查脚本）
  fs.writeFileSync(path.join(ws, 'base.txt'), 'B2')
  fs.writeFileSync(path.join(ws, 'new.txt'), 'N')
  fs.writeFileSync(path.join(ws, 'check.mjs'), 'import assert from "node:assert"; assert.equal(1, 1); console.log("checks passed")')
  const plan = { version: 1, verificationMethods: ['node check.mjs'] }
  const after = await collector.collectAfterExecution({ store, run, baseline, plan, workspaceRoot: ws })
  assert.equal(after.diff.length, 3, 'base.txt modified + new.txt added + check.mjs added')
  assert.equal(after.verifications.length, 1)
  assert.equal(after.verifications[0].passed, true)
  const types = store.getRun(run.runId).evidence.map((e) => e.type)
  assert.deepEqual(types, ['baseline', 'file-manifest', 'verification'])

  // 3) manifest 稳定 + 随证据变化
  const rec1 = store.getRun(run.runId)
  const h1 = collector.manifestHash(rec1)
  assert.equal(collector.manifestHash(rec1), h1, 'manifestHash 幂等')
  const h2 = collector.manifestHash({ ...rec1, evidence: [...rec1.evidence, { ...rec1.evidence[0], evidenceId: 'ev_extra' }] })
  assert.notEqual(h2, h1, '证据变化 → hash 变化')

  // 4) 受控读取：record / stdout
  const ev = store.getRun(run.runId).evidence.find((e) => e.type === 'verification')
  const rec = collector.readEvidence(run.runId, ev.evidenceId)
  assert.match(rec.content, /"exitCode": 0/)
  const out = collector.readEvidence(run.runId, ev.evidenceId, { kind: 'stdout' })
  assert.match(out.content, /checks passed/)
  assert.throws(() => collector.readEvidence(run.runId, 'ev_nope'), (e) => e instanceof MixedError)

  // 5) 时效作废：输入树变化 → 旧验证证据 invalidated
  fs.writeFileSync(path.join(ws, 'check.mjs'), 'import assert from "node:assert"; assert.equal(1, 2)')
  const changed = await collector.invalidateStale(store, store.getRun(run.runId), hashTree(ws).fingerprint)
  assert.equal(changed, 1, '1 条验证证据因输入树变化作废')
  assert.equal(store.getRun(run.runId).evidence.find((e) => e.type === 'verification').invalidated, true)
  // 指纹未变 → 不再作废
  assert.equal(await collector.invalidateStale(store, store.getRun(run.runId), hashTree(ws).fingerprint), 0)

  // 6) 受控读取越界防护：ref 指向证据目录外（伪造）→ 拒绝
  const outside = path.join(root, 'mixed-evidence', 'outside.txt')
  fs.mkdirSync(path.dirname(outside), { recursive: true })
  fs.writeFileSync(outside, 'x')
  const cur = store.getRun(run.runId)
  await store.updateRun(run.runId, (c) =>
    advanceRun(c, {
      ownerKey: c.ownerKey,
      ownerEpoch: c.ownerEpoch,
      event: { type: 'evidence_added', summary: 'forged' },
      patch: { evidence: [...c.evidence, { ...c.evidence[0], evidenceId: 'ev_forge', ref: 'outside.txt' }] },
    }),
  )
  assert.throws(
    () => collector.readEvidence(run.runId, 'ev_forge'),
    (e) => e instanceof MixedError && (e.message.includes('不存在') || e.message.includes('越界')),
  )
  void cur
})
