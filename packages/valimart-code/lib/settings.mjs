/**
 * 生成 valimart code 的启动设置（1.0），一份：<home>/launch-settings.json，用 `--settings <file>` 注入。
 *
 * 为什么整份都走 flag 层（优先级最高）：运行时 provider 走「用户 settings 原文 → 解析」路径，
 * 全程不做 $VAR 展开（见 models.mjs 的说明），apiKey 只能写实际令牌；flag 层至少保证这份文件由
 * 启动器每次重写、0600 权限，且不会被 /model 之类的写入流程带着用户设置一起改动。
 *
 * 代价：flag 层的 model.name 会压过用户在 /model 里的选择，所以这里不写 model.name——默认模型靠
 * providers.valimart.model 兜底，用户 /model 选的模型存在用户层，未在 flag 里出现就不受影响。
 *
 * 注意 --settings 校验失败是致命错误：结构必须严格符合 1.0 schema。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pickModels, toProviderSetting } from './models.mjs'
import { isLoggedIn } from './state.mjs'
import { bannerSubtitle } from './status.mjs'

/**
 * hook 用 exec 形式跑（spawn(command, args, {shell:false})，无 shell 转义问题）：
 * command 指向 valimart 二进制，BUN_BE_BUN=1 让它当纯 Bun 解释器执行脚本，不依赖系统 Node。
 */
export function bunHook(binaryPath, script, env) {
  return { command: binaryPath, args: ['run', script], env }
}

/** 状态栏是 shell 命令字符串：argv 逐个加引号，Windows 空格 / 反斜杠不出问题。 */
export function statusLineCommand(binaryPath, script) {
  const q = (p) => `"${String(p).replace(/\\/g, '/')}"`
  return `${q(binaryPath)} run ${q(script)}`
}

/**
 * @param {object} opts
 * @param {object} opts.state 登录态（state.mjs）
 * @param {string} opts.runtimeDir 打包后 valimart/ 目录：desk-mcp.mjs / session-context.mjs / statusline.mjs 在这里
 * @param {string} opts.binaryPath valimart 原生二进制（跑 MCP / hook 脚本用）
 * @param {string} opts.version valimart code 版本
 * @param {string} opts.home valimart 配置根目录（传给 MCP 服务）
 */
export function buildLaunchSettings({ state, runtimeDir, binaryPath, version, home }) {
  const loggedIn = isLoggedIn(state)
  const provider = loggedIn
    ? toProviderSetting(state.models, {
        gatewayUrl: state.gatewayUrl,
        defaultModel: state.company?.defaultModel ?? state.defaultModel,
        token: state.gatewayToken,
      })
    : null
  const picked = loggedIn ? pickModels(state, provider?.models ?? []) : { main: '', fast: '' }
  // 快速推理模型走 routing.utility（1.0 没有 fastModel）：标题、摘要、压缩、hook 提示这类小请求用它。
  if (provider && picked.fast) provider.routing = { utility: picked.fast }
  const childEnv = { BUN_BE_BUN: '1', VALIMART_HOME: home }
  const settings = {
    security: { auth: { selectedType: 'openai' } },
    mcpServers: {
      desk: {
        command: binaryPath,
        args: ['run', path.join(runtimeDir, 'desk-mcp.mjs')],
        env: childEnv,
        description: 'valimart 公司网关：公司盘镜像 / 记忆 / 知识检索 / 任务卡（14 个 company_* 工具）',
      },
    },
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              ...bunHook(binaryPath, path.join(runtimeDir, 'session-context.mjs'), childEnv),
              name: 'valimart-company-context',
              description: '注入公司网关登录身份、公司盘镜像与绑定的任务卡',
              timeout: 10,
            },
          ],
        },
      ],
    },
    statusLine: {
      type: 'command',
      command: statusLineCommand(binaryPath, path.join(runtimeDir, 'statusline.mjs')),
    },
    general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
    privacy: { usageStatisticsEnabled: false },
  }
  return { settings, provider, picked, bannerSubtitle: bannerSubtitle(state), version }
}

/** 0600 写文件（设置里有网关令牌，只给本人读写）。 */
export function writeLaunchSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/**
 * providers 合并进用户层 settings.json。1.0 的请求路径只从用户设置原文装配 provider
 * （createPublicProviders → createCustomModelProvidersFromSettingsTexts，不做 $VAR 展开），
 * 所以 provider 必须放用户层且 apiKey 是实际令牌。只改 providers / model.name 两个键，其余设置原样保留。
 */
export function mergeUserProviders(file, provider, modelName) {
  let current = {}
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    /* 还没有或损坏：重写 */
  }
  const next = { ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}) }
  if (provider) next.providers = { ...(next.providers ?? {}), valimart: provider }
  else if (next.providers) delete next.providers.valimart
  // 公司默认模型写 model.name（provider/model）；用户已在 /model 里选过就保留。
  if (modelName && !next.model?.name) next.model = { ...(next.model ?? {}), name: modelName }
  writeLaunchSettings(file, next)
}
