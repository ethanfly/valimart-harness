/**
 * 把指定版本的 @deepseek-ai/dsh 打成带公司补丁的 kernel.tar（不对照 pin.json）。
 * 失败不写 outDir/<ver>/ 半成品：先在 staging 里打包装，成功再 rename。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ALL_MARKS, applyKernelPatches, missingPatches } from '../kernel/patches.mjs'
import { PIN, locateKernel, refuseLivePrefix, stampPath, missingProfilePlugins } from '../kernel/locate.mjs'
import { findTar } from './find-tar.mjs'
import { shouldPrune, stripKernelPeerLinks } from './payload.mjs'
import { SOURCE_REPO, hashFile, resolveNpmRegistry } from './kernel-update.mjs'
import { npmEnvironment, npmInvocation } from './npm-cli.mjs'
import { prepareWindowsNativeDependencies } from './kernel-native.mjs'

const KERNEL_PACKAGE = '@deepseek-ai/dsh'

function assertSafeVersion(version) {
  if (typeof version !== 'string' || !version || version.includes('/') || version.includes('\\') || version.includes('..')) {
    const err = new Error('非法版本号')
    err.code = 'bad_version'
    throw err
  }
}

export function formatNpmInstallError({ status, signal, stdout = '', stderr = '' }) {
  const code = status ?? signal ?? '?'
  const text = `${stdout || ''}\n${stderr || ''}`.replace(/\r\n/g, '\n').trim()
  const tail = text.length > 800 ? text.slice(-800) : text
  const extra = tail ? `\n${tail}` : ''
  return `npm install 失败（退出码 ${code}）。${extra}`
}

export function assertPublishedOnNpm(version, npmVersions) {
  if (npmVersions == null) return
  if (!npmVersions.includes(version)) {
    const err = new Error(`GitHub 有 tag，npm 没有 @deepseek-ai/dsh@${version}`)
    err.code = 'not_on_npm'
    throw err
  }
}

export function installKernelPackage({ version, prefix, log = () => {}, registry }) {
  assertSafeVersion(version)
  const refused = refuseLivePrefix(prefix)
  if (refused) throw new Error(refused)
  fs.mkdirSync(prefix, { recursive: true })
  const spec = `${KERNEL_PACKAGE}@${version}`
  log(`安装 ${spec} → ${prefix}`)
  const npm = npmInvocation()
  const resolved = resolveNpmRegistry(registry)
  const windows = process.platform === 'win32'
  const options = {
    encoding: 'utf8',
    windowsHide: true,
    shell: npm.shell,
    env: { ...npmEnvironment(), npm_config_prefix: prefix, npm_config_registry: resolved },
  }
  const runNpm = (args) => {
    const r = spawnSync(npm.cmd, [...npm.pre, ...args], options)
    if (r.status === 0) return
    const err = new Error(
      formatNpmInstallError({
        status: r.status,
        signal: r.signal,
        stdout: r.stdout,
        stderr: r.stderr || r.error?.message,
      }),
    )
    err.code = 'npm_install_failed'
    throw err
  }
  runNpm(['install', '-g', spec, '--prefix', prefix, '--no-fund', '--no-audit', ...(windows ? ['--ignore-scripts'] : [])])
  if (windows) {
    const kernel = locateKernel(prefix)
    if (!kernel) throw new Error(`npm 报告成功，但 ${prefix} 下找不到内核目录`)
    prepareWindowsNativeDependencies({ kernelRoot: kernel.root, log })
    log('执行依赖安装脚本（koffi、node-pty 等）')
    runNpm(['rebuild', '-g', '--prefix', prefix, '--ignore-scripts=false', '--no-fund', '--no-audit'])
  }
  // 内核就位后装 profile 插件（dsh-browser / anysearch 等）。它们随 kernel.tar 离线分发，
  // 员工机器不需要 npm/pnpm；装进内核前缀的 node_modules 会被 profile 的 bundle 解析到。
  installProfilePlugins({ prefix, log, registry })
}

/** 只读检查一个插件是否已装进内核前缀、版本是否对。 */
export function profilePluginStatus({ prefix, plugins = PIN.profilePlugins ?? [] }) {
  const modules = path.join(prefix, 'node_modules')
  return plugins.map((plugin) => {
    let version = null
    try {
      version = JSON.parse(fs.readFileSync(path.join(modules, plugin.name, 'package.json'), 'utf8')).version ?? null
    } catch {
      version = null
    }
    return { name: plugin.name, want: plugin.version, version, ok: version === plugin.version }
  })
}

/** stamp.profilePlugins 条目是 `name@version`（scoped 名里还有 @）。 */
export function stampPluginName(entry) {
  const s = String(entry ?? '')
  const i = s.lastIndexOf('@')
  return i > 0 ? s.slice(0, i) : s
}

/**
 * 卸掉前缀里已不在 pin 的 profile 插件（含历史上随包的 dsh-better-sidebar）。
 * 只删插件自己的目录，不扫它曾经拷进来的第三方依赖。
 */
export function removeUnpinnedProfilePlugins({ prefix, plugins = PIN.profilePlugins ?? [], log = () => {} }) {
  const keep = new Set(plugins.map((p) => p.name))
  let stamp = null
  try {
    stamp = JSON.parse(fs.readFileSync(stampPath(prefix), 'utf8'))
  } catch {
    stamp = null
  }
  const names = new Set(['dsh-better-sidebar', ...(stamp?.profilePlugins ?? []).map(stampPluginName)])
  const modules = path.join(prefix, 'node_modules')
  const removed = []
  for (const name of names) {
    if (!name || keep.has(name)) continue
    const dir = path.join(modules, name)
    if (!fs.existsSync(dir)) continue
    fs.rmSync(dir, { recursive: true, force: true })
    log(`卸载插件 ${name}`)
    removed.push(name)
  }
  return removed
}

/**
 * 把 pin.json 的 profilePlugins 装进内核前缀。
 *
 * 不能直接 `npm install --prefix <内核前缀>`：那会按新的 package.json 重算整棵树，
 * 把 `npm install -g` 装进去的内核（及其 500+ 依赖）当 extraneous 删掉。
 * 做法：每个插件先装到 `<前缀>/.profile-plugin-stage/<名字>`（--omit=peer，不把 @deepseek-ai
 * 的 peer 拷进来覆盖内核），再按白名单拷进 `<前缀>/node_modules`（已存在的一律保留，
 * 插件自己的包除外），最后删 staging。prune 里的包只服务预打包的浏览器端 bundle，不拷。
 */
export function installProfilePlugins({ prefix, plugins = PIN.profilePlugins ?? [], log = () => {}, registry, force = false }) {
  removeUnpinnedProfilePlugins({ prefix, plugins, log })
  if (!plugins.length) return []
  const modules = path.join(prefix, 'node_modules')
  fs.mkdirSync(modules, { recursive: true })
  const npm = npmInvocation()
  const resolved = resolveNpmRegistry(registry)
  const options = {
    encoding: 'utf8',
    windowsHide: true,
    shell: npm.shell,
    env: {
      ...npmEnvironment(),
      npm_config_registry: resolved,
      // 插件依赖里 playwright/patchright 的 postinstall 会下载 Chromium；公司 profile 用系统 Edge，跳过。
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
      PUPPETEER_SKIP_DOWNLOAD: '1',
    },
  }
  const installed = []
  for (const plugin of plugins) {
    if (!force && profilePluginStatus({ prefix, plugins: [plugin] })[0].ok) {
      log(`插件已在：${plugin.name}@${plugin.version}`)
      installed.push(plugin.name)
      continue
    }
    const stage = path.join(prefix, '.profile-plugin-stage', plugin.name.replace(/[/@]/g, '_'))
    fs.rmSync(stage, { recursive: true, force: true })
    fs.mkdirSync(stage, { recursive: true })
    const run = (args) => {
      const r = spawnSync(npm.cmd, [...npm.pre, ...args], { ...options, cwd: stage })
      if (r.status === 0) return
      throw new Error(
        formatNpmInstallError({ status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr || r.error?.message }),
      )
    }
    const spec = `${plugin.name}@${plugin.version}`
    log(`安装插件 ${spec} → ${stage}`)
    run(['install', spec, '--prefix', stage, '--omit=peer', '--ignore-scripts', '--no-fund', '--no-audit'])
    // 原生依赖（node-pty）需要 install/postinstall 才能拿到 win32-x64 的 conpty.dll。
    run(['rebuild', '--prefix', stage, '--ignore-scripts=false', '--no-fund', '--no-audit'])
    copyPluginModules({ stageModules: path.join(stage, 'node_modules'), targetModules: modules, pluginName: plugin.name, prune: plugin.prune ?? [], log })
    fs.rmSync(stage, { recursive: true, force: true })
    installed.push(plugin.name)
    log(`插件就位：${plugin.name}@${plugin.version}`)
  }
  return installed
}

/** 把 staging 的 node_modules 按白名单拷进内核前缀：跳过 @deepseek-ai（peer）、prune、已存在的依赖与点文件。 */
function copyPluginModules({ stageModules, targetModules, pluginName, prune, log = () => {} }) {
  const pruned = new Set(prune)
  const skipped = []
  const copyEntry = (src, dst, name) => {
    if (fs.existsSync(dst) && name !== pluginName) {
      skipped.push(name)
      return
    }
    fs.rmSync(dst, { recursive: true, force: true })
    fs.cpSync(src, dst, { recursive: true, force: true })
  }
  for (const entry of fs.readdirSync(stageModules)) {
    if (entry.startsWith('.') || entry === '@deepseek-ai' || pruned.has(entry)) {
      skipped.push(entry)
      continue
    }
    const src = path.join(stageModules, entry)
    if (entry.startsWith('@')) {
      const dstScope = path.join(targetModules, entry)
      fs.mkdirSync(dstScope, { recursive: true })
      for (const child of fs.readdirSync(src)) {
        const name = `${entry}/${child}`
        if (pruned.has(name)) {
          skipped.push(name)
          continue
        }
        copyEntry(path.join(src, child), path.join(dstScope, child), name)
      }
    } else {
      copyEntry(src, path.join(targetModules, entry), entry)
    }
  }
  if (skipped.length) log(`跳过 ${skipped.length} 项（peer / prune / 已存在）：${skipped.slice(0, 6).join(', ')}${skipped.length > 6 ? ' …' : ''}`)
}


function pruneTree(root) {
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
        if (fs.readdirSync(p).length === 0) fs.rmdirSync(p)
      } else if (shouldPrune(path.relative(root, p))) {
        fs.unlinkSync(p)
      }
    }
  }
  walk(root)
}

/**
 * 假定 prefix 里已有内核，只打补丁 + 修剪 + tar。
 * @returns {{ tarPath: string, manifest: object }}
 */
export function packPatchedPrefix({ prefix, version, outDir, skillsDir, log = () => {} }) {
  assertSafeVersion(version)
  const refused = refuseLivePrefix(prefix)
  if (refused) throw new Error(refused)

  const kernel = locateKernel(prefix)
  if (!kernel) throw new Error(`前缀里没有内核：${prefix}`)
  if (kernel.version !== version) throw new Error(`装到的是 ${kernel.version}，不是 ${version}`)

  const counters = applyKernelPatches({ kernelRoot: kernel.root, skillsDir, log })
  const left = missingPatches(kernel.root)
  if (left.length) throw new Error(`打完补丁仍缺：${left.join(', ')}`)

  const missing = missingProfilePlugins(kernel)
  if (missing.length) throw new Error(`拒绝打包：缺少必需插件 ${missing.join(', ')}`)

  fs.writeFileSync(
    stampPath(prefix),
    JSON.stringify(
      {
        package: KERNEL_PACKAGE,
        version: kernel.version,
        kernelRoot: kernel.root,
        skillsDir,
        patchedAt: new Date().toISOString(),
        marks: ALL_MARKS.map((m) => m.marks[0]),
      },
      null,
      2,
    ) + '\n',
  )
  log(`补丁：新打 ${counters.applied} 处，已有 ${counters.skipped} 处；技能根 ${skillsDir}`)

  const dest = path.join(outDir, version)
  const destStaging = dest + '.staging'
  const packRoot = prefix + '-pack'
  fs.rmSync(destStaging, { recursive: true, force: true })
  fs.rmSync(packRoot, { recursive: true, force: true })
  try {
    fs.cpSync(prefix, packRoot, { recursive: true, force: true })
    // 运行时 peer 链接不进包（cpSync 会展开 junction，tar 会翻倍）；员工机器启动时 linkKernelPeers 重建
    stripKernelPeerLinks(packRoot)
    pruneTree(packRoot)
    fs.mkdirSync(destStaging, { recursive: true })
    const tarPath = path.join(destStaging, 'kernel.tar')
    const r = spawnSync(findTar(), ['-cf', tarPath, '-C', packRoot, '.'], { encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) throw new Error(r.stderr || r.error?.message || 'tar')
    const sha256 = hashFile(tarPath)
    const manifest = {
      package: KERNEL_PACKAGE,
      version: kernel.version,
      sha256,
      bytes: fs.statSync(tarPath).size,
      sourceTag: 'dsh-v' + version,
      sourceRepo: SOURCE_REPO,
      patched: `新打 ${counters.applied} 处，已有 ${counters.skipped} 处`,
      builtAt: new Date().toISOString(),
    }
    fs.writeFileSync(path.join(destStaging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    fs.rmSync(dest, { recursive: true, force: true })
    fs.renameSync(destStaging, dest)
    return { tarPath: path.join(dest, 'kernel.tar'), manifest }
  } catch (err) {
    fs.rmSync(destStaging, { recursive: true, force: true })
    throw err
  } finally {
    fs.rmSync(packRoot, { recursive: true, force: true })
  }
}

/**
 * npm 安装指定版本后再 packPatchedPrefix。
 * `installer` 可注入（测试用）；默认才 spawn npm。
 */
export function prepareKernelTarball({ version, prefix, outDir, skillsDir, log = () => {}, installer, registry, npmVersions }) {
  assertSafeVersion(version)
  assertPublishedOnNpm(version, npmVersions)
  const install = installer ?? installKernelPackage
  install({ version, prefix, log, registry })
  return packPatchedPrefix({ prefix, version, outDir, skillsDir, log })
}
