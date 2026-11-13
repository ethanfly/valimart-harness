/**
* valimart 命令入口（1.0）：先处理公司网关这一层，再 spawn 白标宿主二进制（原 Qwen Code）。
*
* - 自带子命令：login / logout / status / discover / sync；update、auth 改成提示（不许换登录方式）。
* - 进 TUI 或 -p 之前确认已登录公司网关：没登录就在终端里选网关、填账号密码（桌面端的登录遮罩同理）。
* - 按登录态生成启动设置（settings.mjs，--settings 注入），设置配置根、网关令牌等环境变量，然后
*   spawn 宿主（BUN_BE_BUN 不设，正常起 CLI）。1.0 是独立进程，退出码透传。
*/
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { DEFAULT_GATEWAY_URL, discoverGateways } from './discover.mjs'
import { getMirror, setDriveLogSink, syncDrive } from './drive-runtime.mjs'
import { gatewayOptions, gatewayUrlFromChoice, MANUAL_GATEWAY_LABEL } from './gateway-choice.mjs'
import { fetchMe, GatewayError, login, logout, normalizeGatewayUrl } from './gateway.mjs'
import { GATEWAY_TOKEN_ENV } from './models.mjs'
import { buildLaunchSettings, mergeUserProviders, writeLaunchSettings } from './settings.mjs'
import { createPrompter, PromptCancelled } from './prompt-io.mjs'
import { isLoggedIn, loadState, valimartHome } from './state.mjs'
import { statusText, userLine } from './status.mjs'

export const RELEASE_PAGE = 'https://ethanfly.github.io/valimart-harness/'

const QWEN_SUBCOMMANDS = new Set(['mcp', 'plugins', 'skills', 'hooks', 'agents'])

const OWN_HELP = [
  'valimart code：基于 Qwen Code 的公司网关终端客户端。',
  '自带命令：valimart login [网关地址] [账号] | logout | status | discover | sync',
  '其余用法与 Qwen Code 相同，命令名统一为 valimart。',
  '',
].join('\n')

function hasFlag(argv, ...names) {
  for (const a of argv) {
    if (a === '--') return false
    if (names.includes(a) || names.some((n) => n.startsWith('--') && a.startsWith(`${n}=`))) return true
  }
  return false
}

/** 这次调用要不要先过登录：默认命令（TUI / -p）要；管理子命令和 --help 不要。 */
export function needsGatewayLogin(argv) {
  if (hasFlag(argv, '--help', '-h')) return false
  const first = argv[0]
  return !(first && !first.startsWith('-') && QWEN_SUBCOMMANDS.has(first))
}

export function isHeadless(argv, stdin = process.stdin) {
  return hasFlag(argv, '-p', '--prompt') || !stdin.isTTY
}

function envCredentials(env = process.env) {
  const url = normalizeGatewayUrl(env.DESK_GATEWAY_URL)
  const username = env.DESK_GATEWAY_USER || env.DESK_GATEWAY_USERNAME || ''
  const password = env.DESK_GATEWAY_PASSWORD || ''
  return url && username && password ? { url, username, password } : null
}

/**
* 终端里登录：先找网关列出来选，找不到才手填；账号密码错了再问一次账号密码，连不上再问地址。
* 命令行或环境变量给了的项不再问。
*/
export async function interactiveLogin(io, { url: urlArg = '', username: userArg = '' } = {}) {
  const state = loadState()
  let url = normalizeGatewayUrl(urlArg || process.env.DESK_GATEWAY_URL)
  if (!url) {
    io.say('正在寻找公司网关…')
    const options = gatewayOptions(await discoverGateways(), { manual: MANUAL_GATEWAY_LABEL })
    if (options.some((o) => o.url)) {
      const picked = await io.choose('选择公司网关：', options.map((o) => o.label))
      url = gatewayUrlFromChoice(options[picked].label, options)
    }
  }
  let username = userArg || process.env.DESK_GATEWAY_USER || ''
  for (let attempt = 1; ; attempt++) {
    if (!url) url = normalizeGatewayUrl(await io.ask('公司网关地址', { defaultValue: state.gatewayUrl || DEFAULT_GATEWAY_URL }))
    if (!url) {
      io.say('网关地址无效，形如 http://192.168.1.10:8790')
      continue
    }
    if (!username) username = await io.ask('公司账号', { defaultValue: state.user?.username || '' })
    const password = process.env.DESK_GATEWAY_PASSWORD || (await io.askHidden('密码'))
    try {
      io.say(`正在登录 ${url} …`)
      return await login({ gatewayUrl: url, username, password })
    } catch (err) {
      if (attempt >= 3 || process.env.DESK_GATEWAY_PASSWORD) throw err
      io.say(`登录失败：${err.message}`)
      if (err instanceof GatewayError && err.code === 'unreachable') url = ''
      else username = ''
    }
  }
}

function loginSummary(state) {
  const n = Array.isArray(state.models) ? state.models.length : 0
  return `已登录 ${userLine(state).replace(/^valimart /, '')} · ${n} 个模型 · 公司默认 ${state.company?.defaultModel ?? state.defaultModel ?? '—'}`
}

async function cmdLogin(args, io) {
  const [url, username] = args
  const creds = envCredentials()
  if (!process.stdin.isTTY && !creds && !process.env.DESK_GATEWAY_PASSWORD) {
    throw new Error('非交互登录请设置 DESK_GATEWAY_URL / DESK_GATEWAY_USER / DESK_GATEWAY_PASSWORD，或 valimart login <网关地址> <账号> 并设置 DESK_GATEWAY_PASSWORD')
  }
  const next = await interactiveLogin(io, { url, username })
  io.say(loginSummary(next))
  const sync = await syncDrive().catch(() => null)
  if (sync) io.say(`公司盘已同步到 ${getMirror().root}：远端 ${sync.files} 个，下载 ${sync.pulled}`)
}

async function cmdStatus(io) {
  if (isLoggedIn()) {
    try {
      await fetchMe({ timeoutMs: 8_000 })
    } catch (err) {
      io.say(`（刷新失败，显示的是本机记录：${err.message}）`)
    }
  }
  io.say(statusText(loadState()))
}

async function cmdDiscover(io) {
  io.say('正在寻找公司网关…')
  const options = gatewayOptions(await discoverGateways(), { manual: '', withSource: true })
  if (!options.length) io.say('没有发现公司网关。网关在别的网段时广播到不了：直接 valimart login <网关地址>。')
  for (const o of options) io.say(`- ${o.label}`)
}

async function cmdSync(io) {
  const r = await syncDrive()
  io.say(`公司盘已同步：远端 ${r.files} 个，下载 ${r.pulled}，回推 ${r.pushed}\n本机镜像 ${loadState().driveDir}`)
}

/**
* 进 TUI / -p 前的登录关口。返回 false 表示没登录成、不该启动。
* 网关连不上时按本机记录启动（模型请求届时会报错），不把人挡在门外。
*/
export async function ensureGatewayLogin(io, { headless }) {
  if (isLoggedIn() && !loadState().needsRelogin) {
    try {
      await fetchMe({ timeoutMs: 4_000 })
      return true
    } catch (err) {
      if (!(err instanceof GatewayError && err.status === 401)) {
        process.stderr.write(`valimart：公司网关暂时连不上（${err.message}），按本机记录启动。\n`)
        return true
      }
      process.stderr.write(`valimart：公司网关登录已失效（${err.message}），需要重新登录。\n`)
    }
  }
  const creds = envCredentials()
  if (creds) {
    await login({ gatewayUrl: creds.url, username: creds.username, password: creds.password })
    return true
  }
  if (headless) {
    process.stderr.write('valimart：未登录公司网关。先运行 valimart login（或设置 DESK_GATEWAY_URL / DESK_GATEWAY_USER / DESK_GATEWAY_PASSWORD）。\n')
    return false
  }
  io.say('valimart code · 登录公司网关（密钥只在网关，本机只存登录令牌）')
  io.say(loginSummary(await interactiveLogin(io)))
  return true
}

/** 打包进来的技能拷进 ~/.valimart/skills（内容变了才写；这几个目录归 valimart 管，别在里面手改）。 */
export function syncBundledSkills(runtimeDir, home) {
  const src = path.join(runtimeDir, 'skills')
  if (!fs.existsSync(src)) return
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name, 'SKILL.md')
    if (!fs.existsSync(from)) continue
    const to = path.join(home, 'skills', name, 'SKILL.md')
    const body = fs.readFileSync(from)
    let same = false
    try {
      same = fs.readFileSync(to).equals(body)
    } catch {
      /* 还没有 */
    }
    if (same) continue
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.writeFileSync(to, body)
  }
}

/** 定位宿主二进制：优先随包分发（包内 bin/valimart 或 bin/valimart.exe），找不到返回 null。 */
export function locateBinary(runtimeDir) {
  const local = path.join(runtimeDir, '..', '..', 'bin', `valimart-host${process.platform === 'win32' ? '.exe' : ''}`)
  if (fs.existsSync(local)) return local
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['valimart'], { encoding: 'utf8', windowsHide: true })
  const hit = which.status === 0 ? which.stdout.split(/\r?\n/)[0].trim() : ''
  return hit || null
}


/**
* 准备宿主进程的环境与启动设置：
* - 配置根：白标构建的配置目录 env 名是 VALIMART_CONFIG_DIR（BRAND_ENV_PREFIX=VALIMART_），
*   用户数据都在 ~/.valimart。
* - 网关令牌进 VALIMART_GATEWAY_TOKEN：settings 里 providers.valimart.apiKey 写的是 ${占位符}，
*   宿主启动时从进程环境解析，不落盘。MCP 子进程会被 1.0 的环境脱敏拦下（名字带 TOKEN），
*   所以 desk 服务的 mcpServers.env 里显式带它（settings.mjs）。
* - --settings 指向按登录态重写的 launch-settings.json（providers、desk MCP、hook、状态栏、遥测开关）。
* @returns {{ env: Record<string,string>, args: string[], settingsFile: string }}
*/
export function prepareLaunch({ runtimeDir, version, env = process.env, cwd = process.cwd() }) {
  const home = valimartHome()
  const state = loadState()
  const binaryPath = locateBinary(runtimeDir) ?? ''
  const { settings, provider, picked } = buildLaunchSettings({ state, runtimeDir, binaryPath, version, home })
  // provider（含实际令牌）只放用户层：请求路径只认用户设置原文。
  mergeUserProviders(path.join(home, 'settings.json'), provider, picked.main ? `valimart/${picked.main}` : '')
  const settingsFile = path.join(home, 'launch-settings.json')
  writeLaunchSettings(settingsFile, settings)
  syncBundledSkills(runtimeDir, home)
  const child = {
    ...env,
    // 入口包装用 BUN_BE_BUN=1 让宿主当解释器；spawn 宿主本体时必须去掉，否则它不会进 CLI。
    BUN_BE_BUN: undefined,
    VALIMART_HOME: home,
    VALIMART_CONFIG_DIR: home,
    VALIMART_WORKSPACE: cwd,
    VALIMART_CODE_VERSION: version,
    VALIMART_CODE_COMMANDS: pathToFileURL(path.join(runtimeDir, 'commands.mjs')).href,
    ...(isLoggedIn(state) ? { [GATEWAY_TOKEN_ENV]: state.gatewayToken } : {}),
  }
  return { env: child, args: ['--config-dir', home, '--settings', settingsFile], settingsFile }
}

/** spawn 宿主并透传退出码；找不到二进制时报错（包没装全 / 开发模式没构建）。 */
export function launchHost({ runtimeDir, argv }) {
  const prepared = prepareLaunch({ runtimeDir })
  const binary = locateBinary(runtimeDir)
  if (!binary) {
    process.stderr.write('valimart：找不到宿主二进制（包内 bin/valimart）。请从发布页重装完整的 valimart-code。\n')
    return 1
  }
  const r = spawnSync(binary, [...prepared.args, ...argv], { stdio: 'inherit', env: prepared.env, windowsHide: false })
  if (r.error) {
    process.stderr.write(`valimart：启动宿主失败：${r.error.message}\n`)
    return 1
  }
  return r.status ?? (r.signal ? 128 + 15 : 1)
}

/**
* valimart 主入口。自带子命令在本进程处理完就返回退出码；其余交给宿主二进制（launchHost）。
* @param {string[]} argv process.argv.slice(2)
* @param {{ runtimeDir: string, version: string, qwenVersion: string }} opts
*/
export async function main(argv, { runtimeDir, version, qwenVersion }) {
  const io = createPrompter()
  // 启动器自己打印同步结果；公司盘的逐条日志只在出错时有用，这里不往终端写
  setDriveLogSink(() => {})
  const [first, ...rest] = argv
  try {
    switch (first) {
      case 'login':
        return exitCodeOf(await cmdLogin(rest, io))
      case 'logout':
        await logout()
        io.say('已登出公司网关')
        return 0
      case 'status':
        return exitCodeOf(await cmdStatus(io))
      case 'discover':
        return exitCodeOf(await cmdDiscover(io))
      case 'sync':
        return exitCodeOf(await cmdSync(io))
      case 'update':
        io.say(`valimart code 不走自动更新：到发布页 ${RELEASE_PAGE} 下载新版重装。`)
        return 0
      case 'auth':
        io.say('valimart code 只用公司网关登录：valimart login。Qwen Code 的其它登录方式在这里关掉了。')
        return 0
      default:
        break
    }
    if (argv.length === 1 && (first === '--version' || first === '-v')) {
      io.say(`valimart-code ${version}（Qwen Code ${qwenVersion}）`)
      return 0
    }
    if (hasFlag(argv, '--help', '-h') && !(first && QWEN_SUBCOMMANDS.has(first))) {
      process.stdout.write(OWN_HELP)
      return 0
    }
    if (needsGatewayLogin(argv) && !(await ensureGatewayLogin(io, { headless: isHeadless(argv) }))) return 1
  } catch (err) {
    if (err instanceof PromptCancelled) {
      io.say('已取消')
      return 130
    }
    process.stderr.write(`valimart：${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  return launchHost({ runtimeDir, argv })
}

/** 子命令返回 true/false（成功 / 失败）或 undefined；统一成进程退出码。 */
function exitCodeOf(result) {
  return result === false ? 1 : 0
}
