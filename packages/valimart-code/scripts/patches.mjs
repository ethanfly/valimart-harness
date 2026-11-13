/**
 * Qwen Code 1.0 源码补丁：把锁定 commit（pin.json）的源码整形成 valimart code。
 *
 * 与 dsh 内核补丁同一套规矩（scripts/kernel/patches.mjs）：锚点式编辑，from 恰好命中 1 次才套用，
 * 对不上硬失败——升 Qwen Code 时逼着人对新源码重审，不许整文件覆盖绕过。按 mark 跳过（幂等）。
 *
 * 1.0 的白标走构建期 BRAND_* define；官方 brand-env.js 把 BRAND_* 强制成空串（走上游默认值），
 * 这里让它读构建环境（BRAND_* 非空就用我们的值，见 build.mjs 的 BRAND_ENV），其余不变——
 * 上游自己的测试（qwen-binary-build.test.ts）不设 BRAND_* 环境变量，行为不受影响。
 */
export const PATCHES = [
  {
    // brand-env.js：上游构建把 BRAND_* 冻结成空串（走 Qwen 默认值）。改成读构建环境，
    // 让 build.mjs 的 BRAND_ENV define 真正生效；上游自己的测试不设这些变量，行为不变。
    mark: 'valimart-brand-env-v1',
    file: 'scripts/brand-env.js',
    edits: [
      {
        name: 'env-aware-brand-defines',
        from: `      JSON.stringify(''),`,
        to: `      JSON.stringify(process.env[name] ?? ''),`,
      },
    ],
  },
  {
    // Windows 代码签名：上游在 Windows 宿主上无条件调 signtool（signWindowsBinary）。
    // 公司没有代码签名证书，CI 也没装 Windows SDK；跳过签名，产物不签名照常可用
    // （SmartScreen 会提示「未知发布者」，与现在的网关安装包一致）。
    mark: 'valimart-skip-win-sign-v1',
    file: 'scripts/bun-binary-compiler.ts',
    edits: [
      {
        name: 'skip-windows-signing',
        from: `  } else if (
    process.platform === 'win32' &&
    (!target || target.includes('win32') || target.includes('windows'))
  ) {
    signWindowsBinary(binaryPath);`,
        to: `  } else if (process.platform === 'win32') {
    // valimart：没有代码签名证书，跳过 signtool（上游这里无条件签名，CI 没有 Windows SDK 会失败）。
    console.log('Skipping Windows code signing (valimart build has no certificate).');`,
      },
    ],
  },
  {
    // /auth：1.0 是 Qoder / Qwen 账号的登录入口。valimart 只走公司网关 provider，直接给提示。
    mark: 'valimart-auth-command-v1',
    file: 'packages/cli/src/auth/authPlugin.ts',
    edits: [
      {
        name: 'auth-action',
        from: `    description: 'Connect an LLM provider',
    kind: CommandKind.BUILT_IN,
    autoExecute: true,
    action: async () => {
      requestAuthGate('login');
      return undefined;
    },`,
        to: `    description: 'valimart：只用公司网关登录（valimart login）',
    kind: CommandKind.BUILT_IN,
    autoExecute: true,
    action: async () => {
      if (process.env['VALIMART_CODE_COMMANDS']) {
        return {
          type: 'local_command_result',
          text: 'valimart 只用公司网关登录：退出后运行 valimart login，或设置 DESK_GATEWAY_PASSWORD 后用 /desk-login。',
          severity: 'info',
        };
      }
      requestAuthGate('login');
      return undefined;
    },`,
      },
      {
        name: 'logout-description',
        from: `    description: 'Sign out of Qoder or your Qwen account',`,
        to: `    description: 'valimart：登出公司网关用 /desk-logout',`,
      },
    ],
  },
  {
    // /desk-* 斜杠命令：loadCommands 是 async，运行时从 VALIMART_CODE_COMMANDS 指向的模块取
    // （命令实现随启动器升级，不用重编内核）。加载失败只记日志，不挡宿主命令。
    mark: 'valimart-desk-commands-v1',
    file: 'packages/cli/src/services/BuiltinCommandLoader.ts',
    edits: [
      {
        name: 'load-desk-commands',
        from: `    const allDefinitions: Array<SlashCommand | null> = [`,
        to: `    const deskCommands = process.env['VALIMART_CODE_COMMANDS']
      ? await import(process.env['VALIMART_CODE_COMMANDS'])
          .then((module) => module.loadDeskCommands())
          .catch((error: unknown) => {
            runLogger.warn(
              '[valimart] desk commands load failed: ' +
                (error instanceof Error ? error.message : String(error)),
            );
            return [] as SlashCommand[];
          })
      : [];
    const allDefinitions: Array<SlashCommand | null> = [
      ...deskCommands,`,
      },
      {
        name: 'import-logger',
        from: `import { isDevelopment } from '../installation/source.js';`,
        to: `import { isDevelopment } from '../installation/source.js';
import { runLogger } from '@qwen-code/core';`,
      },
    ],
  },
  {
    // 1.0 默认 defaultAuthType: 'qoder-oauth'；valimart 只走公司网关 provider。
    mark: 'valimart-bin-auth-default-v1',
    file: 'packages/cli/bin.ts',
    edits: [
      {
        name: 'default-auth-type',
        from: "  defaultAuthType: 'qoder-oauth',",
        to: "  defaultAuthType: 'openai',",
      },
    ],
  },
]

export class QwenPatchError extends Error {
  constructor(code, detail) {
    super(`${code}|${detail}`)
    this.code = code
    this.detail = detail
  }
}

const SEE = 'valimart patch; see company-desk/packages/valimart-code/scripts/patches.mjs'

function markComment(mark) {
  return `\n// --- ${mark} (${SEE}) ---\n`
}

/** @param {string} rootDir 1.0 源码根（含 packages/cli/bin.ts） */
export function applyPatches(rootDir, patches = PATCHES, log = () => {}) {
  const applied = []
  const skipped = []
  for (const patch of patches) {
    const file = `${rootDir}/${patch.file}`
    const tag = markComment(patch.mark)
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      throw new QwenPatchError('file-missing', `${patch.file}|${err.message}`)
    }
    if (text.includes(tag)) {
      skipped.push(patch.mark)
      log(`PATCH_ALREADY=${patch.file}|${patch.mark}`)
      continue
    }
    for (const edit of patch.edits) {
      const n = text.split(edit.from).length - 1
      if (n !== 1) {
        throw new QwenPatchError(
          'anchor-not-unique',
          `${patch.file}|${edit.name}|expected=1|got=${n}|Qwen Code 升过版本？请对新源码重审这条补丁 (${SEE})`,
        )
      }
      text = text.replace(edit.from, () => edit.to)
    }
    text += tag
    fs.writeFileSync(file, text)
    applied.push(patch.mark)
    log(`PATCHED=${patch.file}|${patch.mark}`)
  }
  return { applied, skipped }
}

import fs from 'node:fs'
