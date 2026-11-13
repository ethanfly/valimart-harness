/**
 * 打 valimart code 安装包（1.0 原生版）：dist/valimart-code-<版本>-<平台>.tar.gz / .zip。
 *
 * 产物结构（解压即用，不需要装 Node）：
 *   valimart-code/
 *     bin/valimart            入口包装（sh）
 *     bin/valimart.cmd        Windows 入口
 *     bin/valimart-host[.exe] 白标宿主（原 Qwen Code，Bun 编译）
 *     lib/lib/*.mjs           启动器、网关客户端、公司盘、任务卡、命令实现
 *     lib/runtime/*.mjs       入口 / desk MCP / SessionStart hook / 状态栏
 *     package.json NOTICE.md README.md
 *
 * 流程（与 dsh 内核补丁同一套规矩）：
 * 1. 按 pin.json 的 commit 从 GitHub 拉源码 tarball（缓存，校验 sha256）；
 * 2. 解开，打 scripts/patches.mjs 的锚点补丁（白标 env、/desk-* 命令、/auth 提示、默认登录类型）；
 * 3. npm ci（--ignore-scripts：sharp/node-pty 用平台预编译）+ 上游 patch-package + vendor ripgrep；
 * 4. 白标（BRAND_* → bun build define），bun 交叉编译各平台；
 * 5. 按平台归档到 dist/。
 *
 * 用法：node packages/valimart-code/scripts/build.mjs [--targets bun-linux-x64,bun-windows-x64,bun-darwin-arm64] [--no-pack]
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findTar } from '../../../scripts/lib/find-tar.mjs'
import { applyPatches, PATCHES } from './patches.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
const repoRoot = path.resolve(pkgRoot, '..', '..')
const buildDir = path.join(repoRoot, 'build', 'valimart-code')
const cacheDir = path.join(buildDir, 'cache')
const srcDir = path.join(buildDir, 'src')
const distDir = path.join(repoRoot, 'dist')

const pin = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'pin.json'), 'utf8'))
const own = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
const notice = fs.readFileSync(path.join(pkgRoot, 'NOTICE.md'), 'utf8')
/** 与仓库 scripts/lib 共用、打包时要一起拷进包内的模块。 */
const SHARED_MODULES = ['lan-protocol.mjs', 'drive-mirror-index.mjs', 'model-input.mjs']
const log = (msg) => console.log(`[valimart-code] ${msg}`)

/** 默认只编当前平台（预编译原生依赖只装得上宿主平台）；跨平台交给 CI 的原生 runner。 */
const DEFAULT_TARGETS = [hostTarget()]

function hostTarget() {
  const os = process.platform === 'win32' ? 'windows' : process.platform
  return `bun-${os}-${process.arch}`
}
const TARGET_EXT = { 'bun-windows-x64': '.exe' }
/** vendor ripgrep 目录名（scripts/download_vendor_rg.ts 的命名）。 */
const TARGET_RG = {
  'bun-linux-x64': 'x64-linux',
  'bun-windows-x64': 'x64-win32',
  'bun-darwin-arm64': 'arm64-darwin',
}
/** 平台归档后缀名。 */
const TARGET_PLAT = {
  'bun-linux-x64': 'linux-x64',
  'bun-windows-x64': 'windows-x64',
  'bun-darwin-arm64': 'darwin-arm64',
}

/**
 * 白标常量（packages/core/src/config/brand.ts 的 process.env 读取，编译期内联）。
 * brand-env.js 的补丁让这些键读构建环境；同一编译批次里它们作为 bun define 注入。
 */
const BRAND_ENV = {
  BRAND_NAME: 'Valimart Code',
  BRAND_CLI_NAME: 'valimart code',
  BRAND_CLI_SLUG: 'valimart-code',
  BRAND_CLI_BIN: 'valimart',
  BRAND_FIXED_CLI_BIN: 'valimart',
  BRAND_PROCESS_LOG_STEM: 'valimart',
  BRAND_NPM_PACKAGE: 'valimart-code',
  BRAND_NPM_PACKAGES: 'valimart-code',
  BRAND_USER_CONFIG_DIR_NAME: '.valimart',
  BRAND_PROJECT_CONFIG_DIR_NAME: '.valimart',
  BRAND_IGNORE_FILE: '.valimartignore',
  BRAND_PLUGIN_META_DIR: '.valimart-plugin',
  BRAND_ENV_PREFIX: 'VALIMART_',
  BRAND_FIXED_ENV_PREFIX: 'VALIMART_',
  BRAND_EVENT_NAMESPACE: 'valimart',
  BRAND_HOMEBREW_TOKEN: 'valimart-code',
  BRAND_KEYCHAIN_PREFIX: 'valimart-code',
  BRAND_MCP_CLIENT_NAME: 'valimart-code',
  BRAND_OAUTH_SERVICE: 'valimart-code',
  BRAND_WEBSITE_URL: 'https://ethanfly.github.io/valimart-harness/',
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true, ...opts })
  if (r.status !== 0) {
    const tail = (r.stderr || r.stdout || r.error?.message || '').trim().slice(-1500)
    throw new Error(`${path.basename(cmd)} ${args.join(' ')} 失败（${r.status}）：${tail}`)
  }
  return r.stdout
}

function sha256Of(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** pin.commit 的源码 tarball：首次下载后把 sha256 回填进 pin.json，之后必须一致。 */
function fetchSource() {
  fs.mkdirSync(cacheDir, { recursive: true })
  const file = path.join(cacheDir, `qwen-code-${pin.commit}.tar.gz`)
  if (!fs.existsSync(file)) {
    log(`下载 ${pin.repository}/archive/${pin.commit}.tar.gz`)
    run('curl', ['-sSL', '--retry', '3', '-o', file, `${pin.repository}/archive/${pin.commit}.tar.gz`])
  }
  const got = sha256Of(file)
  if (!pin.sourceSha256) {
    pin.sourceSha256 = got
    fs.writeFileSync(path.join(pkgRoot, 'pin.json'), `${JSON.stringify(pin, null, 2)}\n`)
    log(`pin.json 回填 sourceSha256=${got}`)
  } else if (got !== pin.sourceSha256) {
    throw new Error(`源码 tarball sha256 不符：期望 ${pin.sourceSha256}，实际 ${got}`)
  }
  return file
}

function extract(tarball) {
  fs.rmSync(srcDir, { recursive: true, force: true })
  fs.mkdirSync(buildDir, { recursive: true })
  run(findTar(), ['-xzf', tarball, '-C', buildDir])
  const from = fs
    .readdirSync(buildDir)
    .filter((n) => n.startsWith('qwen-code-') && fs.statSync(path.join(buildDir, n)).isDirectory())
    .map((n) => path.join(buildDir, n))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
    .at(-1)
  if (!from || !fs.existsSync(path.join(from, 'package.json'))) throw new Error('源码 tarball 结构不对：没找到含 package.json 的目录')
  fs.renameSync(from, srcDir)
  const pkg = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8'))
  if (!String(pkg.version).startsWith('1.0.')) throw new Error(`上游版本 ${pkg.version} 不是 1.0.x：先重审 pin.json 与补丁`)
}

function prepareSource() {
  const { applied } = applyPatches(srcDir, PATCHES, log)
  log(`补丁 ${applied.length}/${PATCHES.length}`)
  // 锁文件里的阿里内网 registry 外网不通；这些包在 npmjs 上同版本同 integrity，换源即可。
  const lock = path.join(srcDir, 'package-lock.json')
  fs.writeFileSync(lock, fs.readFileSync(lock, 'utf8').replaceAll('https://registry.anpm.alibaba-inc.com/', 'https://registry.npmjs.org/'))
  fs.writeFileSync(path.join(srcDir, '.npmrc'), 'node-linker=hoisted\n')
  log('npm ci --ignore-scripts（sharp/node-pty 用平台预编译）')
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', 'https://registry.npmjs.org'], { cwd: srcDir })
  run('npx', ['patch-package', '--error-on-fail'], { cwd: srcDir })
}

function vendorRipgrep(targets) {
  for (const target of targets) {
    const rg = path.join(srcDir, 'packages', 'core', 'dist', 'vendor', 'ripgrep', TARGET_RG[target], process.platform === 'win32' ? 'rg.exe' : 'rg')
    if (fs.existsSync(rg)) continue
    run('bun', ['run', 'scripts/download_vendor_rg.ts', '--target', target], { cwd: srcDir })
  }
}

/** 逐平台编译（交叉目标没法在本机跑冒烟，上游 smoke 会自行跳过）。 */
function compileTargets(targets) {
  const outs = []
  for (const target of targets) {
    log(`bun compile ${target}`)
    run('bun', ['run', 'scripts/build_qwen_bun_binary.ts', '--target', target], {
      cwd: srcDir,
      env: { ...process.env, ...BRAND_ENV, PRODUCT_NAME: BRAND_ENV.BRAND_CLI_BIN },
    })
    const out = path.join(srcDir, 'dist-bun', `${BRAND_ENV.BRAND_CLI_BIN}${TARGET_EXT[target] ?? ''}`)
    if (!fs.existsSync(out)) throw new Error(`编译产物缺失：${out}`)
    outs.push({ target, file: out })
  }
  return outs
}

/** POSIX 入口：宿主二进制自带 Bun 当解释器，跑启动器（登录 / 状态 / 再 spawn 宿主）。 */
function wrapperSh() {
  return '#!/bin/sh\nBUN_BE_BUN=1 exec "$(dirname "$0")/valimart-host" run "$(dirname "$0")/../lib/runtime/valimart.mjs" "$@"\n'
}

/** Windows 入口：同一套逻辑。 */
function wrapperCmd() {
  return [
    '@echo off',
    'setlocal',
    'set BUN_BE_BUN=1',
    '"%~dp0valimart-host.exe" run "%~dp0..\\lib\\runtime\\valimart.mjs" %*',
    '',
  ].join('\r\n')
}

/** 产物归档：valimart-code/{bin,lib,package.json,NOTICE.md,README.md}。 */
function packArtifacts(built) {
  fs.mkdirSync(distDir, { recursive: true })
  const results = []
  for (const { target, file } of built) {
    const plat = TARGET_PLAT[target]
    const stage = path.join(buildDir, `stage-${plat}`)
    const pkg = path.join(stage, 'valimart-code')
    fs.rmSync(stage, { recursive: true, force: true })
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true })
    fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true })
    // 宿主二进制改名 valimart-host：bin/ 下的 valimart / valimart.cmd 才是入口包装。
    const hostName = `valimart-host${TARGET_EXT[target] ?? ''}`
    fs.copyFileSync(file, path.join(pkg, 'bin', hostName))
    fs.chmodSync(path.join(pkg, 'bin', hostName), 0o755)
    fs.cpSync(path.join(pkgRoot, 'lib'), path.join(pkg, 'lib', 'lib'), { recursive: true })
    // 与 pi / Claude 插件共用的模块（仓库 scripts/lib）：打包时拷进包内，归档才自包含。
    for (const shared of SHARED_MODULES) fs.copyFileSync(path.join(repoRoot, 'scripts', 'lib', shared), path.join(pkg, 'lib', 'lib', shared))
    fs.cpSync(path.join(pkgRoot, 'runtime'), path.join(pkg, 'lib', 'runtime'), { recursive: true })
    fs.cpSync(path.join(pkgRoot, 'skills'), path.join(pkg, 'lib', 'runtime', 'skills'), { recursive: true })
    fs.writeFileSync(path.join(pkg, 'bin', 'valimart'), wrapperSh(), { mode: 0o755 })
    fs.writeFileSync(path.join(pkg, 'bin', 'valimart.cmd'), wrapperCmd())
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      `${JSON.stringify({ name: 'valimart-code', version: own.version, valimart: { qwenCode: pin.version } }, null, 2)}\n`,
    )
    fs.writeFileSync(path.join(pkg, 'NOTICE.md'), notice)
    fs.copyFileSync(path.join(pkgRoot, 'README.md'), path.join(pkg, 'README.md'))
    const base = `valimart-code-${own.version}-${plat}`
    const out = path.join(distDir, plat === 'windows-x64' ? `${base}.zip` : `${base}.tar.gz`)
    fs.rmSync(out, { force: true })
    if (plat === 'windows-x64') {
      const ps = `$ErrorActionPreference='Stop'; Compress-Archive -Path '${path.join(pkg, '*').replaceAll('/', '\\')}' -DestinationPath '${out.replaceAll('/', '\\')}' -Force`
      run('pwsh', ['-NoProfile', '-Command', ps])
    } else {
      run(findTar(), ['-czf', out, '-C', stage, 'valimart-code'])
    }
    fs.rmSync(stage, { recursive: true, force: true })
    results.push({ out, sha256: sha256Of(out), size: fs.statSync(out).size })
  }
  return results
}

function main() {
  const argOf = (name) => {
    const i = process.argv.indexOf(name)
    return i >= 0 ? process.argv[i + 1] : undefined
  }
  const targets = (argOf('--targets') ?? process.env.VALIMART_CODE_TARGETS ?? DEFAULT_TARGETS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const t of targets) {
    if (!TARGET_PLAT[t]) throw new Error(`不认识的目标 ${t}；支持 ${DEFAULT_TARGETS.join(', ')}`)
  }
  const tarball = fetchSource()
  extract(tarball)
  prepareSource()
  vendorRipgrep(targets)
  const built = compileTargets(targets)
  if (process.argv.includes('--no-pack')) {
    for (const b of built) log(`产物 ${b.file}`)
    return
  }
  for (const r of packArtifacts(built)) {
    log(`${path.relative(repoRoot, r.out)} ${r.size} 字节 sha256 ${r.sha256}`)
  }
}

main()
