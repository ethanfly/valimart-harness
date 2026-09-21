/**
 * 把客户端安装包要带的东西暂存到 build/payload/（electron-builder 的 extraResources 直接打包这个目录）：
 *   runtime/node.exe          构建机的 node（process.execPath）
 *   kernel.tar                打好补丁的内核前缀（修剪 .d.ts / source map / 其他平台 node-pty 预编译后 tar）
 *   plugins/                  desk-host、desk-ui（含已构建的 lib/client.js，不带 src/）
 *   profile/cordis.patch.yml  gatewayUrl 按 --gateway 替换
 *   scripts/                  kernel/{patches,locate}.mjs、kernel/pin.json、lib/{bootstrap,find-tar,kernel-update}.mjs
 *   payload.json              buildId / 版本 / 内核版本 / node 版本 / 默认网关
 *
 *   node scripts/build-payload.mjs [--gateway <url>] [--kernel-prefix <dir>] [--out <dir>] [--no-prune]
 *                                  [--platform <win32|darwin|linux>] [--arch <x64|arm64>] [--runtime-node <file>]
 *
 * 跨平台打包（如 Windows 上打 mac 客户端）必须用 --runtime-node 指定目标平台的 node 二进制；
 * 默认平台 = 构建机平台，此时直接用构建机的 node。
 * 内核来源：本机前缀（默认 ~/.company-desk/kernel）版本等于 pin 且补丁齐 → 复制；否则重新 install-kernel 到 build/kernel-stage（要网络）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PIN, defaultPrefix, locateKernel, missingProfilePlugins } from './kernel/locate.mjs'
import { ALL_MARKS, missingPatches, resolveMarkFile } from './kernel/patches.mjs'
import { findTar, readGatewayUrl } from './lib/bootstrap.mjs'
import { digestFiles, makeBuildId, makeInstallerVersion, patchGatewayUrl, shouldPrune, stripKernelPeerLinks } from './lib/payload.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const has = (k) => args.includes(k)
const argOf = (k, dflt) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] && !String(args[i + 1]).startsWith('-') ? args[i + 1] : dflt
}
const log = (m) => console.log(`[payload] ${m}`)
const die = (m) => {
  console.error(`[payload] ${m}`)
  process.exit(1)
}

/** Windows 上 fs.cpSync 跨盘复制 npm 前缀时，碰到 peer junction 会 EPERM/EINVAL 且几乎不打堆栈。
 *  robocopy /XJ 跳过 junction（打包前本来就要剥掉 peer 链接）。 */
function copyKernelPrefix(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  if (process.platform === 'win32') {
    const r = spawnSync(
      'robocopy',
      [src, dest, '/E', '/XJ', '/COPY:DAT', '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS', '/NP'],
      { stdio: 'inherit', windowsHide: true },
    )
    if (r.error) throw r.error
    const code = r.status ?? 16
    if (code >= 8) throw new Error(`robocopy 退出码 ${code}`)
    return
  }
  fs.cpSync(src, dest, { recursive: true, force: true })
}

const out = path.resolve(argOf('--out', path.join(root, 'build', 'payload')))
const stage = path.join(root, 'build', 'kernel-stage')
const gateway = argOf('--gateway', process.env.DESK_GATEWAY_URL)
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version

// --out 可以是任意路径：绝不能整目录 rmSync（配错会删掉项目树）。只清空它的直接子项，且目录像项目根就拒绝。
if (fs.existsSync(out)) {
  if (fs.existsSync(path.join(out, 'package.json')) || fs.existsSync(path.join(out, '.git'))) {
    die('--out 看起来是项目目录（含 package.json/.git），拒绝清空：' + out)
  }
  for (const entry of fs.readdirSync(out)) {
    fs.rmSync(path.join(out, entry), { recursive: true, force: true })
  }
}
fs.mkdirSync(out, { recursive: true })

// 1. 运行时 node（目标平台）
const targetPlatform = argOf('--platform', process.platform)
const targetArch = argOf('--arch', process.arch)
const runtimeSrc = argOf('--runtime-node')
const runtimeName = targetPlatform === 'win32' ? 'node.exe' : 'node'
if (!['win32', 'darwin', 'linux'].includes(targetPlatform)) die(`不支持的 --platform：${targetPlatform}`)
if (!['x64', 'arm64', 'ia32'].includes(targetArch)) die(`不支持的 --arch：${targetArch}`)
fs.mkdirSync(path.join(out, 'runtime'))
let runtimeVersion = process.version
if (runtimeSrc) {
  const abs = path.resolve(runtimeSrc)
  if (!fs.existsSync(abs)) die(`--runtime-node 不存在：${abs}`)
  fs.copyFileSync(abs, path.join(out, 'runtime', runtimeName))
  runtimeVersion = (/v(\d+\.\d+\.\d+)/.exec(abs)?.[1] ?? 'unknown')
  log(`runtime: ${path.basename(abs)} → runtime/${runtimeName}（v${runtimeVersion}，目标 ${targetPlatform}-${targetArch}）`)
} else if (targetPlatform === process.platform && targetArch === process.arch) {
  fs.copyFileSync(process.execPath, path.join(out, 'runtime', runtimeName))
  log(`runtime: ${path.basename(process.execPath)} ${process.version}`)
} else {
  die(`跨平台打包（目标 ${targetPlatform}-${targetArch}，构建机 ${process.platform}-${process.arch}）必须给 --runtime-node <该平台的 node 二进制>`)
}

// 2. 内核 → build/kernel-stage
let prefix = argOf('--kernel-prefix') ? path.resolve(argOf('--kernel-prefix')) : defaultPrefix()
let kernel = locateKernel(prefix)
fs.rmSync(stage, { recursive: true, force: true })
if (!kernel || kernel.version !== PIN.version || missingPatches(kernel.root).length) {
  log(`本机前缀 ${prefix} 不可用（${!kernel ? '没有内核' : kernel.version !== PIN.version ? `版本 ${kernel.version} ≠ ${PIN.version}` : '补丁不齐'}），重新安装到 ${stage}（需要网络）`)
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'install-kernel.mjs'), '--prefix', stage, '--dsh-home', path.join(root, 'build', 'dsh-home-tmp')], { stdio: 'inherit' })
  if (r.status !== 0) die('内核安装失败')
} else {
  log(`复制内核 ${prefix} → ${stage}`)
  try {
    copyKernelPrefix(prefix, stage)
  } catch (err) {
    die(`复制内核失败：${err.stack || err.message}`)
  }
}
kernel = locateKernel(stage)
if (!kernel) die(`暂存目录里找不到内核：${stage}`)
const missingPlugins = missingProfilePlugins(kernel)
if (missingPlugins.length) die(`内核缺少必需插件：${missingPlugins.join(', ')}，请先 npm run kernel`)
// 运行时链接（linkKernelPeers）不进包：cpSync 会把 junction 展开成实体，tar 会翻倍
const strippedPeers = stripKernelPeerLinks(stage)
if (strippedPeers) log(`剥离运行时 peer 链接 ${strippedPeers} 个（启动时重建）`)

// 3. 修剪
const pruned = { files: 0, bytes: 0 }
if (!has('--no-prune')) {
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
        if (fs.readdirSync(p).length === 0) fs.rmdirSync(p)
      } else if (shouldPrune(path.relative(stage, p), targetPlatform, targetArch)) {
        pruned.bytes += fs.statSync(p).size
        pruned.files++
        fs.unlinkSync(p)
      }
    }
  }
  walk(stage)
  log(`修剪 ${pruned.files} 个文件，${(pruned.bytes / 1024 / 1024).toFixed(1)} MB`)
}

// 4. 校验：补丁齐、补丁文件语法完好
const left = missingPatches(kernel.root)
if (left.length) die(`修剪后缺补丁：${left.join(', ')}`)
for (const entry of ALL_MARKS) {
  const file = resolveMarkFile(kernel.root, entry)
  if (!file) {
    if (entry.optional) continue
    die(`补丁文件缺失 ${entry.file}`)
  }
  if (!file.endsWith('.js')) continue
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (err) {
    die(`补丁文件语法检查失败 ${entry.file}: ${err.stderr || err.message}`)
  }
}
log(`内核 ${kernel.version}，${ALL_MARKS.length} 处补丁齐全`)

// 5. kernel.tar
const tarFile = path.join(out, 'kernel.tar')
const r = spawnSync(findTar(), ['-cf', tarFile, '-C', stage, '.'], { stdio: 'inherit' })
if (r.status !== 0) die(`tar 失败（${r.status}）`)
log(`kernel.tar ${(fs.statSync(tarFile).size / 1024 / 1024).toFixed(1)} MB`)

// 6. 插件（先构建浏览器端 bundle）
{
  const b = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-client.mjs')], { stdio: 'inherit' })
  if (b.status !== 0) die('build-client 失败')
  fs.cpSync(path.join(root, 'plugins', 'desk-host'), path.join(out, 'plugins', 'desk-host'), { recursive: true })
  fs.cpSync(path.join(root, 'plugins', 'desk-image'), path.join(out, 'plugins', 'desk-image'), { recursive: true })
  const uiSrc = path.join(root, 'plugins', 'desk-ui')
  fs.cpSync(uiSrc, path.join(out, 'plugins', 'desk-ui'), { recursive: true, filter: (s) => path.relative(uiSrc, s).split(path.sep)[0] !== 'src' })
}

// 7. profile（预置网关地址）
fs.mkdirSync(path.join(out, 'profile'))
const repoPatch = path.join(root, 'profile', 'cordis.patch.yml')
fs.writeFileSync(path.join(out, 'profile', 'cordis.patch.yml'), patchGatewayUrl(fs.readFileSync(repoPatch, 'utf8'), gateway))

// 8. 脚本
for (const rel of ['scripts/kernel/patches.mjs', 'scripts/kernel/locate.mjs', 'scripts/kernel/pin.json', 'scripts/lib/bootstrap.mjs', 'scripts/lib/find-tar.mjs', 'scripts/lib/kernel-update.mjs', 'scripts/lib/lan-protocol.mjs', 'scripts/lib/git-head.mjs', 'scripts/lib/model-input.mjs', 'scripts/lib/client-update.mjs']) {
  fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true })
  fs.copyFileSync(path.join(root, rel), path.join(out, rel))
}

// 9. payload.json
// T11：mixed 模块全部文件进 digest——任何 mixed 代码变化都改变 buildId（锁版/升级判断覆盖新模块）。
const mixedDir = path.join(out, 'plugins', 'desk-host', 'lib', 'mixed')
const mixedFiles = fs.existsSync(mixedDir) ? fs.readdirSync(mixedDir).filter((f) => f.endsWith('.js')).map((f) => path.join(mixedDir, f)) : []
if (!fs.existsSync(mixedDir)) die('payload 缺少 plugins/desk-host/lib/mixed（T01–T10 模块未随包）')
const digest = digestFiles([path.join(out, 'profile', 'cordis.patch.yml'), path.join(out, 'plugins', 'desk-ui', 'lib', 'client.js'), path.join(out, 'plugins', 'desk-host', 'lib', 'index.js'), path.join(out, 'plugins', 'desk-host', 'lib', 'session-image.js'), path.join(out, 'plugins', 'desk-host', 'lib', 'lan-discover.js'), ...mixedFiles, path.join(out, 'plugins', 'desk-image', 'lib', 'index.js'), path.join(out, 'scripts', 'lib', 'bootstrap.mjs'), path.join(out, 'scripts', 'lib', 'find-tar.mjs'), path.join(out, 'scripts', 'lib', 'kernel-update.mjs'), path.join(out, 'scripts', 'lib', 'lan-protocol.mjs'), path.join(out, 'scripts', 'lib', 'git-head.mjs'), path.join(out, 'scripts', 'lib', 'model-input.mjs'), path.join(out, 'scripts', 'lib', 'client-update.mjs'), path.join(out, 'scripts', 'kernel', 'patches.mjs')])
const now = new Date()
const installerVersion = makeInstallerVersion({ version, now })
const payload = {
  buildId: makeBuildId({ version, kernelVersion: kernel.version, digest, now }),
  version,
  installerVersion,
  builtAt: now.toISOString(),
  platform: targetPlatform,
  arch: targetArch,
  node: runtimeVersion,
  kernel: { package: PIN.package, version: kernel.version, root: path.relative(stage, kernel.root).replace(/\\/g, '/') },
  gatewayUrl: readGatewayUrl(path.join(out, 'profile', 'cordis.patch.yml')),
  pruned,
}
fs.writeFileSync(path.join(out, 'payload.json'), JSON.stringify(payload, null, 2) + '\n')
log(`payload.json version=${payload.installerVersion} buildId=${payload.buildId} platform=${targetPlatform}-${targetArch} node=${runtimeVersion} gateway=${payload.gatewayUrl}`)
log(`完成：${out}`)
