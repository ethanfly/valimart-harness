/**
 * Qwen Code 补丁集：把固定版本（pin.json）的 @qwen-code/qwen-code npm 包整形成 valimart code。
 *
 * 规矩与 scripts/kernel/patches.mjs（dsh 内核补丁）一样：锚点式编辑，from 片段恰好命中 1 次才套用，
 * 对不上就硬失败——升 Qwen Code 版本时逼着人对着新包重审，不许整文件覆盖绕过。
 * 每个补丁在目标文件末尾追加 mark 注释，再跑看到 mark 就跳过（幂等）。
 *
 * 包是 esbuild 拆分打包，文件名带哈希（chunks/chunk-XXXX.js），每个版本都会变；所以按 locate 片段找文件：
 * 所有 .js 里必须恰好一个文件含它。包没有混淆标识符，锚点按源码里的名字写。
 *
 * 能用 Qwen Code 自己的配置项做到的（横幅、状态栏、模型目录、MCP、hook、禁用命令、窗口标题）都不在这里，
 * 见 lib/settings.mjs 与 lib/launcher.mjs。这里只留配置给不了的四件事。
 */
import fs from 'node:fs'
import path from 'node:path'

export class QwenPatchError extends Error {
  constructor(code, detail) {
    super(`${code}|${detail}`)
    this.code = code
    this.detail = detail
  }
}

const SEE = 'valimart patch; see company-desk/packages/valimart-code/scripts/patches.mjs'

export const PATCHES = [
  {
    // /desk-* 斜杠命令：BuiltinCommandLoader.loadCommands 是 async，直接 await import 启动器给的模块；
    // 加载失败只记调试日志，不拖垮原有命令。
    mark: 'valimart-desk-commands-v1',
    locate: 'const allDefinitions=[aboutCommand,',
    edits: [
      {
        name: 'builtin-loader-desk-commands',
        from: 'const allDefinitions=[aboutCommand,',
        to: 'const allDefinitions=[...(process.env.VALIMART_CODE_COMMANDS?await import(process.env.VALIMART_CODE_COMMANDS).then(m=>m.loadDeskCommands(this.config),e=>{builtinDebugLogger.warn("valimart desk commands:",e instanceof Error?e.message:String(e));return[]}):[]),aboutCommand,',
      },
    ],
  },
  {
    // 系统提示第一句：模型自称 Valimart Code，并知道请求走公司网关。
    mark: 'valimart-identity-v1',
    locate: 'You are Qwen Code, ${role} developed by Alibaba Group, ${focus}.',
    edits: [
      {
        name: 'core-identity',
        from: 'You are Qwen Code, ${role} developed by Alibaba Group, ${focus}.',
        to: 'You are Valimart Code, ${role} for the Valimart (惠利玛) company delivery platform, built on Qwen Code by Alibaba Group, ${focus}. All model requests go through the company gateway.',
      },
    ],
  },
  {
    // valimart --help 的用法行与默认命令说明。
    mark: 'valimart-cli-usage-v1',
    locate: 'var TOP_LEVEL_USAGE="Usage: qwen [options] [command]',
    edits: [
      {
        name: 'top-level-usage',
        from: 'var TOP_LEVEL_USAGE="Usage: qwen [options] [command]\\n\\nQwen Code - Launch',
        to: 'var TOP_LEVEL_USAGE="Usage: valimart [options] [command]\\n\\nValimart Code (based on Qwen Code) - Launch',
      },
      {
        name: 'default-command-desc',
        from: 'var DEFAULT_COMMAND_DESC="Launch Qwen Code CLI"',
        to: 'var DEFAULT_COMMAND_DESC="Launch Valimart Code CLI"',
      },
    ],
  },
  {
    // 命令名：主解析器（chunk 里）与 cli.js 里的三个帮助解析器。
    mark: 'valimart-cli-script-name-v1',
    locate: 'yargs_default(rawArgv).locale("en").scriptName("qwen")',
    edits: [
      {
        name: 'main-parser',
        from: 'yargs_default(rawArgv).locale("en").scriptName("qwen")',
        to: 'yargs_default(rawArgv).locale("en").scriptName("valimart")',
      },
    ],
  },
  {
    mark: 'valimart-cli-help-script-name-v1',
    locate: 'async function buildTopLevelHelpParser(){',
    edits: [
      {
        name: 'top-level-help',
        from: '.locale("en").scriptName("qwen").usage(TOP_LEVEL_USAGE)',
        to: '.locale("en").scriptName("valimart").usage(TOP_LEVEL_USAGE)',
      },
      {
        name: 'mcp-help',
        from: 'yargsInstance([]).scriptName("qwen").command(mcpCommand)',
        to: 'yargsInstance([]).scriptName("valimart").command(mcpCommand)',
      },
      {
        name: 'memory-help',
        from: 'yargsInstance([]).scriptName("qwen").command(memoryCommand)',
        to: 'yargsInstance([]).scriptName("valimart").command(memoryCommand)',
      },
    ],
  },
]

export function applyEdit(text, edit, file = '') {
  const n = text.split(edit.from).length - 1
  if (n !== 1) throw new QwenPatchError('anchor-not-unique', `${file}|${edit.name}|expected=1|got=${n}|Qwen Code 升过版本？请对着新包重审这条补丁`)
  return text.replace(edit.from, () => edit.to)
}

/** 包里所有可能被打补丁的 .js（根目录 + chunks/）。 */
export function candidateFiles(pkgDir) {
  const out = []
  for (const dir of ['', 'chunks']) {
    const abs = path.join(pkgDir, dir)
    if (!fs.existsSync(abs)) continue
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.js')) out.push(path.join(abs, name))
    }
  }
  return out
}

function markComment(mark) {
  return `\n// --- ${mark} (${SEE}) ---\n`
}

/**
 * @param {string} pkgDir 解开的 npm 包目录（含 cli-entry.js 的那一层）
 * @returns {{ applied: string[], skipped: string[] }}
 */
export function applyPatches(pkgDir, patches = PATCHES, log = () => {}) {
  const files = candidateFiles(pkgDir)
  const texts = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]))
  const applied = []
  const skipped = []
  for (const patch of patches) {
    const tag = markComment(patch.mark)
    const done = files.filter((f) => texts.get(f).includes(tag))
    if (done.length) {
      skipped.push(patch.mark)
      log(`PATCH_ALREADY=${path.relative(pkgDir, done[0])}|${patch.mark}`)
      continue
    }
    const hits = files.filter((f) => texts.get(f).includes(patch.locate))
    if (hits.length !== 1) {
      throw new QwenPatchError('locate-not-unique', `${patch.mark}|expected=1|got=${hits.length}|Qwen Code 升过版本？请对着新包重审这条补丁`)
    }
    const file = hits[0]
    const rel = path.relative(pkgDir, file)
    let text = texts.get(file)
    for (const edit of patch.edits) text = applyEdit(text, edit, rel)
    text += tag
    texts.set(file, text)
    fs.writeFileSync(file, text)
    applied.push(patch.mark)
    log(`PATCHED=${rel}|${patch.mark}`)
  }
  return { applied, skipped }
}
