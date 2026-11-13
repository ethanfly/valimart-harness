/**
 * 把三个平台归档发到 npm，再发入口包 valimart-code。
 *
 * 入口包只有 bin/valimart.js。真正的二进制在可选依赖里，npm 按 os/cpu 只装当前平台：
 *   valimart-code-linux-x64 / valimart-code-darwin-arm64 / valimart-code-windows-x64
 *
 * 用法（CI）：node scripts/publish-npm.mjs [归档目录]
 * 归档目录里递归找 valimart-code-<版本>-<平台>.tar.gz / .zip。
 * 已是这个版本就跳过。没有 NODE_AUTH_TOKEN 直接退出 0（和 pi 包同一规矩）。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
const repoRoot = path.resolve(pkgRoot, '../..')

export const PLATFORMS = [
  { id: 'linux-x64', npm: 'valimart-code-linux-x64', os: ['linux'], cpu: ['x64'], ext: '.tar.gz' },
  { id: 'darwin-arm64', npm: 'valimart-code-darwin-arm64', os: ['darwin'], cpu: ['arm64'], ext: '.tar.gz' },
  { id: 'windows-x64', npm: 'valimart-code-windows-x64', os: ['win32'], cpu: ['x64'], ext: '.zip' },
]

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })
  if (r.status !== 0) {
    const tail = (r.stderr || r.stdout || r.error?.message || '').trim().slice(-1500)
    throw new Error(`${path.basename(cmd)} ${args.join(' ')} 失败（${r.status}）：${tail}`)
  }
  return (r.stdout || '').trim()
}

function findTar() {
  if (process.platform === 'win32') {
    const git = 'C:\\Program Files\\Git\\usr\\bin\\tar.exe'
    if (fs.existsSync(git)) return git
  }
  return 'tar'
}

function npmArgs(args) {
  const npmrc = path.join(repoRoot, '.npmrc')
  // setup-node 把令牌写在仓库 .npmrc。平台包在临时目录里 publish，要指过去。
  return fs.existsSync(npmrc) ? [...args, '--userconfig', npmrc] : args
}

/** tar 顶层是 valimart-code/；Windows zip 是包内容本身。 */
export function packageRoot(extracted) {
  const nested = path.join(extracted, 'valimart-code', 'package.json')
  if (fs.existsSync(nested)) return path.dirname(nested)
  if (fs.existsSync(path.join(extracted, 'package.json'))) return extracted
  throw new Error(`归档里没有 package.json：${extracted}`)
}

export function rewritePackage(dir, spec, version) {
  const pkgPath = path.join(dir, 'package.json')
  const prev = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  if (prev.version !== version) {
    throw new Error(`${spec.npm} 归档版本 ${prev.version} 和入口包 ${version} 不一致`)
  }
  const next = {
    name: spec.npm,
    version,
    description: `valimart code 原生程序（${spec.id}）。由 valimart-code 按平台安装，不要单独装。`,
    license: 'UNLICENSED',
    author: 'ethanfly',
    os: spec.os,
    cpu: spec.cpu,
    repository: {
      type: 'git',
      url: 'git+https://github.com/ethanfly/valimart-harness.git',
      directory: 'packages/valimart-code',
    },
    files: ['bin', 'lib', 'NOTICE.md', 'README.md'],
    ...(prev.valimart ? { valimart: prev.valimart } : {}),
  }
  fs.writeFileSync(pkgPath, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

function extract(archive, dest) {
  fs.mkdirSync(dest, { recursive: true })
  if (archive.endsWith('.zip')) {
    run('unzip', ['-q', archive, '-d', dest])
  } else {
    run(findTar(), ['-xzf', archive, '-C', dest])
  }
}

function publishedVersion(name) {
  const r = spawnSync('npm', npmArgs(['view', name, 'version', '--registry', 'https://registry.npmjs.org']), {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (r.status !== 0) return ''
  return (r.stdout || '').trim()
}

function publishDir(dir, name, version) {
  const remote = publishedVersion(name)
  if (remote === version) {
    console.log(`skip ${name}@${version}（npm 已有）`)
    return
  }
  console.log(`publish ${name}@${version}`)
  run('npm', npmArgs(['publish', '--access', 'public', '--registry', 'https://registry.npmjs.org']), { cwd: dir, stdio: 'inherit' })
}

/**
 * npm 收下大包后可能先挂占位、过一阵才放出 tarball，个别版本还会卡死（npm/cli#9889）。
 * 入口包必须等三个平台包都能下载再发，否则会出现入口已上线、平台包装不上的半发布。
 */
async function waitDownloadable(name, version, { timeoutMs = 30 * 60_000, intervalMs = 30_000 } = {}) {
  const url = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await fetch(url, { method: 'HEAD' }).catch(() => null)
    if (res?.ok) {
      console.log(`ready ${name}@${version}`)
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`${name}@${version} 发布后 ${timeoutMs / 60_000} 分钟仍下载不到（${res?.status ?? '无响应'}），不发入口包`)
    }
    console.log(`waiting ${name}@${version}（${res?.status ?? '无响应'}）`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

export function archivesFor(distDir, version) {
  const files = walk(distDir)
  return PLATFORMS.map((spec) => {
    const base = `valimart-code-${version}-${spec.id}${spec.ext}`
    const found = files.filter((f) => path.basename(f) === base)
    if (found.length !== 1) throw new Error(`要有且只有一个 ${base}，实际 ${found.length} 个`)
    return { spec, file: found[0] }
  })
}

async function main() {
  if (!process.env.NODE_AUTH_TOKEN) {
    console.log('skip publish: 未配置 NODE_AUTH_TOKEN')
    return
  }
  const own = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
  const version = own.version
  for (const spec of PLATFORMS) {
    if (own.optionalDependencies?.[spec.npm] !== version) {
      throw new Error(`package.json optionalDependencies.${spec.npm} 必须等于 ${version}`)
    }
  }
  const distDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'dist'))
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'valimart-npm-'))
  try {
    for (const { spec, file } of archivesFor(distDir, version)) {
      const extracted = path.join(stageRoot, spec.id)
      extract(file, extracted)
      const root = packageRoot(extracted)
      rewritePackage(root, spec, version)
      publishDir(root, spec.npm, version)
    }
    for (const spec of PLATFORMS) await waitDownloadable(spec.npm, version)
    publishDir(pkgRoot, own.name, version)
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
