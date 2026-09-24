/**
 * 内核补丁集：把固定版本的 @deepseek-ai/dsh 前缀「整形」成公司桌面能用的样子。
 *
 * 源自 TDHarness-coding（MIT）的 patches/apply-kernel-patches.js，已内置到本仓库，不再需要那个仓库。
 *
 * 为什么是锚点式编辑而不是整文件覆盖：整文件覆盖会在下次升内核时悄悄吃掉上游修复而没人知道；
 * 锚点对不上就是硬失败，逼着升内核的人重新审一遍补丁。
 *
 * 每个补丁在目标文件末尾追加一个 mark 注释；再次运行看到 mark 就跳过（幂等）。
 * 只对你自己拥有的前缀运行（npm install -g --prefix 之后、dsh 用它之前），绝不指向正在运行的 node_modules。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export class KernelPatchError extends Error {
  constructor(code, detail) {
    super(`${code}|${detail}`)
    this.code = code
    this.detail = detail
  }
}

const SEE = 'company patch; see company-desk/scripts/kernel/patches.mjs'

/** 一条编辑的锚点变体：升内核后源码改写时并列旧/新 from，恰好命中一条才套用。 */
export function editVariants(edit) {
  if (Array.isArray(edit.variants) && edit.variants.length) return edit.variants
  return [{ from: edit.from, to: edit.to }]
}

export function applyEdit(text, edit, file = '') {
  const variants = editVariants(edit)
  const scored = variants.map((v, i) => ({ i, v, n: text.split(v.from).length - 1 }))
  const matched = scored.filter((s) => s.n === 1)
  if (matched.length !== 1) {
    const got = scored.length === 1 ? String(scored[0].n) : scored.map((s) => `v${s.i}=${s.n}`).join(',')
    throw new KernelPatchError('anchor-not-unique', `${file}|${edit.name}|expected=1|got=${got}|内核升过版本？请对着新源码重审这条补丁`)
  }
  return text.replace(matched[0].v.from, matched[0].v.to)
}

const MARK = 'company-sandbox-local-unc-v1'
const SKILL_MARK = 'company-skill-custom-trusted-v1'

const HELPERS = `

// --- ${MARK} (${SEE}) ---
function companyWorkspaceIsNetworkPath(p) {
	return typeof p === "string" && (p.startsWith("\\\\\\\\") || p.startsWith("//"));
}
function companyWorkspaceHint(workspaceRoot) {
	return "workspace-write confinement is granted by an NTFS ACL on the volume that holds the workspace. "
		+ "\\"" + workspaceRoot + "\\" is not on a local volume, so there is no volume here to grant on and this "
		+ "sandbox cannot confine anything on it. Put the agent workspace on a local disk and mount the company "
		+ "share separately: the share is access-controlled on the server (per-person SMB account plus per-dept "
		+ "NTFS ACL), not by this sandbox.";
}
function companyAssertLocalWorkspace(workspaceRoot) {
	if (!companyWorkspaceIsNetworkPath(workspaceRoot)) return;
	const err = new Error("sandbox-local: refusing workspace-write on a network workspace. " + companyWorkspaceHint(workspaceRoot));
	err.code = "COMPANY_WORKSPACE_NOT_LOCAL";
	throw err;
}
function companyGrantError(workspaceRoot, cause) {
	// Mapped network drives look like a normal drive letter, so the path check
	// above cannot catch them; they surface here instead. State the hint as a
	// likely cause rather than a verdict, and keep the original error.
	const err = new Error(
		"sandbox-local: windows-acl workspace grant failed for \\"" + workspaceRoot + "\\". "
		+ "If this workspace is on a mapped network drive or a UNC path, that is the likely cause: "
		+ companyWorkspaceHint(workspaceRoot),
		{ cause }
	);
	err.code = "COMPANY_WORKSPACE_GRANT_FAILED";
	return err;
}
`

/** 代码补丁：{ file, mark, already?, append, edits[{ name, from, to }] } */
export const CODE_PATCHES = [
  {
    file: path.join('node_modules', '@deepseek-ai', 'dsh-client-ui-chat', 'lib', 'client.js'),
    mark: 'company-assistant-markdown-slot-v1',
    append: '\n// --- company-assistant-markdown-slot-v1 (' + SEE + ') ---\n',
    edits: [
      {
        name: 'markdown-render-prop',
        from: 'function AssistantMarkdown({ blocks, streaming, interrupted, renderMessageImages,',
        to: 'function AssistantMarkdown({ blocks, streaming, interrupted, renderMarkdown, renderMessageImages,',
      },
      {
        name: 'assistant-markdown-slot-render',
        variants: [
          {
            from: '\t\t\t\t\t\trendered.push((0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, {\n\t\t\t\t\t\t\ttext: block.text,\n\t\t\t\t\t\t\tstreaming,\n\t\t\t\t\t\t\tlabels,\n\t\t\t\t\t\t\tfileMentions: mentions\n\t\t\t\t\t\t}, i));',
            to: '\t\t\t\t\t\trendered.push((0, react_jsx_runtime.jsx)(react.Fragment, { children: renderMarkdown({ text: block.text, streaming, labels, fileMentions: mentions }) }, i));',
          },
          {
            // 0.1.5-rc.1：MarkdownText 增加 pathImages，本地路径图走官方 resolver。
            from: '\t\t\t\t\t\trendered.push((0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, {\n\t\t\t\t\t\t\ttext: block.text,\n\t\t\t\t\t\t\tstreaming,\n\t\t\t\t\t\t\tlabels,\n\t\t\t\t\t\t\tfileMentions: mentions,\n\t\t\t\t\t\t\tpathImages\n\t\t\t\t\t\t}, i));',
            to: '\t\t\t\t\t\trendered.push((0, react_jsx_runtime.jsx)(react.Fragment, { children: renderMarkdown({ text: block.text, streaming, labels, fileMentions: mentions, pathImages }) }, i));',
          },
        ],
      },
      {
        name: 'assistant-node-render-slot',
        variants: [
          {
            from: 'function AssistantNodeView({ node, useTurnData,',
            to: 'function AssistantNodeView({ node, renderSlot, useTurnData,',
          },
          {
            // 0.1.7-rc.1：过程组把 groupPart 插到 node 后面，renderSlot 仍要在组件参数里。
            from: 'function AssistantNodeView({ node, groupPart, useDisclosure, useTurnData,',
            to: 'function AssistantNodeView({ node, renderSlot, groupPart, useDisclosure, useTurnData,',
          },
        ],
      },
      {
        name: 'assistant-node-markdown-fallback',
        variants: [
          {
            // 锚点含 streaming 行：0.1.7 在 blocks 后是 groupPart，不能只用公共前缀。
            from: 'return (0, react_jsx_runtime.jsx)(AssistantMarkdown, {\n\t\t\t\tblocks: data.blocks,\n\t\t\t\tstreaming: data.status === "running",',
            to: 'return (0, react_jsx_runtime.jsx)(AssistantMarkdown, {\n\t\t\t\trenderMarkdown: (props) => renderSlot("conversation.assistant.markdown", props, { fallback: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, props) }),\n\t\t\t\tblocks: data.blocks,\n\t\t\t\tstreaming: data.status === "running",',
          },
          {
            // 0.1.7-rc.1：AssistantMarkdown 先收 groupPart。锚点必须长过 0.1.5 那条，
            // 否则 `blocks: data.blocks,` 是公共前缀，两条变体同时命中。
            from: 'return (0, react_jsx_runtime.jsx)(AssistantMarkdown, {\n\t\t\t\tblocks: data.blocks,\n\t\t\t\tgroupPart,\n\t\t\t\tuseDisclosure,',
            to: 'return (0, react_jsx_runtime.jsx)(AssistantMarkdown, {\n\t\t\t\trenderMarkdown: (props) => renderSlot("conversation.assistant.markdown", props, { fallback: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, props) }),\n\t\t\t\tblocks: data.blocks,\n\t\t\t\tgroupPart,\n\t\t\t\tuseDisclosure,',
          },
        ],
      },
      {
        name: 'assistant-markdown-child-slot',
        variants: [
          {
            from: 'key: "assistant-step",\n\t\t\t\tlocale: NS\n\t\t\t}, AssistantNodeView)',
            to: 'key: "assistant-step",\n\t\t\t\tlocale: NS,\n\t\t\t\tchildren: { "conversation.assistant.markdown": { kind: "single", scope: "session" } }\n\t\t\t}, AssistantNodeView)',
          },
          {
            // 0.1.7-rc.1：assistant-step 已有 inject（presentation hook），子槽跟在 inject 后面声明。
            from: 'key: "assistant-step",\n\t\t\t\tlocale: NS,\n\t\t\t\tinject: () => ({ hooks: { presentation } })\n\t\t\t}, AssistantNodeView)',
            to: 'key: "assistant-step",\n\t\t\t\tlocale: NS,\n\t\t\t\tinject: () => ({ hooks: { presentation } }),\n\t\t\t\tchildren: { "conversation.assistant.markdown": { kind: "single", scope: "session" } }\n\t\t\t}, AssistantNodeView)',
          },
        ],
      },
    ],
  },
  {
    file: path.join('node_modules', '@deepseek-ai', 'dsh-sandbox-local', 'lib', 'index.js'),
    mark: MARK,
    append: HELPERS,
    edits: [
      {
        name: 'materializeAclGrant-precheck',
        // 锚点故意包含行尾换行：没有它，上游只在锚点行末尾追加内容时仍会匹配，补丁就会落到从未审过的源码上。
        from: '\tmaterializeAclGrant(sessionId, workspaceRoot) {\n' + '\t\tassertTempRootOutsideWorkspace(workspaceRoot, tmpdir());\n',
        to: '\tmaterializeAclGrant(sessionId, workspaceRoot) {\n' + '\t\tcompanyAssertLocalWorkspace(workspaceRoot);\n' + '\t\tassertTempRootOutsideWorkspace(workspaceRoot, tmpdir());\n',
      },
      {
        name: 'workspace-grant-diagnosis',
        from: '\t\t\t\tthrow error;\n' + '\t\t\t}\n' + '\t\t\tthis.workspaceGrants.set(workspaceRoot, grant);\n',
        to: '\t\t\t\tthrow companyGrantError(workspaceRoot, error);\n' + '\t\t\t}\n' + '\t\t\tthis.workspaceGrants.set(workspaceRoot, grant);\n',
      },
    ],
  },
  {
    // customSkillDirs 由预设/公司盘提供。插件默认通过 ctx.fs（工作区沙箱）列目录：工作区以外的路径是 FS_NOT_FOUND，
    // 技能目录就一直是空的。bundled 根已经设了 trustedHost 走 Node fs；custom 根也要一样。
    file: path.join('node_modules', '@deepseek-ai', 'dsh-skill-filesystem', 'lib', 'index.js'),
    mark: SKILL_MARK,
    append: '\n// --- ' + SKILL_MARK + ' (' + SEE + ') ---\n',
    edits: [
      {
        name: 'custom-dirs-trusted-host',
        from: '\t\troots.push(...this.customSkillDirs.map((path) => ({\n' + '\t\t\tpath,\n' + '\t\t\tsource: "custom",\n' + '\t\t\trank: CUSTOM_RANK\n' + '\t\t})));\n',
        to: '\t\troots.push(...this.customSkillDirs.map((path) => ({\n' + '\t\t\tpath,\n' + '\t\t\tsource: "custom",\n' + '\t\t\trank: CUSTOM_RANK,\n' + '\t\t\ttrustedHost: true\n' + '\t\t})));\n',
      },
    ],
  },
  {
    // list() 能看到 trustedHost 的 custom 根，但 get() 仍通过 ctx.fs 读，于是模型报 skill "..." is unknown。
    file: path.join('node_modules', '@deepseek-ai', 'dsh-skill-filesystem', 'lib', 'index.js'),
    mark: 'company-skill-get-custom-trusted-v1',
    append: '\n// --- company-skill-get-custom-trusted-v1 (' + SEE + ') ---\n',
    edits: [
      {
        name: 'get-custom-trusted-host',
        from: '\t\tconst parsed = await parseSkillFile(locator.path, this.ctx, options.signal, candidate.source === "bundled");\n',
        to: '\t\tconst parsed = await parseSkillFile(locator.path, this.ctx, options.signal, candidate.source === "bundled" || candidate.source === "custom");\n',
      },
    ],
  },
  {
    // 一个读不了的 custom 根（SMB EACCES）曾把整个 list() 抛出去，连 bundled / 工作区技能也一起没了。
    file: path.join('node_modules', '@deepseek-ai', 'dsh-skill-filesystem', 'lib', 'index.js'),
    mark: 'company-skill-root-eacces-v1',
    append: '\n// --- company-skill-root-eacces-v1 (' + SEE + ') ---\n',
    edits: [
      {
        name: 'node-list-eacces-empty',
        from:
          '\t} catch (error) {\n' +
          '\t\t/* v8 ignore else -- Native non-absence directory failures are provider-dependent; the ctx.fs path pins incomplete discovery. */\n' +
          '\t\tif (isAbsentSkillPathError(error)) return [];\n' +
          '\t\t/* v8 ignore next -- Same native error branch as above. */\n' +
          '\t\tthrow error;\n' +
          '\t}\n',
        to:
          '\t} catch (error) {\n' +
          '\t\t/* v8 ignore else -- Native non-absence directory failures are provider-dependent; the ctx.fs path pins incomplete discovery. */\n' +
          '\t\tif (isAbsentSkillPathError(error) || hasErrorCode(error, "EACCES") || hasErrorCode(error, "EPERM")) return [];\n' +
          '\t\t/* v8 ignore next -- Same native error branch as above. */\n' +
          '\t\tthrow error;\n' +
          '\t}\n',
      },
    ],
  },
  {
    // 公司 SMB（UNC）收不了复制过来的 DACL：官方写文件先落临时文件再 SetFileSecurityW，\\host\share 上 Win32 5
    // 会让整个 Edit/Write 失败，尽管字节已经写进去了。UNC 上跳过 ACL 复制，ACCESS_DENIED 视为「继承共享的」。
    file: path.join('node_modules', '@deepseek-ai', 'dsh-fs-local', 'lib', 'index.js'),
    mark: 'company-fs-unc-acl-v1',
    append:
      '\n// --- company-fs-unc-acl-v1 (' +
      SEE +
      ') ---\n' +
      'function companyFsIsUnc(p) {\n' +
      '\tconst s = String(p || "").replace(/\\//g, "\\\\");\n' +
      '\treturn s.startsWith("\\\\\\\\") || s.startsWith("\\\\\\\\?\\\\UNC\\\\");\n' +
      '}\n',
    edits: [
      {
        name: 'copy-dacl-unc-skip',
        from:
          'async function copyFileDaclWin32(source, destination) {\n' +
          '\tconst descriptor = await readFileDaclWin32(source);\n' +
          '\tconst api = await win32();\n' +
          '\tif (api.setFileSecurityW(toNamespacedPath(destination), 2147483652, descriptor) === 0) throw win32Error("SetFileSecurityW", api.getLastError(), destination);\n' +
          '}\n',
        to:
          'async function copyFileDaclWin32(source, destination) {\n' +
          '\tif (companyFsIsUnc(source) || companyFsIsUnc(destination)) return;\n' +
          '\ttry {\n' +
          '\t\tconst descriptor = await readFileDaclWin32(source);\n' +
          '\t\tconst api = await win32();\n' +
          '\t\tif (api.setFileSecurityW(toNamespacedPath(destination), 2147483652, descriptor) === 0) {\n' +
          '\t\t\tconst code = api.getLastError();\n' +
          '\t\t\tif (code === ERROR_ACCESS_DENIED) return;\n' +
          '\t\t\tthrow win32Error("SetFileSecurityW", code, destination);\n' +
          '\t\t}\n' +
          '\t} catch (error) {\n' +
          '\t\tif (error && (error.win32Code === ERROR_ACCESS_DENIED || error.code === "EACCES")) return;\n' +
          '\t\tthrow error;\n' +
          '\t}\n' +
          '}\n',
      },
    ],
  },
  {
    // 官方覆盖已有文件用 ReplaceFileW，公司 SMB 常返回 Win32 5：老文件 Edit 失败但新建正常。UNC 上改用 rename，EACCES 也回退 rename。
    file: path.join('node_modules', '@deepseek-ai', 'dsh-fs-local', 'lib', 'index.js'),
    mark: 'company-fs-unc-replace-v1',
    append: '\n// --- company-fs-unc-replace-v1 (' + SEE + ') ---\n',
    edits: [
      {
        name: 'unc-skip-replacefilew',
        from:
          '\t\telse if (platform === "win32" && mode !== void 0) try {\n' +
          '\t\t\tawait replaceFile(absolutePath, tempPath);\n' +
          '\t\t} catch (error) {\n' +
          '\t\t\tif (!isENOENT(error)) throw error;\n' +
          '\t\t\tawait rename(tempPath, absolutePath);\n' +
          '\t\t}\n',
        to:
          '\t\telse if (platform === "win32" && mode !== void 0) try {\n' +
          '\t\t\tconst unc = String(absolutePath || "").replace(/\\//g, "\\\\").startsWith("\\\\\\\\");\n' +
          '\t\t\tif (unc) await rename(tempPath, absolutePath);\n' +
          '\t\t\telse await replaceFile(absolutePath, tempPath);\n' +
          '\t\t} catch (error) {\n' +
          '\t\t\tif (!isENOENT(error) && !(error && (error.code === "EACCES" || error.win32Code === 5))) throw error;\n' +
          '\t\t\tawait rename(tempPath, absolutePath);\n' +
          '\t\t}\n',
      },
    ],
  },
  {
    // 模型重试时 resume 一个已经 armed 的 goal，官方抛 GOAL_INVALID_TRANSITION 直接断掉这一轮。改成 no-op。
    file: path.join('node_modules', '@deepseek-ai', 'dsh-goal', 'lib', 'index.js'),
    mark: 'company-goal-resume-armed-v1',
    append: '\n// --- company-goal-resume-armed-v1 (' + SEE + ') ---\n',
    edits: [
      {
        name: 'resume-already-armed-noop',
        variants: [
          {
            from: '\t\t\tif (current.phase === "active" && cache.activation === "armed") throw new GoalError(`goal "${current.id}" is already active and armed`, "GOAL_INVALID_TRANSITION");\n',
            to:
              '\t\t\tif (current.phase === "active" && cache.activation === "armed") {\n' +
              '\t\t\t\tconst view = this.view(cache);\n' +
              '\t\t\t\tif (view === void 0) throw new GoalError(`goal "${current.id}" is already active and armed`, "GOAL_INVALID_TRANSITION");\n' +
              '\t\t\t\treturn view;\n' +
              '\t\t\t}\n',
          },
          {
            // 0.1.2-rc.1：cache → [state, runtime]
            from: '\t\t\tif (current.phase === "active" && runtime.activation === "armed") throw new GoalError(`goal "${current.id}" is already active and armed`, "GOAL_INVALID_TRANSITION");\n',
            to:
              '\t\t\tif (current.phase === "active" && runtime.activation === "armed") {\n' +
              '\t\t\t\tconst view = this.view(currentState, runtime);\n' +
              '\t\t\t\tif (view === void 0) throw new GoalError(`goal "${current.id}" is already active and armed`, "GOAL_INVALID_TRANSITION");\n' +
              '\t\t\t\treturn view;\n' +
              '\t\t\t}\n',
          },
        ],
      },
    ],
  },
  {
    // Node 22 的 fs.symlinkSync(..., "junction") 在部分构建上仍走 CreateSymbolicLinkW，没开开发者模式就 EPERM。
    // cmd mklink /J 是真正的 NTFS junction，不需要这个特权。
    // 0.1.7-rc.1 起 dsh-app-boot 不再调用 symlinkSync 建 junction（安装回退改走模块代理），
    // 两条锚点都对不上时跳过：没有调用点就没有 EPERM。公司自己的 linkJunction 不在这个文件里。
    file: path.join('node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'),
    optional: true,
    mark: 'company-win-junction-mklink-v3',
    already: ['company-win-junction-mklink-v2', 'company-win-junction-mklink-v3'],
    append: '\n// --- company-win-junction-mklink-v3 (' + SEE + ') ---\n',
    edits: [
      {
        name: 'win-junction-mklink',
        variants: [
          {
            from:
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
              '}\n',
            to:
              'function companyWinJunction(link, target) {\n' +
              '\tconst { spawnSync } = createRequire(import.meta.url)("node:child_process");\n' +
              '\tmkdirSync(dirname(link), { recursive: true });\n' +
              '\tconst r = spawnSync("cmd.exe", ["/c", "mklink", "/J", link, target], { encoding: "utf8", windowsHide: true });\n' +
              '\treturn r.status === 0;\n' +
              '}\n' +
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
              '\tif (process.platform === "win32") {\n' +
              '\t\tif (companyWinJunction(link, target)) return;\n' +
              '\t\tthrow new Error("dsh: win-junction-failed " + link + " -> " + target);\n' +
              '\t}\n' +
              '\ttry {\n' +
              '\t\tsymlinkSync(target, link, "junction");\n' +
              '\t} catch (error) {\n' +
              '\t\tif (error.code === "EEXIST" && readlinkSync(link) === target) return;\n' +
              '\t\t/* v8 ignore next 4 */\n' +
              '\t\tif (error.code !== "EEXIST" || !lstatSync(link).isSymbolicLink() || readlinkSync(link) !== target) throw error;\n' +
              '\t}\n' +
              '}\n',
          },
          {
            from:
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
              '}\n',
            to:
              'function companyWinJunction(link, target) {\n' +
              '\tconst { spawnSync } = createRequire(import.meta.url)("node:child_process");\n' +
              '\tmkdirSync(dirname(link), { recursive: true });\n' +
              '\tconst r = spawnSync("cmd.exe", ["/c", "mklink", "/J", link, target], { encoding: "utf8", windowsHide: true });\n' +
              '\treturn r.status === 0;\n' +
              '}\n' +
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
              '\tif (process.platform === "win32") {\n' +
              '\t\tif (companyWinJunction(link, target)) return;\n' +
              '\t\tthrow new Error("dsh: win-junction-failed " + link + " -> " + target);\n' +
              '\t}\n' +
              '\ttry {\n' +
              '\t\tsymlinkSync(target, link, "junction");\n' +
              '\t} catch (error) {\n' +
              '\t\t/* v8 ignore next 4 */\n' +
              '\t\tif (error.code !== "EEXIST" || !lstatSync(link).isSymbolicLink() || !symlinkPointsTo(link, target)) throw error;\n' +
              '\t}\n' +
              '}\n',
          },
        ],
      },
    ],
  },
  {
    // cmd.exe 不接受 UNC 作为当前目录；桌面若从公司共享目录启动，mklink 会继承这个 cwd 而返回 1。
    // 只在 v3 已经把 spawnSync("mklink") 写进文件之后才有锚点；0.1.7 跳过 v3 时这里同样跳过。
    file: path.join('node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'),
    optional: true,
    mark: 'company-win-junction-mklink-v4',
    already: ['company-win-junction-mklink-v4'],
    append: '\n// --- company-win-junction-mklink-v4 (' + SEE + ') ---\n',
    edits: [
      {
        name: 'win-junction-mklink-local-cwd',
        from: '\tconst r = spawnSync("cmd.exe", ["/c", "mklink", "/J", link, target], { encoding: "utf8", windowsHide: true });\n',
        to: '\tconst r = spawnSync("cmd.exe", ["/c", "mklink", "/J", link, target], { encoding: "utf8", windowsHide: true, cwd: process.env.SystemRoot || "C:\\\\Windows" });\n',
      },
    ],
  },
  {
    // rg 退出码 2 + "IO error ... os error 2" 表示搜索根不存在（断掉的 junction、残留前缀）。官方映射为硬失败；改为空结果让模型继续。
    file: path.join('node_modules', '@deepseek-ai', 'dsh-tool-fs-search', 'lib', 'index.js'),
    mark: 'company-glob-missing-root-v1',
    append:
      '\n// --- company-glob-missing-root-v1 (' +
      SEE +
      ') ---\n' +
      'function companyRgPathMissing(stderr) {\n' +
      '\tconst t = String(stderr || "");\n' +
      '\treturn /IO error/i.test(t) && (/os error 2/i.test(t) || t.includes("\\u7cfb\\u7edf\\u627e\\u4e0d\\u5230\\u6307\\u5b9a\\u7684\\u6587\\u4ef6") || /cannot find the (file|path)/i.test(t));\n' +
      '}\n',
    edits: [
      {
        name: 'rg-missing-root-empty',
        from: '\tif (outcome.exitCode !== 0 && outcome.exitCode !== 1) throw classifyRunFailure(toolName, outcome.exitCode, stderr.text, stderr.lossy);\n',
        to:
          '\tif (outcome.exitCode !== 0 && outcome.exitCode !== 1) {\n' +
          '\t\tif (companyRgPathMissing(stderr.text)) return {\n' +
          '\t\t\tstdout: "",\n' +
          '\t\t\tnoMatches: true,\n' +
          '\t\t\tworkdir\n' +
          '\t\t};\n' +
          '\t\tthrow classifyRunFailure(toolName, outcome.exitCode, stderr.text, stderr.lossy);\n' +
          '\t}\n',
      },
    ],
  },
  {
    // 官方新会话落盘用 fs.link(tmp, final)。macOS smbfs 不支持硬链接（ENOTSUP）；同卷 rename 可以。
    // 落盘成功后的目录 fsync 也可能 ENOTSUP，一并吞掉。
    file: path.join('node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'index.js'),
    mark: 'company-session-smbfs-rename-v1',
    append: '\n// --- company-session-smbfs-rename-v1 (' + SEE + ') ---\n',
    edits: [
      {
        name: 'import-rename',
        variants: [
          {
            from: 'import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from "node:fs/promises";\n',
            to: 'import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, truncate } from "node:fs/promises";\n',
          },
          {
            // 0.1.3 的会话锁增加了 lstat；保留该导入。
            from: 'import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from "node:fs/promises";\n',
            to: 'import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, truncate } from "node:fs/promises";\n',
          },
        ],
      },
      {
        name: 'link-fallback-rename',
        from:
          '\t\tlet linked = false;\n' +
          '\t\ttry {\n' +
          '\t\t\tawait link(tmp, finalPath);\n' +
          '\t\t\tlinked = true;\n' +
          '\t\t} finally {\n' +
          '\t\t\t/* v8 ignore next -- link failure is the TOCTOU/IO race guarded above; not reachable in test */\n' +
          '\t\t\tif (!linked) await rm(tmp, { force: true });\n' +
          '\t\t}\n',
        to:
          '\t\tlet linked = false;\n' +
          '\t\ttry {\n' +
          '\t\t\ttry {\n' +
          '\t\t\t\tawait link(tmp, finalPath);\n' +
          '\t\t\t} catch (error) {\n' +
          '\t\t\t\tif (error && (error.code === "ENOTSUP" || error.code === "EXDEV")) {\n' +
          '\t\t\t\t\tawait rename(tmp, finalPath);\n' +
          '\t\t\t\t} else throw error;\n' +
          '\t\t\t}\n' +
          '\t\t\tlinked = true;\n' +
          '\t\t} finally {\n' +
          '\t\t\t/* v8 ignore next -- link failure is the TOCTOU/IO race guarded above; not reachable in test */\n' +
          '\t\t\tif (!linked) await rm(tmp, { force: true });\n' +
          '\t\t}\n',
      },
      {
        name: 'syncdir-enotsup',
        from:
          '\tasync syncDirPosix(dir) {\n' +
          '\t\tconst handle = await open(dir, "r");\n' +
          '\t\ttry {\n' +
          '\t\t\tawait handle.sync();\n' +
          '\t\t} finally {\n' +
          '\t\t\tawait handle.close();\n' +
          '\t\t}\n' +
          '\t}\n',
        to:
          '\tasync syncDirPosix(dir) {\n' +
          '\t\tconst handle = await open(dir, "r");\n' +
          '\t\ttry {\n' +
          '\t\t\tawait handle.sync();\n' +
          '\t\t} catch (error) {\n' +
          '\t\t\tif (!error || (error.code !== "ENOTSUP" && error.code !== "EINVAL")) throw error;\n' +
          '\t\t} finally {\n' +
          '\t\t\tawait handle.close();\n' +
          '\t\t}\n' +
          '\t}\n',
      },
    ],
  },
  {
    // 0.1.2 去掉了 Session.events，社区预设（梁神 tool-bootstrap）仍读 session.events.length，
    // 第一轮 assemble 就 TypeError → UI 显示 UNKNOWN。别名回 snapshotEvents()。
    file: path.join('node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js'),
    mark: 'company-session-events-alias-v1',
    append: '\n// --- company-session-events-alias-v1 (' + SEE + ') ---\n',
    edits: [
      {
        name: 'session-events-getter',
        from: '\teventAt(seq) {\n' + '\t\treturn this.log[seq];\n' + '\t}\n',
        to:
          '\teventAt(seq) {\n' +
          '\t\treturn this.log[seq];\n' +
          '\t}\n' +
          '\tget events() {\n' +
          '\t\treturn this.snapshotEvents();\n' +
          '\t}\n',
      },
    ],
  },
]

// ---------------------------------------------------------------------------------------------
// 预设（agent.cordis.yml）补丁
// ---------------------------------------------------------------------------------------------

const PRESET_STANDARD = path.join('config', 'agent-presets', 'standard', 'agent.cordis.yml')
const PRESET_CODE = path.join('config', 'agent-presets', 'code', 'agent.cordis.yml')

export function presetCandidates(name) {
  return [
    path.join('config', 'agent-presets', name, 'agent.cordis.yml'),
    path.join('node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', name, 'agent.cordis.yml'),
    // 0.1.7：预设不再随 dsh-agent-presets 发布，改由 web-app bundle 的 patch 插入。
    path.join('node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', `${name}.patch.yml`),
  ]
}

/** 0.1.7 起官方会话预设都在 dsh-web-app/presets/*.patch.yml，不再有 standard/code 两个文件名。 */
export function presetPatchCandidates() {
  return [
    path.join('node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml'),
    path.join('node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'ptc.patch.yml'),
    path.join('node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'cordis.patch.yml'),
  ]
}

/**
 * 补丁目标在两种 npm 布局下都要能找到：
 * - 嵌套：`<kernelRoot>/node_modules/@deepseek-ai/<pkg>`（本机 npm 11）
 * - 提升：`<prefix>/node_modules/@deepseek-ai/<pkg>`（CI 的 Node 22 / npm 10 全局安装）
 * kernelRoot 是 `…/node_modules/@deepseek-ai/dsh`，所以提升位置是上两级再进包名。
 * 两边都有时优先嵌套：Node 解析也是先看包内 node_modules。
 */
function kernelFileCandidates(kernelRoot, rel) {
  const parts = String(rel).split(/[\\/]+/).filter(Boolean)
  const candidates = [path.join(kernelRoot, rel)]
  if (parts[0] !== 'node_modules' || parts.length < 3) return candidates
  const scope = parts[1]
  const name = parts[2]
  const rest = parts.slice(3)
  candidates.push(path.join(kernelRoot, '..', '..', scope, name, ...rest))
  const scopeDir = path.join(kernelRoot, 'node_modules', scope)
  if (fs.existsSync(scopeDir)) {
    for (const parent of fs.readdirSync(scopeDir)) {
      candidates.push(path.join(scopeDir, parent, 'node_modules', scope, name, ...rest))
    }
  }
  return candidates
}

export function resolveKernelFile(kernelRoot, rel) {
  return kernelFileCandidates(kernelRoot, rel).find((p) => fs.existsSync(p)) ?? null
}

function packageVersionOf(file) {
  let dir = path.dirname(file)
  for (let i = 0; i < 6; i++) {
    const pkgPath = path.join(dir, 'package.json')
    if (fs.existsSync(pkgPath)) {
      try {
        return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version ?? null
      } catch {
        return null
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export function resolvePresetRel(kernelRoot, name) {
  for (const rel of presetCandidates(name)) {
    if (resolveKernelFile(kernelRoot, rel)) return rel
  }
  return null
}

export function resolveMarkFile(kernelRoot, entry) {
  const candidates = entry.files ?? [entry.file]
  for (const rel of candidates) {
    const abs = resolveKernelFile(kernelRoot, rel)
    if (abs) return abs
  }
  return null
}

const SKILLS_MARK_V1 = 'company-preset-skills-v1'
const SKILLS_MARK_V2 = 'company-preset-skills-v2'
const SKILLS_TAG = '# company-desk skills root'
const yamlStr = (s) => `'${String(s).replace(/\\/g, '/').replace(/'/g, "''")}'`

/**
 * 要打预设补丁的文件。0.1.2 及以前是 standard（code 可选）；
 * 0.1.7 起 standard/ptc/cordis 都在 dsh-web-app/presets/*.patch.yml。
 */
function presetRels(kernelRoot, legacyName) {
  const modern = presetPatchCandidates().filter((rel) => resolveKernelFile(kernelRoot, rel))
  if (modern.length) return modern
  const legacy = resolvePresetRel(kernelRoot, legacyName)
  return legacy ? [legacy] : []
}

/**
 * 技能根：会话预设的 skill-filesystem 指向公司盘 _shared/skills 的本机镜像。
 * 没有 config 的行整段换上公司目录并关掉官方默认根；已有 customSkillDirs（cordis 预设的官方技能）
 * 只追加公司目录。v2 mark 在路径变化时同步。
 */
function pinPresetSkills(kernelRoot, skillsDir, log, counters) {
  const rels = presetRels(kernelRoot, 'standard')
  if (!rels.length) throw new KernelPatchError('preset-missing', 'standard')
  for (const rel of rels) pinPresetSkillsFile(kernelRoot, rel, skillsDir, log, counters)
}

function pinPresetSkillsFile(kernelRoot, rel, skillsDir, log, counters) {
  const file = resolveKernelFile(kernelRoot, rel)
  let text = fs.readFileSync(file, 'utf8')
  const quoted = yamlStr(skillsDir)
  const tag = SKILLS_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (text.includes(SKILLS_MARK_V2)) {
    const re = new RegExp(`^(\\s*)(bundledSkillDir: |- ).*${tag}$`, 'gm')
    const next = text.replace(re, (m, indent, key) => `${indent}${key}${quoted}   ${SKILLS_TAG}`)
    if (next === text) {
      log(`PATCH_ALREADY=${rel}|${SKILLS_MARK_V2}`)
      counters.skipped++
      return
    }
    fs.writeFileSync(file, next, 'utf8')
    log(`PATCHED=${rel}|skills-root-sync`)
    counters.applied++
    return
  }

  const row = /^([ \t]*)- id: skill-filesystem\n\1  name: '@deepseek-ai\/dsh-skill-filesystem'\n(?:\1  config:\n(?:\1    .*\n)*)?/m.exec(text)
  if (!row) throw new KernelPatchError('preset-anchor', `${rel}|skill-filesystem`)
  const pad = row[1]
  const hasConfig = /\n[ \t]*config:\n/.test(row[0])
  let body
  if (!hasConfig) {
    body =
      `${pad}- id: skill-filesystem\n` +
      `${pad}  name: '@deepseek-ai/dsh-skill-filesystem'\n` +
      `${pad}  config:\n` +
      `${pad}    includeDefaultRoots: false\n` +
      `${pad}    watch: false\n` +
      `${pad}    bundledSkillDir: ${quoted}   ${SKILLS_TAG}\n` +
      `${pad}    customSkillDirs:\n` +
      `${pad}      - ${quoted}   ${SKILLS_TAG}\n`
  } else if (row[0].includes('customSkillDirs:')) {
    body = row[0].replace(/^([ \t]*)customSkillDirs:[ \t]*$/m, (m, indent) => `${m}\n${indent}  - ${quoted}   ${SKILLS_TAG}`)
    if (body === row[0]) throw new KernelPatchError('preset-skills-append', rel)
  } else {
    body = row[0].replace(/\s*$/, '') + `\n${pad}    customSkillDirs:\n${pad}      - ${quoted}   ${SKILLS_TAG}\n`
  }
  const next = text.slice(0, row.index) + body + `# --- ${SKILLS_MARK_V1} ---\n# --- ${SKILLS_MARK_V2} ---\n` + text.slice(row.index + row[0].length)
  fs.writeFileSync(file, next, 'utf8')
  log(`PATCHED=${rel}|preset-skills`)
  counters.applied++
}

/**
 * 宿主 overlay 里 `tool-web.fetch: true` 不会注册模型工具——web_fetch 归会话预设管。
 * 旧预设是 fetch: false，钉成 true 并放宽超时；0.1.7 官方已经是 fetch: true，只补 90s 超时。
 * 没有 tool-web 的预设（minimal）跳过。
 */
function pinPresetFetch(kernelRoot, name, log, counters) {
  const rels = presetRels(kernelRoot, name)
  if (!rels.length) {
    log(`PRESET_FETCH_SKIP=${name}|missing`)
    return
  }
  for (const rel of rels) pinPresetFetchFile(kernelRoot, rel, log, counters)
}

function pinPresetFetchFile(kernelRoot, rel, log, counters) {
  const file = resolveKernelFile(kernelRoot, rel)
  const mark = 'company-preset-web-fetch-v1'
  const mark2 = 'company-preset-web-fetch-v2'
  let text = fs.readFileSync(file, 'utf8')
  if (text.includes(mark2) && text.includes('fetchTimeoutMs: 90000')) {
    log(`PATCH_ALREADY=${rel}|${mark2}`)
    counters.skipped++
    return
  }
  const row = /^([ \t]*)- id: tool-web\n\1  name: '@deepseek-ai\/dsh-tool-web'\n(?:\1  config:\n(?:\1    .*\n)*)?/m.exec(text)
  if (!row) {
    log(`PRESET_FETCH_SKIP=${rel}|no-tool-web`)
    return
  }
  const pad = row[1]
  const body =
    `${pad}- id: tool-web\n` +
    `${pad}  name: '@deepseek-ai/dsh-tool-web'\n` +
    `${pad}  config:\n` +
    `${pad}    fetch: true\n` +
    `${pad}    searchTimeoutMs: 60000\n` +
    `${pad}    fetchTimeoutMs: 90000\n` +
    `# --- ${mark} ---\n# --- ${mark2} ---\n`
  fs.writeFileSync(file, text.slice(0, row.index) + body + text.slice(row.index + row[0].length), 'utf8')
  log(`PATCHED=${rel}|web-fetch`)
  counters.applied++
}

/**
 * 会话侧 agent-instructions 的项目根标记默认只有 [.git]，会从工作区一路向上找到 $HOME/AGENTS.md。
 * 钉成 `.company-root`，指令文件只在公司盘/任务目录范围内生效。
 */
const ANYSEARCH_CLIENT = path.join('..', '..', '@anysearch', 'anysearch-dsh', 'lib', 'client.js')
const ANYSEARCH_FETCH_RETRY_MARK = 'company-anysearch-fetch-retry-v1'

const ANYSEARCH_FETCH_FROM =
  '        const timeoutController = new AbortController();\n' +
  '        const timeout = setTimeout(() => {\n' +
  "            timeoutController.abort(new DOMException('AnySearch HTTP request timed out', 'TimeoutError'));\n" +
  '        }, ANYSEARCH_HTTP_TIMEOUT_MS);\n' +
  '        const requestSignal = signal === undefined\n' +
  '            ? timeoutController.signal\n' +
  '            : AbortSignal.any([signal, timeoutController.signal]);\n' +
  '        let response;\n' +
  '        try {\n' +
  '            response = await fetch(url, {\n' +
  '                method: init.method,\n' +
  "                redirect: 'error',\n" +
  '                headers,\n' +
  '                ...init.body === undefined ? {} : { body: init.body },\n' +
  '                signal: requestSignal,\n' +
  '            });\n' +
  '        }\n' +
  '        catch (error) {\n' +
  '            clearTimeout(timeout);\n' +
  '            if (signal?.aborted === true)\n' +
  '                throw aborted(operation, signal, error);\n' +
  '            if (timeoutController.signal.aborted)\n' +
  '                throw timedOut(operation, error);\n' +
  '            if (isAbortError(error))\n' +
  '                throw aborted(operation, signal, error);\n' +
  '            throw new AnySearchClientError(`AnySearch ${operation} request failed: ${String(error)}`, { operation, cause: error });\n' +
  '        }\n'

const ANYSEARCH_FETCH_TO =
  '        let response;\n' +
  '        let timeoutController;\n' +
  '        let timeout;\n' +
  '        const maxAttempts = 3;\n' +
  '        for (let attempt = 1; ; attempt++) {\n' +
  '            timeoutController = new AbortController();\n' +
  '            timeout = setTimeout(() => {\n' +
  "                timeoutController.abort(new DOMException('AnySearch HTTP request timed out', 'TimeoutError'));\n" +
  '            }, ANYSEARCH_HTTP_TIMEOUT_MS);\n' +
  '            const requestSignal = signal === undefined\n' +
  '                ? timeoutController.signal\n' +
  '                : AbortSignal.any([signal, timeoutController.signal]);\n' +
  '            try {\n' +
  '                response = await fetch(url, {\n' +
  '                    method: init.method,\n' +
  "                    redirect: 'error',\n" +
  '                    headers,\n' +
  '                    ...init.body === undefined ? {} : { body: init.body },\n' +
  '                    signal: requestSignal,\n' +
  '                });\n' +
  '            }\n' +
  '            catch (error) {\n' +
  '                clearTimeout(timeout);\n' +
  '                if (signal?.aborted === true)\n' +
  '                    throw aborted(operation, signal, error);\n' +
  '                if (timeoutController.signal.aborted)\n' +
  '                    throw timedOut(operation, error);\n' +
  '                if (isAbortError(error))\n' +
  '                    throw aborted(operation, signal, error);\n' +
  '                if (attempt < maxAttempts && isTransientNetworkError(error)) {\n' +
  '                    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));\n' +
  '                    continue;\n' +
  '                }\n' +
  '                throw new AnySearchClientError(`AnySearch ${operation} request failed: ${formatFetchFailure(error)}`, { operation, cause: error });\n' +
  '            }\n' +
  '            if (response.status >= 500 && attempt < maxAttempts) {\n' +
  '                clearTimeout(timeout);\n' +
  '                await new Promise((resolve) => setTimeout(resolve, 250 * attempt));\n' +
  '                continue;\n' +
  '            }\n' +
  '            break;\n' +
  '        }\n'

const ANYSEARCH_HELPER_FROM =
  'function isAbortError(error) {\n' +
  "    return error instanceof DOMException && error.name === 'AbortError';\n" +
  '}\n'

const ANYSEARCH_HELPER_TO =
  'function isAbortError(error) {\n' +
  "    return error instanceof DOMException && error.name === 'AbortError';\n" +
  '}\n' +
  'function isTransientNetworkError(error) {\n' +
  "    const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CLOSED', 'UND_ERR_DESTROYED']);\n" +
  '    for (let current = error, depth = 0; current && depth < 6; current = current.cause, depth++) {\n' +
  '        if (typeof current.code === "string" && codes.has(current.code))\n' +
  '            return true;\n' +
  '        const message = current instanceof Error ? current.message : String(current);\n' +
  '        if (/fetch failed|socket hang up|other side closed|ECONNRESET|ETIMEDOUT/i.test(message))\n' +
  '            return true;\n' +
  '    }\n' +
  '    return false;\n' +
  '}\n' +
  'function formatFetchFailure(error) {\n' +
  '    const parts = [];\n' +
  '    for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth++) {\n' +
  '        const message = current instanceof Error ? current.message : String(current);\n' +
  '        parts.push(typeof current.code === "string" ? `${message} (code ${current.code})` : message);\n' +
  '    }\n' +
  '    return parts.join(" ← ");\n' +
  '}\n'

/**
 * @anysearch/anysearch-dsh@0.1.4：search 的 TypeError: fetch failed 是 undici 传输层瞬时失败
 *（ECONNRESET / socket hang up / TUN 抖动），插件既不重试也不把 cause 写进 UI。
 * 文件在内核前缀 node_modules/@anysearch，相对 kernelRoot（…/@deepseek-ai/dsh）上两级。
 * 没装插件的假内核跳过（optional）。
 */
function pinAnySearchFetchRetry(kernelRoot, log, counters) {
  const file = path.join(kernelRoot, ANYSEARCH_CLIENT)
  if (!fs.existsSync(file)) {
    log(`ANYSEARCH_FETCH_SKIP=${ANYSEARCH_CLIENT}|missing`)
    return
  }
  let text = fs.readFileSync(file, 'utf8')
  if (text.includes(ANYSEARCH_FETCH_RETRY_MARK)) {
    log(`PATCH_ALREADY=${ANYSEARCH_CLIENT}|${ANYSEARCH_FETCH_RETRY_MARK}`)
    counters.skipped++
    return
  }
  const fetchHits = text.split(ANYSEARCH_FETCH_FROM).length - 1
  if (fetchHits !== 1) throw new KernelPatchError('anysearch-fetch-anchor', `${ANYSEARCH_CLIENT}|expected=1|got=${fetchHits}`)
  const helperHits = text.split(ANYSEARCH_HELPER_FROM).length - 1
  if (helperHits !== 1) throw new KernelPatchError('anysearch-helper-anchor', `${ANYSEARCH_CLIENT}|expected=1|got=${helperHits}`)
  text = text.replace(ANYSEARCH_FETCH_FROM, ANYSEARCH_FETCH_TO).replace(ANYSEARCH_HELPER_FROM, ANYSEARCH_HELPER_TO)
  text = text.trimEnd() + `\n// --- ${ANYSEARCH_FETCH_RETRY_MARK} (${SEE}) ---\n`
  fs.writeFileSync(file, text, 'utf8')
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (err) {
    throw new KernelPatchError('syntax', `${ANYSEARCH_CLIENT}|${String(err.stderr || err)}`)
  }
  log(`PATCHED=${ANYSEARCH_CLIENT}|retry-transient-fetch,fetch-failure-helpers`)
  counters.applied++
}

function pinPresetInstrRoot(kernelRoot, rel, log, counters) {
  const file = resolveKernelFile(kernelRoot, rel)
  const mark = 'company-preset-instr-root-v1'
  if (!file) {
    log(`PRESET_INSTR_SKIP=${rel}|missing`)
    return
  }
  const text = fs.readFileSync(file, 'utf8')
  if (text.includes(mark)) {
    log(`PATCH_ALREADY=${rel}|${mark}`)
    counters.skipped++
    return
  }
  if (/id: agent-instructions[\s\S]*?projectRootMarkers:[\s\S]*?\.company-root/.test(text)) {
    fs.writeFileSync(file, text.replace(/\s*$/, '') + `\n# --- ${mark} ---\n`, 'utf8')
    log(`PATCHED=${rel}|instr-root-mark`)
    counters.applied++
    return
  }
  const row = /^([ \t]*)- id: agent-instructions\n\1  name: '@deepseek-ai\/dsh-agent-instructions'\n\1  config:\n\1    maxBytes: 65536\n/m.exec(text)
  if (!row) {
    log(`PRESET_INSTR_SKIP=${rel}|no-agent-instructions`)
    return
  }
  const pad = row[1]
  const insert = `${pad}    projectRootMarkers:\n${pad}      - .company-root\n# --- ${mark} ---\n`
  fs.writeFileSync(file, text.slice(0, row.index + row[0].length) + insert + text.slice(row.index + row[0].length), 'utf8')
  log(`PATCHED=${rel}|instr-root`)
  counters.applied++
}

// ---------------------------------------------------------------------------------------------

/** 所有 mark（代码 + 预设），供 --check 判断「补丁齐了没」。 */
export const ALL_MARKS = [
  ...CODE_PATCHES.map((p) => ({ file: p.file, marks: [p.mark, ...(p.already ?? [])], ...(p.optional ? { optional: true } : {}) })),
  { file: PRESET_STANDARD, files: [...presetCandidates('standard'), ...presetPatchCandidates()], marks: [SKILLS_MARK_V2] },
  { file: PRESET_STANDARD, files: [...presetCandidates('standard'), ...presetPatchCandidates()], marks: ['company-preset-web-fetch-v2'] },
  { file: PRESET_CODE, files: presetCandidates('code'), marks: ['company-preset-web-fetch-v2'], optional: true },
  { file: PRESET_STANDARD, files: [...presetCandidates('standard'), ...presetPatchCandidates()], marks: ['company-preset-instr-root-v1'] },
  { file: PRESET_CODE, files: presetCandidates('code'), marks: ['company-preset-instr-root-v1'], optional: true },
  { file: ANYSEARCH_CLIENT, marks: [ANYSEARCH_FETCH_RETRY_MARK], optional: true },
]

/** 只读检查：返回还缺哪些 mark（空数组 = 补丁齐全）。 */
export function missingPatches(kernelRoot) {
  const missing = []
  for (const entry of ALL_MARKS) {
    const candidates = entry.files ?? [entry.file]
    const present = candidates.map((rel) => resolveKernelFile(kernelRoot, rel)).filter(Boolean)
    if (!present.length) {
      if (entry.optional) continue
      missing.push(`${entry.file}|missing`)
      continue
    }
    // 0.1.7 一个条目对应多个预设文件，每个在场的文件都要有 mark，不能一个命中就放过其余。
    for (const target of present) {
      const text = fs.readFileSync(target, 'utf8')
      if (!entry.marks.some((m) => text.includes(m))) missing.push(`${path.relative(kernelRoot, target)}|${entry.marks[0]}`)
    }
  }
  return missing
}

/**
 * 对一个内核根目录应用全部补丁。幂等；任何锚点对不上都抛 KernelPatchError（不会半途落盘：每个文件先整体替换再写）。
 * @param {{ kernelRoot: string, skillsDir: string, log?: (line: string) => void }} opts
 * @returns {{ applied: number, skipped: number }}
 */
export function applyKernelPatches({ kernelRoot, skillsDir, log = console.log, expectVersion } = {}) {
  const counters = { applied: 0, skipped: 0 }
  log(`PATCH_KERNEL_ROOT=${kernelRoot}`)

  for (const patch of CODE_PATCHES) {
    const target = resolveKernelFile(kernelRoot, patch.file)
    if (!target) throw new KernelPatchError('target-missing', path.join(kernelRoot, patch.file))
    if (expectVersion && /@deepseek-ai[\\/]dsh-/.test(patch.file)) {
      const got = packageVersionOf(target)
      if (got && got !== expectVersion) {
        throw new KernelPatchError('version-drift', `${patch.file}|got=${got}|want=${expectVersion}|依赖被 ^ 版本飘走了，安装时要钉住 installBefore`)
      }
    }
    let text = fs.readFileSync(target, 'utf8')

    const already = [patch.mark].concat(patch.already ?? [])
    const hit = already.find((m) => m && text.includes(m))
    if (hit) {
      log(`PATCH_ALREADY=${patch.file}|${hit}`)
      counters.skipped++
      continue
    }
    // optional 补丁的锚点在新内核上可能整段消失（调用点被上游删掉）。一条都对不上就跳过，
    // 不要把「源码已不再需要这条补丁」当成升版失败。留下 mark，下次检查知道这条已经审过。
    // 部分命中仍是硬失败：半套上去会改错语义。
    if (patch.optional && patch.edits.every((edit) => editVariants(edit).every((variant) => text.split(variant.from).length - 1 === 0))) {
      fs.writeFileSync(target, text.trimEnd() + '\n' + patch.append, 'utf8')
      log(`PATCH_SKIP=${patch.file}|${patch.mark}|anchor-gone`)
      counters.skipped++
      continue
    }
    for (const edit of patch.edits) {
      text = applyEdit(text, edit, patch.file)
    }
    text = text.trimEnd() + '\n' + patch.append
    fs.writeFileSync(target, text, 'utf8')
    try {
      execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' })
    } catch (err) {
      throw new KernelPatchError('syntax', `${patch.file}|${String(err.stderr || err)}`)
    }
    log(`PATCHED=${patch.file}|${patch.edits.map((e) => e.name).join(',')}`)
    counters.applied++
  }

  pinPresetSkills(kernelRoot, skillsDir, log, counters)
  pinPresetFetch(kernelRoot, 'standard', log, counters)
  if (!presetPatchCandidates().some((rel) => resolveKernelFile(kernelRoot, rel))) pinPresetFetch(kernelRoot, 'code', log, counters)
  pinAnySearchFetchRetry(kernelRoot, log, counters)
  const instrRels = [
    ...presetRels(kernelRoot, 'standard'),
    ...(presetPatchCandidates().some((rel) => resolveKernelFile(kernelRoot, rel)) ? [] : [resolvePresetRel(kernelRoot, 'code')]),
    path.join('config', 'agent-presets', 'company-think', 'agent.cordis.yml'),
    path.join('config', 'agent-presets', 'company-think-eval', 'agent.cordis.yml'),
  ].filter(Boolean)
  for (const rel of instrRels) pinPresetInstrRoot(kernelRoot, rel, log, counters)

  return counters
}
