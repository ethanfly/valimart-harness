/**
 * 把指定版本的 @deepseek-ai/dsh 打成带公司补丁的 kernel.tar（不对照 pin.json）。
 * 失败不写 outDir/<ver>/ 半成品：先在 staging 里打包装，成功再 rename。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ALL_MARKS, applyKernelPatches, missingPatches } from '../kernel/patches.mjs'
import { locateKernel, refuseLivePrefix, stampPath } from '../kernel/locate.mjs'
import { findTar } from './find-tar.mjs'
import { shouldPrune } from './payload.mjs'
import { SOURCE_REPO, hashFile, resolveNpmRegistry } from './kernel-update.mjs'
import { npmInvocation } from './npm-cli.mjs'

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

function defaultInstall({ version, prefix, log, registry }) {
  fs.mkdirSync(prefix, { recursive: true })
  const spec = `${KERNEL_PACKAGE}@${version}`
  log(`安装 ${spec} → ${prefix}`)
  const npm = npmInvocation()
  const resolved = resolveNpmRegistry(registry)
  const r = spawnSync(npm.cmd, [...npm.pre, 'install', '-g', spec, '--prefix', prefix, '--no-fund', '--no-audit'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: npm.shell,
    env: { ...process.env, npm_config_prefix: prefix, npm_config_registry: resolved },
  })
  if (r.status !== 0) {
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
  const install = installer ?? ((opts) => defaultInstall({ ...opts, registry }))
  install({ version, prefix, log, registry })
  return packPatchedPrefix({ prefix, version, outDir, skillsDir, log })
}
