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
