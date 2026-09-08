/**
 * 内核补丁重审：0.1.1-rc.2 与 0.1.2-rc.1 两套源码都要能打上。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyEdit,
  applyKernelPatches,
  CODE_PATCHES,
  missingPatches,
  resolveMarkFile,
  resolvePresetRel,
} from '../kernel/patches.mjs'

const GOAL_RC11 =
  '\t\t\tif (current.phase === "active" && cache.activation === "armed") throw new GoalError(`goal "${current.id}" is already active and armed`, "GOAL_INVALID_TRANSITION");\n'
const GOAL_RC12 =
  '\t\t\tif (current.phase === "active" && runtime.activation === "armed") throw new GoalError(`goal "${current.id}" is already active and armed`, "GOAL_INVALID_TRANSITION");\n'

test('0.1.3 会话落盘：增加 rename 时保留新会话锁使用的 lstat', () => {
  const edit = CODE_PATCHES.find((p) => p.mark === 'company-session-smbfs-rename-v1').edits[0]
  const source = 'import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from "node:fs/promises";\n'
  assert.equal(applyEdit(source, edit), source.replace('realpath, rm', 'realpath, rename, rm'))
})

const JUNCTION_RC11 =
  'function ensureSymlink(link, target) {\n' +
  '\tlet stat;\n' +
  '\ttry {\n' +
  '\t\tstat = lstatSync(link);\n' +
  '\t} catch {\n' +
  '\t\tstat = void 0;\n' +
  '\t}\n' +
  '\tif (stat !== void 0) {\n' +
  '\t\tif (!stat.isSymbolicLink()) throw new Error(`dsh: ${link} exists and is not a symlink; remove it so dsh can manage the installation fallback`);\n' +
  '\t\tif (readlinkSync(link) === target) return;\n' +
  '\t\tunlinkSync(link);\n' +
  '\t}\n' +
  '\ttry {\n' +
  '\t\tsymlinkSync(target, link, "junction");\n' +
  '\t} catch (error) {\n' +
  '\t\t/* v8 ignore next 4 */\n' +
  '\t\tif (error.code !== "EEXIST" || !lstatSync(link).isSymbolicLink() || readlinkSync(link) !== target) throw error;\n' +
  '\t}\n' +
  '}\n'

const JUNCTION_RC12 =
  'function ensureSymlink(link, target) {\n' +
  '\tlet stat;\n' +
  '\ttry {\n' +
  '\t\tstat = lstatSync(link);\n' +
  '\t} catch {\n' +
  '\t\tstat = void 0;\n' +
  '\t}\n' +
  '\tif (stat !== void 0) {\n' +
  '\t\tif (!stat.isSymbolicLink()) {\n' +
  '\t\t\tif ((stat.isDirectory() ? readModuleProxyRecord(link) : void 0)?.dsh?.moduleFallback?.targets === void 0) throw new Error(`dsh: ${link} exists and is not a symlink or dsh-managed module proxy; remove it so dsh can manage the installation fallback`);\n' +
  '\t\t\trmSync(link, { recursive: true });\n' +
  '\t\t\tstat = void 0;\n' +
  '\t\t}\n' +
  '\t\tif (stat !== void 0) {\n' +
  '\t\t\tif (symlinkPointsTo(link, target)) return;\n' +
  '\t\t\tunlinkSync(link);\n' +
  '\t\t}\n' +
  '\t}\n' +
  '\ttry {\n' +
  '\t\tsymlinkSync(target, link, "junction");\n' +
  '\t} catch (error) {\n' +
  '\t\t/* v8 ignore next 4 */\n' +
  '\t\tif (error.code !== "EEXIST" || !lstatSync(link).isSymbolicLink() || !symlinkPointsTo(link, target)) throw error;\n' +
  '\t}\n' +
  '}\n'

function patchNamed(mark) {
  return CODE_PATCHES.find((p) => p.mark === mark)
}

const SESSION_EVENTAT =
  '\teventAt(seq) {\n' +
  '\t\treturn this.log[seq];\n' +
  '\t}\n' +
  '\t/**\n' +
  '\t* Materialize an immutable snapshot of a half-open event sequence range.\n'

test('session.events：0.1.2 补兼容 getter，旧预设 scanEvents 能读 length', () => {
  const patch = patchNamed('company-session-events-alias-v1')
  assert.ok(patch, '缺少 company-session-events-alias-v1 补丁')
  const out = applyEdit(SESSION_EVENTAT, patch.edits[0], 'dsh-session')
  assert.match(out, /get events\(\) \{\n\t\treturn this\.snapshotEvents\(\);\n\t\}/)
  assert.equal(out.includes('return this.log[seq];'), true)
})

test('goal resume：0.1.1-rc.2 cache.activation 打成 no-op', () => {
  const out = applyEdit(GOAL_RC11, patchNamed('company-goal-resume-armed-v1').edits[0], 'dsh-goal')
  assert.match(out, /return view/)
  assert.match(out, /this\.view\(cache\)/)
  assert.equal(out.includes('throw new GoalError') && out.includes('already active and armed'), true)
})

test('goal resume：0.1.2-rc.1 runtime.activation 打成 no-op', () => {
  const out = applyEdit(GOAL_RC12, patchNamed('company-goal-resume-armed-v1').edits[0], 'dsh-goal')
  assert.match(out, /return view/)
  assert.match(out, /this\.view\(currentState, runtime\)/)
  assert.equal(out.includes('cache.activation'), false)
})

test('win junction v3：两版 ensureSymlink 都能打上，且留下 v4 要的 spawnSync', () => {
  const edit = patchNamed('company-win-junction-mklink-v3').edits[0]
  const old = applyEdit(JUNCTION_RC11, edit, 'dsh-app-boot')
  const neu = applyEdit(JUNCTION_RC12, edit, 'dsh-app-boot')
  assert.match(old, /companyWinJunction/)
  assert.match(neu, /companyWinJunction/)
  assert.match(neu, /readModuleProxyRecord/)
  const v4 = patchNamed('company-win-junction-mklink-v4').edits[0]
  assert.equal(old.split(v4.from).length - 1, 1)
  assert.equal(neu.split(v4.from).length - 1, 1)
})

test('预设路径：0.1.2 认 dsh-agent-presets；缺 code 不算缺标', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-preset-path-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const kernelRoot = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  const rel = path.join('node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml')
  const file = path.join(kernelRoot, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    [
      "- id: skill-filesystem",
      "  name: '@deepseek-ai/dsh-skill-filesystem'",
      '',
      '- id: tool-web',
      "  name: '@deepseek-ai/dsh-tool-web'",
      '  config:',
      '    fetch: true',
      '    searchTimeoutMs: 60000',
      '',
      '- id: agent-instructions',
      "  name: '@deepseek-ai/dsh-agent-instructions'",
      '  config:',
      '    maxBytes: 65536',
      '',
    ].join('\n'),
  )
  assert.ok(String(resolvePresetRel(kernelRoot, 'standard')).includes('dsh-agent-presets'))
  assert.equal(resolvePresetRel(kernelRoot, 'code'), null)
  assert.equal(resolveMarkFile(kernelRoot, { file: rel, files: [path.join('config', 'agent-presets', 'standard', 'agent.cordis.yml'), rel] }), file)
})

test('applyKernelPatches：0.1.2 风格 goal + junction + 新预设路径一次打齐', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-patch-rc12-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const kernelRoot = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(kernelRoot, { recursive: true })
  const live = new Set(['company-goal-resume-armed-v1', 'company-win-junction-mklink-v3', 'company-win-junction-mklink-v4'])
  const marksByFile = new Map()
  for (const patch of CODE_PATCHES) {
    const f = path.join(kernelRoot, patch.file)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    if (patch.mark === 'company-goal-resume-armed-v1') fs.writeFileSync(f, GOAL_RC12)
    else if (patch.mark === 'company-win-junction-mklink-v3') fs.writeFileSync(f, JUNCTION_RC12)
    if (live.has(patch.mark)) continue
    const marks = marksByFile.get(patch.file) ?? []
    marks.push(patch.mark, ...(patch.already ?? []))
    marksByFile.set(patch.file, marks)
  }
  for (const [file, marks] of marksByFile) {
    fs.writeFileSync(path.join(kernelRoot, file), marks.map((m) => `// ${m}`).join('\n') + '\n')
  }
  const presetRel = path.join('node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml')
  const preset = path.join(kernelRoot, presetRel)
  fs.mkdirSync(path.dirname(preset), { recursive: true })
  fs.writeFileSync(
    preset,
    [
      "- id: skill-filesystem",
      "  name: '@deepseek-ai/dsh-skill-filesystem'",
      '',
      '- id: tool-web',
      "  name: '@deepseek-ai/dsh-tool-web'",
      '  config:',
      '    fetch: true',
      '    searchTimeoutMs: 60000',
      '',
      '- id: agent-instructions',
      "  name: '@deepseek-ai/dsh-agent-instructions'",
      '  config:',
      '    maxBytes: 65536',
      '',
    ].join('\n'),
  )
  const skillsDir = path.join(dir, 'skills')
  applyKernelPatches({ kernelRoot, skillsDir, log: () => {} })
  const goal = fs.readFileSync(path.join(kernelRoot, patchNamed('company-goal-resume-armed-v1').file), 'utf8')
  assert.match(goal, /this\.view\(currentState, runtime\)/)
  assert.match(goal, /company-goal-resume-armed-v1/)
  const boot = fs.readFileSync(path.join(kernelRoot, patchNamed('company-win-junction-mklink-v3').file), 'utf8')
  assert.match(boot, /companyWinJunction/)
  assert.match(boot, /SystemRoot/)
  const yml = fs.readFileSync(preset, 'utf8')
  assert.match(yml, /company-preset-skills-v2/)
  assert.match(yml, /fetchTimeoutMs: 90000/)
  assert.match(yml, /\.company-root/)
  assert.deepEqual(missingPatches(kernelRoot), [])
})
