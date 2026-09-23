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
  KernelPatchError,
  missingPatches,
  resolveKernelFile,
  resolveMarkFile,
  resolvePresetRel,
} from '../kernel/patches.mjs'

const GOAL_RC11 =
  '\t\t\tif (current.phase === "active" && cache.activation === "armed") throw new GoalError(`goal "${current.id}" is already active and armed`, "GOAL_INVALID_TRANSITION");\n'
const GOAL_RC12 =
  '\t\t\tif (current.phase === "active" && runtime.activation === "armed") throw new GoalError(`goal "${current.id}" is already active and armed`, "GOAL_INVALID_TRANSITION");\n'

const MARKDOWN_RC13 =
  '\t\t\t\t\t\trendered.push((0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, {\n\t\t\t\t\t\t\ttext: block.text,\n\t\t\t\t\t\t\tstreaming,\n\t\t\t\t\t\t\tlabels,\n\t\t\t\t\t\t\tfileMentions: mentions\n\t\t\t\t\t\t}, i));'
const MARKDOWN_RC15 =
  '\t\t\t\t\t\trendered.push((0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, {\n\t\t\t\t\t\t\ttext: block.text,\n\t\t\t\t\t\t\tstreaming,\n\t\t\t\t\t\t\tlabels,\n\t\t\t\t\t\t\tfileMentions: mentions,\n\t\t\t\t\t\t\tpathImages\n\t\t\t\t\t\t}, i));'

test('assistant markdown：0.1.3 与 0.1.5 的 MarkdownText 都能切到 renderMarkdown 槽', () => {
  const edit = CODE_PATCHES.find((p) => p.mark === 'company-assistant-markdown-slot-v1').edits.find((e) => e.name === 'assistant-markdown-slot-render')
  const old = applyEdit(MARKDOWN_RC13, edit, 'dsh-client-ui-chat')
  const neu = applyEdit(MARKDOWN_RC15, edit, 'dsh-client-ui-chat')
  assert.match(old, /renderMarkdown\(\{ text: block\.text, streaming, labels, fileMentions: mentions \}\)/)
  assert.match(neu, /renderMarkdown\(\{ text: block\.text, streaming, labels, fileMentions: mentions, pathImages \}\)/)
  assert.equal(old.includes('pathImages'), false)
})

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

function writeMarkedKernelExceptLive(kernelRoot) {
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
      '  config:',
      '    includeDefaultRoots: false',
      '    watch: false',
      "    bundledSkillDir: '/tmp/skills'   # company-desk skills root",
      '    customSkillDirs:',
      "      - '/tmp/skills'   # company-desk skills root",
      '# --- company-preset-skills-v1 ---',
      '# --- company-preset-skills-v2 ---',
      '- id: tool-web',
      "  name: '@deepseek-ai/dsh-tool-web'",
      '  config:',
      '    fetch: true',
      '    searchTimeoutMs: 60000',
      '    fetchTimeoutMs: 90000',
      '# --- company-preset-web-fetch-v2 ---',
      '- id: agent-instructions',
      "  name: '@deepseek-ai/dsh-agent-instructions'",
      '  config:',
      '    maxBytes: 65536',
      '    projectRootMarkers:',
      '      - .company-root',
      '# --- company-preset-instr-root-v1 ---',
      '',
    ].join('\n'),
  )
}

const ANYSEARCH_CLIENT_SNIPPET =
  "        const timeoutController = new AbortController();\n" +
  "        const timeout = setTimeout(() => {\n" +
  "            timeoutController.abort(new DOMException('AnySearch HTTP request timed out', 'TimeoutError'));\n" +
  "        }, ANYSEARCH_HTTP_TIMEOUT_MS);\n" +
  "        const requestSignal = signal === undefined\n" +
  "            ? timeoutController.signal\n" +
  "            : AbortSignal.any([signal, timeoutController.signal]);\n" +
  "        let response;\n" +
  "        try {\n" +
  "            response = await fetch(url, {\n" +
  "                method: init.method,\n" +
  "                redirect: 'error',\n" +
  "                headers,\n" +
  "                ...init.body === undefined ? {} : { body: init.body },\n" +
  "                signal: requestSignal,\n" +
  "            });\n" +
  "        }\n" +
  "        catch (error) {\n" +
  "            clearTimeout(timeout);\n" +
  "            if (signal?.aborted === true)\n" +
  "                throw aborted(operation, signal, error);\n" +
  "            if (timeoutController.signal.aborted)\n" +
  "                throw timedOut(operation, error);\n" +
  "            if (isAbortError(error))\n" +
  "                throw aborted(operation, signal, error);\n" +
  "            throw new AnySearchClientError(`AnySearch ${operation} request failed: ${String(error)}`, { operation, cause: error });\n" +
  "        }\n" +
  "        const retryAfter = response.headers.get('retry-after') ?? undefined;\n" +
  "function isAbortError(error) {\n" +
  "    return error instanceof DOMException && error.name === 'AbortError';\n" +
  "}\n" +
  "function isSignalAborted(signal) {\n" +
  "    return signal?.aborted === true;\n" +
  "}\n"

test('AnySearch client：瞬时 fetch failed / 5xx 重试，并把 cause 写进错误', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-anysearch-retry-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const kernelRoot = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(kernelRoot, { recursive: true })
  writeMarkedKernelExceptLive(kernelRoot)
  const client = path.join(kernelRoot, '..', '..', '@anysearch', 'anysearch-dsh', 'lib', 'client.js')
  fs.mkdirSync(path.dirname(client), { recursive: true })
  fs.writeFileSync(client, ANYSEARCH_CLIENT_SNIPPET)
  applyKernelPatches({ kernelRoot, skillsDir: path.join(dir, 'skills'), log: () => {} })
  const patched = fs.readFileSync(client, 'utf8')
  assert.match(patched, /const maxAttempts = 3/)
  assert.match(patched, /isTransientNetworkError/)
  assert.match(patched, /formatFetchFailure/)
  assert.match(patched, /company-anysearch-fetch-retry-v1/)
  assert.match(patched, /fetch failed\|socket hang up/)
  assert.equal(patched.includes('request failed: ${String(error)}'), false)
  applyKernelPatches({ kernelRoot, skillsDir: path.join(dir, 'skills'), log: () => {} })
  assert.equal(fs.readFileSync(client, 'utf8'), patched)
  assert.deepEqual(missingPatches(kernelRoot), [])
})

function hoistedKernelFile(kernelRoot, rel) {
  const parts = String(rel).split(/[\\/]+/).filter(Boolean)
  if (parts[0] !== 'node_modules') return path.join(kernelRoot, rel)
  return path.join(kernelRoot, '..', '..', ...parts.slice(1))
}

test('npm 10：依赖嵌在兄弟包 node_modules 里也能找到', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-patch-sibling-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const kernelRoot = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  const rel = path.join('node_modules', '@deepseek-ai', 'dsh-client-ui-chat', 'lib', 'client.js')
  const nested = path.join(kernelRoot, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'node_modules', '@deepseek-ai', 'dsh-client-ui-chat', 'lib', 'client.js')
  fs.mkdirSync(path.dirname(nested), { recursive: true })
  fs.writeFileSync(nested, 'sibling')
  assert.equal(resolveKernelFile(kernelRoot, rel), nested)
})

test('补丁包版本飘走时拒绝打补丁', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-patch-drift-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const kernelRoot = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  const pkgDir = path.join(kernelRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-chat')
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-client-ui-chat', version: '0.1.5-rc.3' }))
  fs.writeFileSync(path.join(pkgDir, 'lib', 'client.js'), 'x')
  assert.throws(
    () => applyKernelPatches({ kernelRoot, skillsDir: dir, log: () => {}, expectVersion: '0.1.5-rc.2' }),
    (err) => err instanceof KernelPatchError && err.code === 'version-drift' && /0\.1\.5-rc\.3/.test(err.detail),
  )
})

test('npm 提升布局：补丁目标不在 dsh/node_modules 里也能找到并打上', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-patch-hoisted-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const kernelRoot = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(kernelRoot, { recursive: true })
  const chatRel = path.join('node_modules', '@deepseek-ai', 'dsh-client-ui-chat', 'lib', 'client.js')
  assert.equal(resolveKernelFile(kernelRoot, chatRel), null)

  const live = new Set(['company-goal-resume-armed-v1', 'company-win-junction-mklink-v3', 'company-win-junction-mklink-v4'])
  const marksByFile = new Map()
  for (const patch of CODE_PATCHES) {
    const f = hoistedKernelFile(kernelRoot, patch.file)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    if (patch.mark === 'company-goal-resume-armed-v1') fs.writeFileSync(f, GOAL_RC12)
    else if (patch.mark === 'company-win-junction-mklink-v3') fs.writeFileSync(f, JUNCTION_RC12)
    if (live.has(patch.mark)) continue
    const marks = marksByFile.get(patch.file) ?? []
    marks.push(patch.mark, ...(patch.already ?? []))
    marksByFile.set(patch.file, marks)
  }
  for (const [file, marks] of marksByFile) {
    fs.writeFileSync(hoistedKernelFile(kernelRoot, file), marks.map((m) => `// ${m}`).join('\n') + '\n')
  }
  const presetRel = path.join('node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml')
  const preset = hoistedKernelFile(kernelRoot, presetRel)
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
  assert.equal(fs.existsSync(path.join(kernelRoot, chatRel)), false)
  assert.equal(resolveKernelFile(kernelRoot, chatRel), hoistedKernelFile(kernelRoot, chatRel))
  applyKernelPatches({ kernelRoot, skillsDir: path.join(dir, 'skills'), log: () => {} })
  const goal = fs.readFileSync(hoistedKernelFile(kernelRoot, patchNamed('company-goal-resume-armed-v1').file), 'utf8')
  assert.match(goal, /company-goal-resume-armed-v1/)
  assert.equal(fs.existsSync(path.join(kernelRoot, patchNamed('company-goal-resume-armed-v1').file)), false)
  assert.deepEqual(missingPatches(kernelRoot), [])
})

test('AnySearch client：没装插件时跳过，不挡内核补丁', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-anysearch-skip-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const kernelRoot = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(kernelRoot, { recursive: true })
  writeMarkedKernelExceptLive(kernelRoot)
  assert.doesNotThrow(() => applyKernelPatches({ kernelRoot, skillsDir: path.join(dir, 'skills'), log: () => {} }))
  assert.deepEqual(missingPatches(kernelRoot), [])
})
