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
 *
 * 内核来源：本机前缀（默认 ~/.company-desk/kernel）版本等于 pin 且补丁齐 → 复制；否则重新 install-kernel 到 build/kernel-stage（要网络）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PIN, defaultPrefix, locateKernel } from './kernel/locate.mjs'
import { ALL_MARKS, missingPatches, resolveMarkFile } from './kernel/patches.mjs'
import { findTar, readGatewayUrl } from './lib/bootstrap.mjs'
import { digestFiles, makeBuildId, patchGatewayUrl, shouldPrune } from './lib/payload.mjs'

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

// 1. node.exe
fs.mkdirSync(path.join(out, 'runtime'))
fs.copyFileSync(process.execPath, path.join(out, 'runtime', path.basename(process.execPath)))
log(`runtime: ${path.basename(process.execPath)} ${process.version}`)

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
  fs.cpSync(prefix, stage, { recursive: true, force: true })
}
kernel = locateKernel(stage)
if (!kernel) die(`暂存目录里找不到内核：${stage}`)

// 3. 修剪
const pruned = { files: 0, bytes: 0 }
if (!has('--no-prune')) {
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
        if (fs.readdirSync(p).length === 0) fs.rmdirSync(p)
      } else if (shouldPrune(path.relative(stage, p))) {
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
  const uiSrc = path.join(root, 'plugins', 'desk-ui')
  fs.cpSync(uiSrc, path.join(out, 'plugins', 'desk-ui'), { recursive: true, filter: (s) => path.relative(uiSrc, s).split(path.sep)[0] !== 'src' })
}

// 7. profile（预置网关地址）
fs.mkdirSync(path.join(out, 'profile'))
const repoPatch = path.join(root, 'profile', 'cordis.patch.yml')
fs.writeFileSync(path.join(out, 'profile', 'cordis.patch.yml'), patchGatewayUrl(fs.readFileSync(repoPatch, 'utf8'), gateway))

// 8. 脚本
for (const rel of ['scripts/kernel/patches.mjs', 'scripts/kernel/locate.mjs', 'scripts/kernel/pin.json', 'scripts/lib/bootstrap.mjs', 'scripts/lib/find-tar.mjs', 'scripts/lib/kernel-update.mjs', 'scripts/lib/lan-protocol.mjs']) {
  fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true })
  fs.copyFileSync(path.join(root, rel), path.join(out, rel))
}

// 9. payload.json
const digest = digestFiles([path.join(out, 'profile', 'cordis.patch.yml'), path.join(out, 'plugins', 'desk-ui', 'lib', 'client.js'), path.join(out, 'plugins', 'desk-host', 'lib', 'index.js'), path.join(out, 'plugins', 'desk-host', 'lib', 'lan-discover.js'), path.join(out, 'scripts', 'lib', 'bootstrap.mjs'), path.join(out, 'scripts', 'lib', 'find-tar.mjs'), path.join(out, 'scripts', 'lib', 'kernel-update.mjs'), path.join(out, 'scripts', 'lib', 'lan-protocol.mjs'), path.join(out, 'scripts', 'kernel', 'patches.mjs')])
const payload = {
  buildId: makeBuildId({ version, kernelVersion: kernel.version, digest }),
  version,
  builtAt: new Date().toISOString(),
  node: process.version,
  kernel: { package: PIN.package, version: kernel.version, root: path.relative(stage, kernel.root).replace(/\\/g, '/') },
  gatewayUrl: readGatewayUrl(path.join(out, 'profile', 'cordis.patch.yml')),
  pruned,
}
fs.writeFileSync(path.join(out, 'payload.json'), JSON.stringify(payload, null, 2) + '\n')
log(`payload.json buildId=${payload.buildId} gateway=${payload.gatewayUrl}`)
log(`完成：${out}`)
