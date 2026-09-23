/**
 * 安装 THE DIVA 的 dsh 内核：把固定版本的 @deepseek-ai/dsh（scripts/kernel/pin.json）装进一个独立前缀，
 * 再打公司补丁（scripts/kernel/patches.mjs）。幂等——装好了再跑只会补缺的补丁。
 *
 *   node scripts/install-kernel.mjs                 # 装到默认前缀 ~/.company-desk/kernel（旧的 ~/.tdh-coding-prefix 若已有内核则复用）
 *   node scripts/install-kernel.mjs --check         # 只检查不动文件：退出码 0=版本对、补丁齐；1=缺
 *   node scripts/install-kernel.mjs --force         # 强制重新 npm 安装再打补丁
 *   node scripts/install-kernel.mjs --verbose       # 连已打过的补丁也逐条列出
 *
 * 其他参数：
 *   --prefix <dir>       内核前缀（也可用 DESK_KERNEL_PREFIX / TDH_PREFIX）
 *   --dsh-home <dir>     dsh 数据目录（默认 ~/.dsh，或 DSH_HOME）；决定默认技能根
 *   --skills-dir <dir>   会话预设的技能根（默认 <dsh-home>/desk/drive/_shared/skills，即公司盘 _shared/skills 的本机镜像）
 *
 * 没有网络时不能装（要从 npm registry 下载内核）；装过一次之后离线也能启动。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ALL_MARKS, KernelPatchError, applyKernelPatches, missingPatches } from './kernel/patches.mjs'
import { PIN, defaultDshHome, defaultPrefix, locateKernel, refuseLivePrefix, stampPath } from './kernel/locate.mjs'
import { installKernelPackage, installProfilePlugins, profilePluginStatus } from './lib/kernel-prepare.mjs'

const args = process.argv.slice(2)
const has = (k) => args.includes(k)
const argOf = (k) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] && !String(args[i + 1]).startsWith('-') ? args[i + 1] : undefined
}
const prefix = path.resolve(argOf('--prefix') ?? defaultPrefix())
const dshHome = path.resolve(argOf('--dsh-home') ?? defaultDshHome())
const skillsDir = path.resolve(argOf('--skills-dir') ?? path.join(dshHome, 'desk', 'drive', '_shared', 'skills'))
const spec = `${PIN.package}@${PIN.version}`

const verbose = has('--verbose')
// 已打过的补丁逐条列出只在 --verbose 时输出；默认只报新打的和汇总，免得每次启动刷 20 行
const log = (msg) => {
  if (!verbose && /^(PATCH_ALREADY|PATCH_KERNEL_ROOT|PRESET_\w+_SKIP|ANYSEARCH_FETCH_SKIP)=/.test(msg)) return
  console.log(`[kernel] ${msg}`)
}
const die = (msg, code = 1) => {
  console.error(`[kernel] ${msg}`)
  process.exit(code)
}

const refused = refuseLivePrefix(prefix)
if (refused) die(`BLOCKED ${refused}`, 2)

// ---------- --check：只读 ----------
if (has('--check')) {
  const k = locateKernel(prefix)
  if (!k) die(`未安装：${prefix} 里没有 ${PIN.package}`)
  const problems = []
  if (k.version !== PIN.version) problems.push(`版本 ${k.version} ≠ 锁定 ${PIN.version}`)
  problems.push(...missingPatches(k.root).map((m) => `缺补丁 ${m}`))
  for (const p of profilePluginStatus({ prefix })) {
    if (!p.ok) problems.push(`缺插件 ${p.name}@${p.want}${p.version ? `（现为 ${p.version}）` : ''}`)
  }
  log(`prefix=${prefix}`)
  log(`kernel=${k.root} version=${k.version}`)
  if (problems.length) {
    for (const p of problems) console.error(`[kernel]   ✗ ${p}`)
    process.exit(1)
  }
  log(`✓ 版本正确、${ALL_MARKS.length} 处补丁齐全`)
  process.exit(0)
}

// ---------- 1. npm 装固定版本 ----------
let kernel = locateKernel(prefix)
const force = has('--force')
if (force || !kernel || kernel.version !== PIN.version) {
  if (kernel && kernel.version !== PIN.version) log(`前缀里是 ${kernel.version}，锁定版本是 ${PIN.version}，重新安装`)
  else if (kernel) log('--force：重新安装')
  else log(`安装 ${spec} → ${prefix}（首次需要从 npm registry 下载，几分钟）`)
  fs.mkdirSync(prefix, { recursive: true })
  try {
    installKernelPackage({ version: PIN.version, prefix, log })
  } catch (err) {
    die(err.message)
  }
  kernel = locateKernel(prefix)
  if (!kernel) die(`npm 报告成功，但 ${prefix} 下找不到内核目录`)
  if (kernel.version !== PIN.version) die(`装到的是 ${kernel.version}，不是 ${PIN.version}`)
  log(`内核就位：${kernel.root}`)
} else {
  log(`内核已在：${kernel.root}（${kernel.version}）`)
}

// ---------- 1.5 profile 插件（随内核前缀离线分发） ----------
try {
  installProfilePlugins({ prefix, log, force })
} catch (err) {
  die(`插件安装失败：${err.message}`)
}

// ---------- 2. 打补丁 ----------
let counters
try {
  counters = applyKernelPatches({ kernelRoot: kernel.root, skillsDir, log, expectVersion: PIN.version })
} catch (err) {
  if (err instanceof KernelPatchError) die(`PATCH_FAIL ${err.code}: ${err.detail}`)
  throw err
}
const left = missingPatches(kernel.root)
if (left.length) die(`打完补丁仍缺：${left.join(', ')}`)

// ---------- 3. 戳记 ----------
fs.writeFileSync(
  stampPath(prefix),
  JSON.stringify({ package: PIN.package, version: PIN.version, kernelRoot: kernel.root, skillsDir, profilePlugins: (PIN.profilePlugins ?? []).map((p) => `${p.name}@${p.version}`), patchedAt: new Date().toISOString(), marks: ALL_MARKS.map((m) => m.marks[0]) }, null, 2) + '\n',
)
log(`补丁：新打 ${counters.applied} 处，已有 ${counters.skipped} 处；技能根 ${skillsDir}`)
log(`KERNEL_OK prefix=${prefix} version=${kernel.version}`)
