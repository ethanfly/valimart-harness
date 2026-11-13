/**
 * 生成 Qwen Code 的「系统默认」设置（QWEN_CODE_SYSTEM_DEFAULTS_PATH 指向它）。
 *
 * 系统默认是优先级最低的一层：用户在 ~/.valimart/settings.json 或项目 .qwen/settings.json 里改的照样生效
 * （比如在 /model 里换了模型）。每次启动按登录态重写，不碰用户自己的设置文件。
 *
 * 这里放的都是 Qwen Code 自带的配置项：公司网关模型目录、desk MCP 服务、SessionStart 公司上下文、
 * 状态栏、横幅品牌、关掉遥测 / 自动更新 / 与公司网关无关的命令。密钥不写进来，见 models.mjs 的 envKey。
 */
import fs from 'node:fs'
import path from 'node:path'
import { customAsciiArt } from './banner.mjs'
import { pickModels, toQwenModels } from './models.mjs'
import { isLoggedIn } from './state.mjs'
import { bannerSubtitle } from './status.mjs'

/**
 * 与公司网关无关、或会把人带去原版 Qwen 的斜杠命令：
 * /auth 换登录方式、/logout 与 /upgrade 是 Qwen 订阅、/update 会装回原版 npm 包、/bug 去 QwenLM 提 issue。
 */
export const DISABLED_SLASH_COMMANDS = ['auth', 'logout', 'upgrade', 'update', 'bug']

/** hook / 状态栏是 shell 命令：node 与脚本路径都加引号，Windows 路径里的空格和反斜杠不出问题。 */
export function nodeCommand(nodePath, script) {
  const q = (p) => `"${String(p).replace(/\\/g, '/')}"`
  return `${q(nodePath)} ${q(script)}`
}

/**
 * @param {object} opts
 * @param {object} opts.state 登录态（state.mjs）
 * @param {string} opts.runtimeDir 打包后 valimart/ 目录：desk-mcp.mjs / session-context.mjs / statusline.mjs 在这里
 * @param {string} opts.nodePath 当前 node（process.execPath）
 * @param {string} opts.version valimart code 版本
 * @param {string} opts.home valimart 根目录（传给 MCP 服务）
 */
export function buildSystemDefaults({ state, runtimeDir, nodePath, version, home }) {
  const loggedIn = isLoggedIn(state)
  const models = loggedIn ? toQwenModels(state.models, { gatewayUrl: state.gatewayUrl, defaultModel: state.company?.defaultModel ?? state.defaultModel }) : []
  const picked = pickModels(state, models)
  const settings = {
    security: { auth: { selectedType: 'openai', enforcedType: 'openai' } },
    ...(models.length ? { modelProviders: { openai: models } } : {}),
    model: { ...(picked.main ? { name: picked.main } : {}), catalogRefresh: false },
    ...(picked.fast ? { fastModel: picked.fast } : {}),
    mcpServers: {
      desk: {
        command: nodePath,
        args: [path.join(runtimeDir, 'desk-mcp.mjs')],
        env: { VALIMART_HOME: home },
        description: 'valimart 公司网关：公司盘镜像 / 记忆 / 知识检索 / 任务卡（14 个 company_* 工具）',
      },
    },
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: nodeCommand(nodePath, path.join(runtimeDir, 'session-context.mjs')),
              name: 'valimart-company-context',
              description: '注入公司网关登录身份、公司盘镜像与绑定的任务卡',
              timeout: 10,
            },
          ],
        },
      ],
    },
    ui: {
      customAsciiArt: customAsciiArt(),
      customBannerTitle: `VALIMART CODE ${version} · Qwen Code`,
      customBannerSubtitle: bannerSubtitle(state),
      statusLine: { type: 'command', command: nodeCommand(nodePath, path.join(runtimeDir, 'statusline.mjs')), refreshInterval: 30 },
    },
    general: { enableAutoUpdate: false },
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false },
    slashCommands: { disabled: DISABLED_SLASH_COMMANDS },
  }
  return settings
}

export function writeSystemDefaults(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`)
  fs.renameSync(tmp, file)
}
