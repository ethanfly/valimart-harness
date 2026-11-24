/**
 * 内核补丁重审：0.1.1-rc.2 与 0.1.2-rc.1 两套源码都要能打上。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import {
  applyEdit,
  applyKernelPatches,
  CODE_PATCHES,
  companyAssertLinuxWorkspace,
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

const ASSISTANT_017_RETURN =
  'return (0, react_jsx_runtime.jsx)(AssistantMarkdown, {\n\t\t\t\tblocks: data.blocks,\n\t\t\t\tgroupPart,\n\t\t\t\tuseDisclosure,'
const ASSISTANT_017_REGISTER =
  'key: "assistant-step",\n\t\t\t\tlocale: NS,\n\t\t\t\tinject: () => ({ hooks: { presentation } })\n\t\t\t}, AssistantNodeView)'

// 0.2.1-rc.2：AssistantMarkdown / AssistantNodeView 原生带 renderSlot（上游为 conversation.chat.*
// 槽传入），assistant-node-render-slot 编辑已从补丁删除；assistant-step 注册原生带 children。
// 文本块渲染与实例化锚点同 MARKDOWN_RC15 / ASSISTANT_017_RETURN（逐字节一致），不重复建 fixture。
const ASSISTANT_021_SIG =
  'function AssistantMarkdown({ blocks, streaming, interrupted, loadImage, groupPart, useDisclosure, reasoningHidden = false, usePresentation, revealProcess, mentions, renderSlot, useGroupAction, t }) {'
const ASSISTANT_021_REGISTER =
  '\t\t\t\t\t"conversation.chat.message.images": {\n\t\t\t\t\t\tkind: "single",\n\t\t\t\t\t\tscope: "session"\n\t\t\t\t\t}\n\t\t\t\t},\n\t\t\t\tinject: () => ({ hooks: { presentation } })\n\t\t\t}, AssistantNodeView));'

// 0.2.2-rc.x：client.js 压成单行无空格 minify，字符串用反引号；AssistantMarkdown 签名在
// streaming 后加 textInteractionSource，文本块渲染与实例化 props 同步带上它。
const ASSISTANT_022_SIG =
  'function AssistantMarkdown({blocks,streaming,textInteractionSource=false,interrupted,loadImage,groupPart,useDisclosure,reasoningHidden=false,usePresentation,revealProcess,mentions,renderSlot,useGroupAction,t})'
const MARKDOWN_022 =
  'rendered.push((0,react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText,{text:block.text,streaming,labels,fileMentions:mentions,pathImages,textInteractionSource},i));'
const ASSISTANT_022_RETURN =
  '(0,react_jsx_runtime.jsx)(AssistantMarkdown,{blocks:data.blocks,groupPart,useDisclosure,streaming:data.status===`running`,textInteractionSource:data.status===`settled`&&data.finalNode?.messageId!==void 0,interrupted:data.status===`interrupted`,loadImage,reasoningHidden,useGroupAction,usePresentation,renderSlot,revealProcess,mentions,t})});'
const ASSISTANT_022_REGISTER =
  'key:`assistant-step`,locale:NS,children:{"conversation.chat.reasoning.body":{kind:`single`,scope:`session`},"conversation.chat.message.images":{kind:`single`,scope:`session`}},inject:sessionId=>({hooks:{presentation},resolveFilePath:sessionFilePath(ctx,sessionId),fileMentions:(owner,getFileTriggerProps)=>ctx.get(`chatFileMentions`)?.forClosing(owner,sessionId,getFileTriggerProps)})},AssistantNodeView));'

// 0.2.2-rc.x：sandbox-local 的 materializeAclGrant 重写为 isTempRootInsideWorkspace +
// SandboxPreparationError；grant 失败统一走 aclPreparationFailure（三处）。
const SANDBOX_022_MATERIALIZE = '\tmaterializeAclGrant(sessionId, workspaceRoot) {\n\t\tlet tempInsideWorkspace;\n'
const SANDBOX_022_GRANT_BLOCK =
  '\t\tif (!this.workspaceGrants.has(workspaceRoot)) {\n\t\t\tlet grant;\n\t\t\ttry {\n\t\t\t\tgrant = AclWriteGrant.create(writeSid);\n\t\t\t} catch (error) {\n\t\t\t\tthrow aclPreparationFailure("workspace grant", error);\n\t\t\t}\n\t\t\ttry {\n\t\t\t\tgrant.add(workspaceRoot, true);\n\t\t\t} catch (error) {\n\t\t\t\ttry {\n\t\t\t\t\tgrant.dispose();\n\t\t\t\t} catch (cleanupError) {\n\t\t\t\t\tthrow aclPreparationFailure("workspace grant", error, [cleanupError]);\n\t\t\t\t}\n\t\t\t\tthrow aclPreparationFailure("workspace grant", error);\n\t\t\t}\n\t\t\tthis.workspaceGrants.set(workspaceRoot, grant);\n\t\t}'

// 0.2.2-rc.x：覆盖判定换成 options.existingDestination（缺省回落原启发式）。
const FS_022_REPLACE =
  '\t\telse if (platform === "win32" && existingDestination) try {\n' +
  '\t\t\tawait replaceFile(absolutePath, tempPath);\n' +
  '\t\t} catch (error) {\n' +
  '\t\t\tif (!isENOENT(error)) throw error;\n' +
  '\t\t\tawait rename(tempPath, absolutePath);\n' +
  '\t\t}\n'

test('assistant markdown：0.1.7 的过程组签名仍把正文交给 renderMarkdown 槽', () => {
  const patch = CODE_PATCHES.find((p) => p.mark === 'company-assistant-markdown-slot-v1')
  const ret = applyEdit(ASSISTANT_017_RETURN, patch.edits.find((e) => e.name === 'assistant-node-markdown-fallback'), 'dsh-client-ui-chat')
  const reg = applyEdit(ASSISTANT_017_REGISTER, patch.edits.find((e) => e.name === 'assistant-markdown-child-slot'), 'dsh-client-ui-chat')
  assert.match(ret, /renderMarkdown: \(props\) => renderSlot\("conversation\.assistant\.markdown"/)
  assert.match(ret, /groupPart,/)
  assert.match(reg, /children: \{ "conversation\.assistant\.markdown": \{ kind: "single", scope: "session" \} \}/)
  assert.match(reg, /inject: \(\) => \(\{ hooks: \{ presentation \} \}\)/)
})

test('assistant markdown：0.2.1-rc.2 原生 renderSlot 签名与 children 子槽都能打上', () => {
  const patch = CODE_PATCHES.find((p) => p.mark === 'company-assistant-markdown-slot-v1')
  assert.equal(patch.edits.some((e) => e.name === 'assistant-node-render-slot'), false, '0.2.1 上游已原生传 renderSlot，该编辑应已删除')
  const sig = applyEdit(ASSISTANT_021_SIG, patch.edits.find((e) => e.name === 'markdown-render-prop'), 'dsh-client-ui-chat')
  const reg = applyEdit(ASSISTANT_021_REGISTER, patch.edits.find((e) => e.name === 'assistant-markdown-child-slot'), 'dsh-client-ui-chat')
  assert.match(sig, /function AssistantMarkdown\(\{ blocks, streaming, interrupted, renderMarkdown, loadImage,/)
  assert.match(reg, /"conversation\.chat\.message\.images": \{\n\t+kind: "single",\n\t+scope: "session"\n\t+\},/)
  assert.match(reg, /"conversation\.assistant\.markdown": \{\n\t+kind: "single",\n\t+scope: "session"\n\t+\}\n\t+\},/)
  assert.match(reg, /inject: \(\) => \(\{ hooks: \{ presentation \} \}\)\n\t+\}, AssistantNodeView\)\);/)
})

test('assistant markdown：0.2.2 minify 签名 / 文本块 / 实例化 / 子槽都能打上', () => {
  const patch = CODE_PATCHES.find((p) => p.mark === 'company-assistant-markdown-slot-v1')
  const sig = applyEdit(ASSISTANT_022_SIG, patch.edits.find((e) => e.name === 'markdown-render-prop'), 'dsh-client-ui-chat')
  const blk = applyEdit(MARKDOWN_022, patch.edits.find((e) => e.name === 'assistant-markdown-slot-render'), 'dsh-client-ui-chat')
  const ret = applyEdit(ASSISTANT_022_RETURN, patch.edits.find((e) => e.name === 'assistant-node-markdown-fallback'), 'dsh-client-ui-chat')
  const reg = applyEdit(ASSISTANT_022_REGISTER, patch.edits.find((e) => e.name === 'assistant-markdown-child-slot'), 'dsh-client-ui-chat')
  assert.match(sig, /function AssistantMarkdown\(\{blocks,streaming,textInteractionSource=false,interrupted,renderMarkdown,loadImage,/)
  assert.match(blk, /renderMarkdown\(\{text:block\.text,streaming,labels,fileMentions:mentions,pathImages,textInteractionSource\}\)/)
  assert.match(ret, /renderMarkdown:\(props\)=>renderSlot\(`conversation\.assistant\.markdown`,props,\{fallback:/)
  assert.match(reg, /"conversation\.assistant\.markdown":\{kind:`single`,scope:`session`\}\},inject:/)
})

test('sandbox-local：0.2.2 的 materializeAclGrant / aclPreparationFailure 都能打上', () => {
  const patch = CODE_PATCHES.find((p) => p.mark === 'company-sandbox-local-unc-v1')
  const mat = applyEdit(SANDBOX_022_MATERIALIZE, patch.edits.find((e) => e.name === 'materializeAclGrant-precheck'), 'dsh-sandbox-local')
  const grant = applyEdit(SANDBOX_022_GRANT_BLOCK, patch.edits.find((e) => e.name === 'workspace-grant-diagnosis'), 'dsh-sandbox-local')
  assert.match(mat, /materializeAclGrant\(sessionId, workspaceRoot\) \{\n\t+companyAssertLocalWorkspace\(workspaceRoot\);\n\t+let tempInsideWorkspace;/)
  assert.equal(grant.split('companyGrantError(workspaceRoot, error)').length - 1, 3)
  assert.equal(grant.includes('aclPreparationFailure("workspace grant", error'), false)
})

test('fs-local：0.2.2 的 existingDestination 覆盖判定仍能走 UNC rename 回退', () => {
  const patch = CODE_PATCHES.find((p) => p.mark === 'company-fs-unc-replace-v1')
  const out = applyEdit(FS_022_REPLACE, patch.edits.find((e) => e.name === 'unc-skip-replacefilew'), 'dsh-fs-local')
  assert.match(out, /const unc = String\(absolutePath/)
  assert.match(out, /if \(unc\) await rename\(tempPath, absolutePath\);/)
  assert.match(out, /error\.code === "EACCES" \|\| error\.win32Code === 5/)
})

// @earendil-works/pi-ai（0.2.2 内核内嵌）：openai-completions.js 的 createClient 构造点。
const PIAI_IMPORT = 'import OpenAI from "openai";'
const PIAI_CTOR =
  '    return new OpenAI({\n' +
  '        apiKey,\n' +
  '        baseURL: model.baseUrl,\n' +
  '        dangerouslyAllowBrowser: true,\n' +
  '        fetch,\n' +
  '        defaultHeaders: headers,\n' +
  '    });'

test('pi-ai：openai 客户端注入无 300s 闲置 cap 的核心 http fetch', () => {
  const patch = CODE_PATCHES.find((p) => p.mark === 'company-pi-ai-uncapped-fetch-v1')
  const head = applyEdit(PIAI_IMPORT, patch.edits.find((e) => e.name === 'inject-core-fetch'), 'pi-ai')
  const ctor = applyEdit(PIAI_CTOR, patch.edits.find((e) => e.name === 'use-core-fetch'), 'pi-ai')
  assert.match(head, /function companyUpstreamFetch\(url, init = \{\}\)/)
  assert.match(head, /Readable\.toWeb\(res\)/)
  assert.match(head, /AbortError/)
  assert.match(ctor, /fetch: fetch \?\? companyUpstreamFetch,/)
})

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

// ---------------------------------------------------------------------------------------------
// 2026-11-24 同步上游 TDHarness 的补丁收紧：C8 glob-missing-root-v2、C3 fs-unc-acl-v2、C2b sandbox-linux-cifs-v1。
// 矩阵移植自上游 scripts/prove-search-errors.js / prove-privilege-patches.js / prove-linux-cifs.js，
// 打完补丁的片段放进 vm 里跑，验的是嵌进内核的那份代码，不是 patches.mjs 里导出的副本。

/** 按 applyKernelPatches 的方式只打一条补丁（编辑 + 末尾 append）。 */
function patchText(text, patch) {
  let out = text
  for (const edit of patch.edits) out = applyEdit(out, edit, patch.file)
  return out.trimEnd() + '\n' + patch.append
}

/** 按 supersedes 记录的旧补丁形状打一份 v1，模拟打过旧补丁的开发 / 构建机前缀。 */
function legacyText(text, legacy) {
  let out = text
  for (const edit of legacy.edits) out = applyEdit(out, edit, legacy.mark)
  return out.trimEnd() + '\n' + legacy.append
}

const SEARCH_ANCHOR =
  '\tif (outcome.exitCode !== 0 && outcome.exitCode !== 1) throw classifyRunFailure(toolName, outcome.exitCode, stderr.text, stderr.lossy);\n'
const SEARCH_FIXTURE =
  'function run(outcome, stderr, stdout, argv) {\n' +
  '\tconst toolName = "glob", workdir = "/test";\n' +
  SEARCH_ANCHOR +
  '\treturn { stdout: stdout.text, noMatches: outcome.exitCode === 1 };\n' +
  '}\n'

function searchRunner(source) {
  const context = vm.createContext({ classifyRunFailure: () => Object.assign(new Error('search failed'), { code: 'SEARCH_FAILED' }) })
  vm.runInContext(source, context)
  return (text, o = {}) =>
    context.run(
      { exitCode: o.exitCode ?? 2 },
      { text, lossy: o.stderrLossy ?? false },
      { text: o.stdout ?? '', lossy: o.stdoutLossy ?? false },
      o.argv ?? ['--files', '--', 'missing'],
    )
}

const rgMissing = (p, message = 'No such file or directory (os error 2)') => `rg: ${p}: IO error for operation on ${p}: ${message}\n`

test('glob-missing-root v2：只有显式搜索根缺失（精确 os error 2）才当空结果，其余照常报错', () => {
  const patch = patchNamed('company-glob-missing-root-v2')
  const run = searchRunner(patchText(SEARCH_FIXTURE, patch))
  for (const text of [rgMissing('missing'), 'missing: No such file or directory (os error 2)\n', rgMissing('missing', '系统找不到指定的文件。 (os error 2)')]) {
    assert.equal(run(text).noMatches, true, text)
  }
  const failures = [
    [rgMissing('missing', 'Not a directory (os error 20)')],
    [rgMissing('missing', 'Permission denied (os error 13)')],
    [rgMissing('missing') + 'rg: private: Permission denied (os error 13)\n'],
    [rgMissing('missing') + 'regex parse error: invalid pattern\n'],
    [rgMissing('missing/child')],
    ['IO error: cannot find the file'],
    [''],
    [rgMissing('missing'), { exitCode: 3 }],
    [rgMissing('missing'), { stderrLossy: true }],
    [rgMissing('missing'), { stdoutLossy: true }],
    [rgMissing('missing'), { stdout: 'partial match\n' }],
    [rgMissing('missing'), { argv: ['--files'] }],
  ]
  for (const [text, o] of failures) assert.throws(() => run(text, o), { code: 'SEARCH_FAILED' }, JSON.stringify([text, o]))
  assert.equal(run('', { exitCode: 1 }).noMatches, true)
  assert.equal(run('', { exitCode: 0, stdout: 'file.txt' }).stdout, 'file.txt')
  // v1 的模糊匹配会把夹带的权限错误一起吞成「没有匹配」——这就是收紧的原因。
  const legacy = searchRunner(legacyText(SEARCH_FIXTURE, patch.supersedes))
  assert.equal(legacy(rgMissing('missing') + 'rg: private: Permission denied (os error 13)\n').noMatches, true)
})

test('glob-missing-root v2：真实 rg 对不存在搜索根的诊断能被认出', (t) => {
  const rg = process.env.DESK_TEST_RG || 'rg'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-rg-missing-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const absent = path.join(dir, 'missing folder')
  const result = spawnSync(rg, ['--files', '--', absent], { encoding: 'utf8', windowsHide: true })
  if (result.error) return t.skip(`找不到 rg（${result.error.code}），可用 DESK_TEST_RG 指定`)
  assert.equal(result.status, 2, result.stderr)
  const run = searchRunner(patchText(SEARCH_FIXTURE, patchNamed('company-glob-missing-root-v2')))
  assert.equal(run(result.stderr, { argv: ['--files', '--', absent] }).noMatches, true, result.stderr)
})

test('fs-unc-acl v2：只有两端都是 UNC 共享才跳过 DACL 复制，本地 / 混合路径的错误照常抛出', async () => {
  const patch = patchNamed('company-fs-unc-acl-v2')
  const unc = String.raw`\\server.example\share\file`
  let reads = 0
  let writes = 0
  let readError
  let setError = 0
  const context = vm.createContext({
    readFileDaclWin32: async () => {
      reads++
      if (readError) throw readError
      return 'descriptor'
    },
    win32: async () => ({
      setFileSecurityW: () => {
        writes++
        return setError ? 0 : 1
      },
      getLastError: () => setError,
    }),
    toNamespacedPath: (p) => p,
    win32Error: (_name, code) => Object.assign(new Error('native failure'), { win32Code: code }),
  })
  vm.runInContext(patchText(patch.edits[0].from, patch), context)
  for (const p of [unc, '//server/share/file', String.raw`\\?\UNC\server\share\file`]) {
    assert.equal(context.companyFsIsUnc(p), true, p)
    reads = writes = 0
    await context.copyFileDaclWin32(p, unc)
    assert.equal(reads + writes, 0, p)
  }
  for (const p of [String.raw`C:\file`, String.raw`\\?\C:\file`, String.raw`\\.\C:\file`, '\\\\server', '', undefined]) {
    assert.equal(context.companyFsIsUnc(p), false, String(p))
    if (typeof p !== 'string' || !p) continue
    for (const pair of [[p, p], [p, unc], [unc, p]]) {
      reads = writes = setError = 0
      readError = undefined
      await context.copyFileDaclWin32(...pair)
      assert.equal(reads, 1, pair.join(' → '))
      assert.equal(writes, 1, pair.join(' → '))
      for (const code of [5, 32]) {
        setError = code
        await assert.rejects(context.copyFileDaclWin32(...pair), (e) => e.win32Code === code)
      }
      setError = 0
      for (const error of [Object.assign(new Error('read denied'), { code: 'EACCES' }), Object.assign(new Error('read denied'), { win32Code: 5 })]) {
        readError = error
        await assert.rejects(context.copyFileDaclWin32(...pair), (e) => e === error)
      }
    }
  }
})

test('sandbox-linux-cifs：SMB/CIFS 工作区拒绝 workspace-write，探测失败也拒绝，只读与非 Linux 不探测', () => {
  const policy = { mode: 'workspace-write', workspaceRoot: '/mnt/team' }
  for (const type of [0x517bn, 0xff534d42n, 0xfe534d42n, BigInt.asIntN(32, 0xff534d42n)]) {
    assert.throws(() => companyAssertLinuxWorkspace(policy, 'linux', () => ({ type })), { code: 'COMPANY_WORKSPACE_NOT_LOCAL' }, String(type))
  }
  for (const type of [0xef53n, 0x9123683en, 0x794c7630n]) companyAssertLinuxWorkspace(policy, 'linux', () => ({ type }))
  for (const response of [undefined, {}, { type: 'cifs' }, { type: 0xff534d42 }]) {
    assert.throws(() => companyAssertLinuxWorkspace(policy, 'linux', () => response), { code: 'COMPANY_WORKSPACE_PROBE_FAILED' })
  }
  const noProbe = () => {
    throw new Error('must not probe')
  }
  assert.throws(() => companyAssertLinuxWorkspace(policy, 'linux', noProbe), { code: 'COMPANY_WORKSPACE_PROBE_FAILED' })
  assert.throws(() => companyAssertLinuxWorkspace({ ...policy, workspaceRoot: 'relative' }, 'linux', noProbe), { code: 'COMPANY_WORKSPACE_PROBE_FAILED' })
  for (const mode of ['read-only', 'danger-full-access']) companyAssertLinuxWorkspace({ ...policy, mode }, 'linux', noProbe)
  for (const platform of ['win32', 'darwin']) companyAssertLinuxWorkspace(policy, platform, noProbe)
})

test('sandbox-linux-cifs：Linux 上真实 statfs 放行本地目录，不存在的根按探测失败拒绝', { skip: process.platform !== 'linux' && '只在 Linux 上跑' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-cifs-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const policy = { mode: 'workspace-write', workspaceRoot: dir }
  companyAssertLinuxWorkspace(policy)
  assert.throws(() => companyAssertLinuxWorkspace({ ...policy, workspaceRoot: path.join(dir, 'absent') }), { code: 'COMPANY_WORKSPACE_PROBE_FAILED' })
  if (process.env.DESK_TEST_CIFS_ROOT) {
    assert.throws(() => companyAssertLinuxWorkspace({ ...policy, workspaceRoot: process.env.DESK_TEST_CIFS_ROOT }), { code: 'COMPANY_WORKSPACE_NOT_LOCAL' })
  }
})

// 0.2.2-rc.5 的 confine 形状（节选）：async、带 signal；配置 runnerCommand 与自选 runner 两条路。
const SANDBOX_022_CONFINE =
  'import { spawnSync } from "node:child_process";\n' +
  'import { existsSync, mkdtempSync, rmSync } from "node:fs";\n' +
  'class Sandbox {\n' +
  '\tasync confine(argv, policy, signal) {\n' +
  '\t\tsignal?.throwIfAborted();\n' +
  '\t\tif (this.runnerCommand !== void 0) return bwrapProfileArgs(policy);\n' +
  '\t\treturn this.selectRunner(policy.mode);\n' +
  '\t}\n' +
  '}\n'

test('sandbox-linux-cifs：0.2.2 async confine 进门先探测，两条 runner 路都在拒绝之后', async () => {
  const patched = patchText(SANDBOX_022_CONFINE, patchNamed('company-sandbox-linux-cifs-v1'))
  assert.match(patched, /^import \{ spawnSync \} from "node:child_process";\nimport \{ statfsSync as companyStatfsSync \} from "node:fs";\n/)
  assert.match(patched, /async confine\(argv, policy, signal\) \{\n\t\tcompanyAssertLinuxWorkspace\(policy\);\n\t\tsignal\?\.throwIfAborted\(\);/)
  // vm 脚本里不能有 import：去掉 import 行，companyStatfsSync 由上下文提供。
  const body = patched.split('\n').filter((line) => !line.startsWith('import ')).join('\n') + '\nglobalThis.Sandbox = Sandbox;\n'
  for (const custom of [false, true]) {
    for (const type of [0xef53n, 0xff534d42n, 0xfe534d42n, 0x517bn]) {
      const calls = []
      const context = vm.createContext({
        process: { platform: 'linux' },
        companyStatfsSync: () => {
          calls.push('statfs')
          return { type }
        },
        bwrapProfileArgs: () => {
          calls.push('profile')
          return []
        },
      })
      vm.runInContext(body, context)
      const sandbox = new context.Sandbox()
      Object.defineProperty(sandbox, 'runnerCommand', {
        get() {
          calls.push('runner')
          return custom ? ['custom'] : undefined
        },
      })
      sandbox.selectRunner = () => {
        calls.push('select')
        return 'bwrap'
      }
      const policy = { mode: 'workspace-write', workspaceRoot: '/mnt/team' }
      if (type === 0xef53n) {
        await sandbox.confine(['true'], policy)
        assert.deepEqual(calls, ['statfs', 'runner', custom ? 'profile' : 'select'])
      } else {
        await assert.rejects(sandbox.confine(['true'], policy), { code: 'COMPANY_WORKSPACE_NOT_LOCAL' })
        assert.deepEqual(calls, ['statfs'])
      }
    }
  }
})

test('v1 → v2 升级：打过旧补丁的前缀先精确退回官方源码再打新版，结果与全新打补丁一致且幂等', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-patch-supersede-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const kernelRoot = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(kernelRoot, { recursive: true })
  writeMarkedKernelExceptLive(kernelRoot)
  const acl = patchNamed('company-fs-unc-acl-v2')
  const search = patchNamed('company-glob-missing-root-v2')
  const cases = [
    { patch: acl, base: acl.edits[0].from },
    { patch: search, base: SEARCH_FIXTURE },
  ]
  for (const c of cases) {
    c.target = path.join(kernelRoot, c.patch.file)
    c.others = CODE_PATCHES.filter((p) => p.file === c.patch.file && p !== c.patch)
      .map((p) => `// ${p.mark}\n`)
      .join('')
    fs.writeFileSync(c.target, legacyText(c.base, c.patch.supersedes) + c.others)
  }
  const before = missingPatches(kernelRoot)
  for (const c of cases) assert.ok(before.includes(`${c.patch.file}|${c.patch.mark}`), `旧前缀应判为缺 ${c.patch.mark}`)
  const lines = []
  applyKernelPatches({ kernelRoot, skillsDir: path.join(dir, 'skills'), log: (line) => lines.push(line) })
  assert.deepEqual(missingPatches(kernelRoot), [])
  for (const c of cases) {
    const text = fs.readFileSync(c.target, 'utf8')
    assert.equal(text, patchText(c.base + c.others, c.patch))
    assert.equal(text.includes(c.patch.supersedes.mark), false)
    assert.ok(lines.some((line) => line.endsWith(`|migrated ${c.patch.supersedes.mark}→${c.patch.mark}`)), c.patch.mark)
    c.after = text
  }
  applyKernelPatches({ kernelRoot, skillsDir: path.join(dir, 'skills'), log: () => {} })
  for (const c of cases) assert.equal(fs.readFileSync(c.target, 'utf8'), c.after)
})

test('v1 → v2 升级：旧补丁形状对不上就拒绝（legacy-patch），文件原样不动', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-patch-legacy-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const kernelRoot = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(kernelRoot, { recursive: true })
  writeMarkedKernelExceptLive(kernelRoot)
  const search = patchNamed('company-glob-missing-root-v2')
  const target = path.join(kernelRoot, search.file)
  const v1 = legacyText(SEARCH_FIXTURE, search.supersedes)
  for (const tampered of [
    SEARCH_FIXTURE + '// company-glob-missing-root-v1\n',
    v1.replace('companyRgPathMissing(stderr.text)', 'companyRgPathMissing(stderr.text) || true'),
    v1 + search.supersedes.append,
  ]) {
    fs.writeFileSync(target, tampered)
    assert.throws(
      () => applyKernelPatches({ kernelRoot, skillsDir: path.join(dir, 'skills'), log: () => {} }),
      (err) => err instanceof KernelPatchError && err.code === 'legacy-patch' && err.detail.includes('install-kernel.mjs --force'),
    )
    assert.equal(fs.readFileSync(target, 'utf8'), tampered)
  }
})
