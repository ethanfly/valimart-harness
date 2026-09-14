/**
 * 打 macOS Intel（darwin-x64）客户端：一条命令从 Windows 直接产出能双击运行的 .app zip。
 *
 *   node scripts/build-mac-client.mjs [--gateway <url>] [--electron <ver>] [--node <ver>] [--out <zip>]
 *
 * 为什么不是 electron-builder：26.x 在 Windows 上直接拒绝 --mac（"Build for macOS is supported only on macOS"），
 * 而且 Windows 的 7z 会把 .framework 里的符号链接展开、丢掉 unix 可执行位——解到 macOS 上 app 起不来。
 * 所以这里自己读 Electron 官方 zip、自己写 zip（见 scripts/lib/zip.mjs / mac-app.mjs）。
 *
 * 产物：dist/valimart-harness-<installerVersion>-mac-x64.zip（内含 valimart harness.app）
 * 依赖网络：Electron darwin-x64 zip、Node darwin-x64 tar、4 个 darwin 原生依赖包，都缓存在 build/mac-cache/。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { prepareDarwinKernelStage, nodePtyDarwinRequirements, darwinSystemRequirements } from './lib/mac-kernel.mjs'
import { verifyMacSessionLock } from './lib/mac-session-lock.mjs'
import { buildMacAppZip } from './lib/mac-app.mjs'
import { openZip, isSymlinkMode } from './lib/zip.mjs'
import { findTar } from './lib/find-tar.mjs'
import { npmInvocation } from './lib/npm-cli.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (k, dflt) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] && !String(args[i + 1]).startsWith('-') ? args[i + 1] : dflt
}
const log = (m) => console.log(`[mac] ${m}`)
const die = (m) => {
  console.error(`[mac] ${m}`)
  process.exit(1)
}

const APP_NAME = 'valimart harness'
const APP_ID = 'team.ethan.valimart-harness'
const ELECTRON_VERSION = argOf('--electron', '44.1.1')
const NODE_VERSION = argOf('--node', '22.23.2').replace(/^v/, '')
const gateway = argOf('--gateway', process.env.DESK_GATEWAY_URL)
const cacheDir = path.resolve(argOf('--cache', path.join(root, 'build', 'mac-cache')))
const kernelPrefix = path.resolve(argOf('--kernel-prefix', path.join(os.homedir(), '.company-desk', 'kernel')))
const stage = path.resolve(argOf('--stage', path.join(root, 'build', 'kernel-mac-stage')))
const payloadOut = path.resolve(argOf('--payload-out', path.join(root, 'build', 'payload-mac')))
const npmCache = path.join(cacheDir, 'npm')

// electron-builder.yml 的 files 白名单（mac 版用同一套桌面端代码）
const DESKTOP_FILES = [
  'main.js',
  'preload.js',
  'dsh-web-url.cjs',
  'prefs.cjs',
  'image-menu.cjs',
  'splash.html',
  'close-prompt.html',
  'close-prompt-preload.js',
  'build/icon.png',
  'build/valimart-wordmark.png',
  'build/valimart-mark.png',
  'package.json',
]

// ---------- 下载 / 缓存 ----------
async function download(url, dest, label) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    log(`${label} 已缓存（${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB）`)
    return dest
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  log(`下载 ${label} …\n      ${url}`)
  const tmp = `${dest}.part`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${url}`)
  const total = Number(res.headers.get('content-length') || 0)
  let got = 0
  const out = fs.createWriteStream(tmp)
  const { Readable } = await import('node:stream')
  await new Promise((resolve, reject) => {
    Readable.fromWeb(res.body)
      .on('data', (c) => {
        got += c.length
        if (total && got % (16 * 1024 * 1024) < c.length) process.stdout.write(`\r      ${(got / 1024 / 1024).toFixed(0)}/${(total / 1024 / 1024).toFixed(0)} MB`)
      })
      .pipe(out)
      .on('finish', resolve)
      .on('error', reject)
  })
  process.stdout.write('\r')
  fs.renameSync(tmp, dest)
  log(`${label} → ${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB`)
  return dest
}

async function ensureCache() {
  const electronZip = path.join(cacheDir, `electron-v${ELECTRON_VERSION}-darwin-x64.zip`)
  const nodeTgz = path.join(cacheDir, `node-v${NODE_VERSION}-darwin-x64.tar.gz`)
  await download(`https://npmmirror.com/mirrors/electron/${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-darwin-x64.zip`, electronZip, `Electron ${ELECTRON_VERSION} darwin-x64`)
  await download(`https://npmmirror.com/mirrors/node/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-x64.tar.gz`, nodeTgz, `Node ${NODE_VERSION} darwin-x64`)
  return { electronZip, nodeTgz }
}

/** 从 node tar 里取出 bin/node，返回路径（缓存到 build/mac-cache/node-vX-darwin-x64/bin/node）。 */
function extractNodeBinary(nodeTgz, nodeVersion) {
  const outDir = path.join(cacheDir, `node-v${nodeVersion}-darwin-x64`)
  const nodeBin = path.join(outDir, 'bin', 'node')
  if (fs.existsSync(nodeBin)) return nodeBin
  fs.mkdirSync(outDir, { recursive: true })
  const r = spawnSync(findTar(), ['-xzf', nodeTgz, '-C', outDir, '--strip-components=1', `node-v${nodeVersion}-darwin-x64/bin/node`], { stdio: 'pipe', encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) die(`解包 node tar 失败：${(r.stderr || r.error?.message || '').trim()}`)
  if (!fs.existsSync(nodeBin)) die(`解包里没有 bin/node：${nodeBin}`)
  return nodeBin
}

/** 4 个 darwin 原生依赖包用 npm pack 预取（@img/sharp-libvips-darwin-x64 等）。 */
function ensureNpmPackages() {
  const specs = [
    '@img/sharp-darwin-x64@0.35.4',
    '@img/sharp-libvips-darwin-x64@1.3.3',
    '@koromix/koffi-darwin-x64@3.2.1',
    '@vscode/ripgrep-darwin-x64@1.18.0',
    'node-addon-require-builtin-darwin-x64@0.1.5',
  ]
  const expected = ['img-sharp-darwin-x64-0.35.4.tgz', 'img-sharp-libvips-darwin-x64-1.3.3.tgz', 'koromix-koffi-darwin-x64-3.2.1.tgz', 'vscode-ripgrep-darwin-x64-1.18.0.tgz', 'node-addon-require-builtin-darwin-x64-0.1.5.tgz']
  for (const pty of [...nodePtyDarwinRequirements(kernelPrefix), ...darwinSystemRequirements(kernelPrefix)]) {
    if (!expected.includes(pty.tgz)) {
      specs.push(pty.spec)
      expected.push(pty.tgz)
    }
  }
  const missingSpecs = specs.filter((_, i) => !fs.existsSync(path.join(npmCache, expected[i])))
  if (!missingSpecs.length) {
    log('darwin 原生依赖包已缓存')
    return
  }
  fs.mkdirSync(npmCache, { recursive: true })
  log('npm pack darwin 原生依赖包 …')
  const npm = npmInvocation()
  const r = spawnSync(npm.cmd, [...npm.pre, 'pack', '--ignore-scripts', '--registry=https://registry.npmmirror.com', ...missingSpecs], { cwd: npmCache, stdio: 'inherit', shell: npm.shell, windowsHide: true })
  if (r.status !== 0) die('npm pack 失败（需要网络 / npm）')
  const missing = expected.filter((f) => !fs.existsSync(path.join(npmCache, f)))
  if (missing.length) die(`npm pack 后仍缺：${missing.join(', ')}`)
}

// ---------- 图标 ----------
/** 用内核里自带的 sharp 缩放 build/icon.png（Windows 上也能跑），拿不到就退回现成尺寸。 */
async function buildIconPngs(sourceIcon, sizes = [32, 64, 128, 256, 512, 1024]) {
  const pngs = new Map()
  const sharpDir = path.join(kernelPrefix, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'sharp')
  try {
    const req = createRequire(path.join(sharpDir, 'package.json'))
    const sharp = req('sharp')
    for (const size of sizes) pngs.set(size, await sharp(sourceIcon).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer())
    log(`图标：sharp 缩放 ${sizes.join('/')} px`)
  } catch (err) {
    log(`sharp 不可用（${err.message}），退回现成尺寸`)
    pngs.clear()
    const fallback = [path.join(root, 'desktop', 'build', 'icon-512.png'), path.join(root, 'desktop', 'build', 'icon.png')]
    for (const f of fallback) {
      if (!fs.existsSync(f)) continue
      const size = /icon-(\d+)/.exec(path.basename(f))?.[1]
      pngs.set(size ? Number(size) : 1024, fs.readFileSync(f))
    }
    if (!pngs.size) die('找不到任何图标源文件')
  }
  return pngs
}

// ---------- 验证 ----------
/** 读 Mach-O 的架构（thin 或 fat 都认）；不是 Mach-O 返回 null。 */
function machoArch(file) {
  const b = fs.readFileSync(file)
  const magic = b.readUInt32LE(0)
  if (magic === 0xfeedfacf || magic === 0xfeedface) {
    const cpu = b.readUInt32LE(4)
    return cpu === 0x01000007 ? 'x86_64' : cpu === 0x0100000c ? 'arm64' : `thin:0x${cpu.toString(16)}`
  }
  if (magic === 0xcafebabe || magic === 0xbebafeca) {
    const n = b.readUInt32BE(4)
    const archs = []
    for (let i = 0; i < n; i++) {
      const cpu = b.readUInt32BE(8 + i * 20)
      archs.push(cpu === 0x01000007 ? 'x86_64' : cpu === 0x0100000c ? 'arm64' : `0x${cpu.toString(16)}`)
    }
    return `fat[${archs.join(',')}]`
  }
  return null
}

function verify(z, { appName, appId }) {
  const problems = []
  const byName = z.byName
  const appRoot = `${appName}.app`
  const need = [
    `${appRoot}/Contents/MacOS/${appName}`,
    `${appRoot}/Contents/Info.plist`,
    `${appRoot}/Contents/Resources/icon.icns`,
    `${appRoot}/Contents/Resources/app/main.js`,
    `${appRoot}/Contents/Resources/payload/payload.json`,
    `${appRoot}/Contents/Resources/payload/kernel.tar`,
    `${appRoot}/Contents/Resources/payload/runtime/node`,
  ]
  for (const n of need) if (!byName.has(n)) problems.push(`缺 ${n}`)
  for (const suffix of ['', ' (GPU)', ' (Plugin)', ' (Renderer)']) {
    const exe = `${appRoot}/Contents/Frameworks/${appName} Helper${suffix}.app/Contents/MacOS/${appName} Helper${suffix}`
    if (!byName.has(exe)) problems.push(`缺 Helper 可执行 ${exe}`)
    else if ((byName.get(exe).mode & 0o777) !== 0o755) problems.push(`Helper 权限不是 755：${exe}`)
  }
  const mainExe = byName.get(`${appRoot}/Contents/MacOS/${appName}`)
  if (mainExe && (mainExe.mode & 0o777) !== 0o755) problems.push(`主可执行权限不是 755：${mainExe.mode.toString(8)}`)
  const link = byName.get(`${appRoot}/Contents/Frameworks/Electron Framework.framework/Versions/Current`)
  if (!link || !link.isSymlink) problems.push('Electron Framework/Versions/Current 不是符号链接')
  else if (z.read(link).toString() !== 'A') problems.push('Versions/Current 指向不对')
  const plist = byName.get(`${appRoot}/Contents/Info.plist`)
  if (plist) {
    const text = z.read(plist).toString('utf8')
    if (!text.includes(`<string>${appId}</string>`)) problems.push('Info.plist 的 CFBundleIdentifier 不对')
    if (!text.includes(`<key>CFBundleExecutable</key>\n\t<string>${appName}</string>`)) problems.push('Info.plist 的 CFBundleExecutable 不对')
    if (!text.includes('<string>icon.icns</string>')) problems.push('Info.plist 没指向 icon.icns')
  }
  const noMode = z.entries.filter((e) => e.modeInferred).length
  if (noMode) problems.push(`${noMode} 个条目没有 unix 权限位`)
  const symlinks = z.entries.filter((e) => isSymlinkMode(e.mode)).length
  return { problems, symlinks, entries: z.entries.length }
}

/** 整包验证：结构 / 权限位 / 符号链接 / plist / kernel.tar 原生件 / node 架构。 */
function verifyArtifact(zipFile) {
  const z = openZip(zipFile)
  const report = verify(z, { appName: APP_NAME, appId: APP_ID })
  log(`验证：${report.entries} 条目，${report.symlinks} 个符号链接`)
  if (report.problems.length) {
    for (const p of report.problems) console.error(`[mac]   ✗ ${p}`)
    die('验证不通过')
  }
  const payload = JSON.parse(z.read(z.byName.get(`${APP_NAME}.app/Contents/Resources/payload/payload.json`)).toString('utf8'))
  if (payload.platform !== 'darwin' || payload.arch !== 'x64') die(`payload.json 平台不对：${payload.platform}-${payload.arch}`)

  // kernel.tar 里不能有 win32 原生件，且必须有 darwin-x64 的
  const tmpDir = path.join(root, 'build', 'mac-verify')
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.mkdirSync(tmpDir, { recursive: true })
  const tarPath = path.join(tmpDir, 'kernel.tar')
  fs.writeFileSync(tarPath, z.read(z.byName.get(`${APP_NAME}.app/Contents/Resources/payload/kernel.tar`)))
  const tr = spawnSync(findTar(), ['-tf', tarPath], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  if (tr.status !== 0) die(`kernel.tar 读不出来：${(tr.stderr || tr.error?.message || '').trim()}`)
  const names = tr.stdout.split(/\r?\n/)
  const mustHave = [
    'node-pty/prebuilds/darwin-x64/pty.node',
    'node-pty/prebuilds/darwin-x64/spawn-helper',
    '@img/sharp-darwin-x64/package.json',
    '@img/sharp-libvips-darwin-x64/package.json',
    '@koromix/koffi-darwin-x64/package.json',
    '@vscode/ripgrep-darwin-x64/bin/rg',
    'node-addon-require-builtin-darwin-x64/package.json',
  ]
  const mustNot = ['sharp-win32-x64', 'koffi-win32-x64', 'ripgrep-win32-x64', 'node-addon-require-builtin-win32-x64-msvc', 'prebuilds/win32-x64/', 'prebuilds/linux-x64/']
  const missing = mustHave.filter((m) => !names.some((n) => n.includes(m)))
  const stale = mustNot.filter((m) => names.some((n) => n.includes(m)))
  if (missing.length) die(`kernel.tar 缺 darwin 原生件：${missing.join(', ')}`)
  if (stale.length) die(`kernel.tar 里还有 win32 件：${stale.join(', ')}`)
  const winBinaries = names.filter((n) => /\.(dll|exe)$/i.test(n))
  if (winBinaries.length) die(`kernel.tar 里还有 Windows 二进制：${winBinaries.slice(0, 3).join(', ')}`)

  // 关键原生件必须是 Mach-O x86_64（不是 PE/DLL）
  const natives = [
    'node-pty/prebuilds/darwin-x64/pty.node',
    'node-pty/prebuilds/darwin-x64/spawn-helper',
    '@img/sharp-darwin-x64/lib/sharp-darwin-x64-0.35.4.node',
    '@img/sharp-libvips-darwin-x64/lib/libvips-cpp.8.18.6.dylib',
    '@koromix/koffi-darwin-x64/darwin_x64/koffi.node',
    '@vscode/ripgrep-darwin-x64/bin/rg',
    'node-addon-require-builtin-darwin-x64/prebuilt/darwin-x64-napi-v9.node',
  ]
  const nativeDir = path.join(tmpDir, 'natives')
  fs.mkdirSync(nativeDir, { recursive: true })
  for (const rel of natives) {
    const entryName = names.find((n) => n.includes(rel))
    if (!entryName) die(`kernel.tar 里找不到 ${rel}`)
    const r = spawnSync(findTar(), ['-xf', tarPath, '-C', nativeDir, entryName], { encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) die(`解不出 ${rel}：${(r.stderr || r.error?.message || '').trim()}`)
    const abs = path.join(nativeDir, entryName.replace(/^\.\//, ''))
    if (!fs.existsSync(abs)) die(`解出后找不到 ${abs}`)
    const arch = machoArch(abs)
    if (!arch || (!arch.includes('x86_64') && arch !== 'x86_64')) die(`${rel} 不是 x86_64 Mach-O（${arch ?? '不是 Mach-O'}）`)
  }

  // 会话锁：mac 上必须走 koffi flock 兜底（fs-ext 在 Windows 构建机上编不出来）
  const lockEntry = names.find((n) => n.includes('dsh-session-persistence-jsonl/lib/index.js'))
  if (!lockEntry) die('kernel.tar 里找不到 dsh-session-persistence-jsonl/lib/index.js')
  const lockDir = path.join(tmpDir, 'lockcheck')
  fs.mkdirSync(lockDir, { recursive: true })
  const lr = spawnSync(findTar(), ['-xf', tarPath, '-C', lockDir, lockEntry], { encoding: 'utf8', windowsHide: true })
  if (lr.status !== 0) die(`解不出会话锁文件：${(lr.stderr || lr.error?.message || '').trim()}`)
  const lockSource = fs.readFileSync(path.join(lockDir, lockEntry.replace(/^\.\//, '')), 'utf8')
  const lockKind = verifyMacSessionLock({ lockSource, readEntry: (suffix) => {
    // 使用与 session persistence 相同的 node_modules，避免误认另一份嵌套依赖。
    const modulePrefix = lockEntry.slice(0, lockEntry.indexOf('@deepseek-ai/dsh-session-persistence-jsonl/'))
    const entry = `${modulePrefix}${suffix}`
    if (!names.includes(entry)) die(`kernel.tar 缺会话锁依赖：${entry}`)
    const r = spawnSync(findTar(), ['-xf', tarPath, '-C', lockDir, entry], { encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) die(`解不出会话锁依赖：${entry} ${r.stderr || r.error?.message || ''}`)
    return fs.readFileSync(path.join(lockDir, entry.replace(/^\.\//, '')))
  } })
  log(`会话锁验证通过：${lockKind}`)

  // 运行时二进制是 x86_64 Mach-O
  const nodePath = path.join(tmpDir, 'node')
  fs.writeFileSync(nodePath, z.read(z.byName.get(`${APP_NAME}.app/Contents/Resources/payload/runtime/node`)))
  const arch = machoArch(nodePath)
  if (arch !== 'x86_64') die(`payload 的 node 不是 x86_64：${arch ?? '不是 Mach-O'}`)
  fs.rmSync(tmpDir, { recursive: true, force: true })
  return { ...report, tarEntries: names.length, payload }
}

// ---------- 主流程 ----------
const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version

// --verify-only <zip>：只验已有产物，不重新打包
const verifyOnly = argOf('--verify-only')
if (verifyOnly) {
  const r = verifyArtifact(path.resolve(verifyOnly))
  log(`验证通过：${path.resolve(verifyOnly)}（${r.entries} 条目 / kernel.tar ${r.tarEntries} 条 / gateway=${r.payload.gatewayUrl}）`)
  process.exit(0)
}

log(`目标 darwin-x64｜Electron ${ELECTRON_VERSION}｜Node ${NODE_VERSION}｜版本 ${pkgVersion}`)

if (!fs.existsSync(path.join(kernelPrefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))) {
  die(`内核前缀里没有 dsh：${kernelPrefix}（先跑 npm run kernel）`)
}

const { electronZip, nodeTgz } = await ensureCache()
ensureNpmPackages()
const nodeBin = extractNodeBinary(nodeTgz, NODE_VERSION)
log(`node 运行时：${nodeBin}`)

// 1) 内核 → darwin 前缀
const kernelStats = prepareDarwinKernelStage({ sourcePrefix: kernelPrefix, stage, cacheDir: npmCache, log })
log(`内核 stage 就绪：${stage}（注入 ${kernelStats.injected}，移除 win32 ${kernelStats.removedWin32}）`)

// 2) payload
log('构建 payload（build-payload.mjs --platform darwin --arch x64）…')
const payloadArgs = [path.join(root, 'scripts', 'build-payload.mjs'), '--platform', 'darwin', '--arch', 'x64', '--kernel-prefix', stage, '--runtime-node', nodeBin, '--out', payloadOut]
if (gateway) payloadArgs.push('--gateway', gateway)
const pr = spawnSync(process.execPath, payloadArgs, { stdio: 'inherit' })
if (pr.status !== 0) die(`build-payload 退出码 ${pr.status}`)
const payload = JSON.parse(fs.readFileSync(path.join(payloadOut, 'payload.json'), 'utf8'))
log(`payload：${payload.installerVersion} buildId=${payload.buildId} node=${payload.node} gateway=${payload.gatewayUrl}`)

// 3) 图标
const iconPngs = await buildIconPngs(path.join(root, 'desktop', 'build', 'icon.png'))

// 4) 组装 .app → zip
const outFile = path.resolve(argOf('--out', path.join(root, 'dist', `valimart-harness-${payload.installerVersion}-mac-x64.zip`)))
fs.mkdirSync(path.dirname(outFile), { recursive: true })
log(`组装 ${APP_NAME}.app → ${outFile}`)
const t0 = Date.now()
const built = buildMacAppZip({
  electronZip,
  outFile,
  appName: APP_NAME,
  appId: APP_ID,
  version: pkgVersion,
  copyright: payload.buildId ? `VMBUILD ${payload.buildId}` : '',
  iconPngs,
  appSourceDir: path.join(root, 'desktop'),
  appFiles: DESKTOP_FILES,
  payloadDir: payloadOut,
  log,
})
log(`写出 ${built.entries} 个条目，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，${(fs.statSync(outFile).size / 1024 / 1024).toFixed(1)} MB`)

// 5) 验证
const report = verifyArtifact(outFile)

log('全部验证通过')
log(`产物：${outFile}`)
log(`  ${APP_NAME}.app · Electron ${ELECTRON_VERSION} · Node ${payload.node} · ${(fs.statSync(outFile).size / 1024 / 1024).toFixed(1)} MB`)
log(`  kernel.tar 条目 ${report.tarEntries}，符号链接 ${report.symlinks}，gateway=${payload.gatewayUrl}`)
