/**
 * 打 valimart code 安装包：dist/valimart-code-<版本>.tgz（npm i -g 这个文件即可，命令名 valimart）。
 *
 * 1. 按 pin.json 取固定版本的 @qwen-code/qwen-code（npm pack，缓存在 build/valimart-code/cache），校验 integrity；
 * 2. 解到 build/valimart-code/package，打 scripts/patches.mjs 的锚点补丁（对不上硬失败）；
 * 3. esbuild 把 runtime/*.mjs（连同 lib/ 和仓库 scripts/lib/ 的共用模块）打进 package/valimart/，带上技能；
 * 4. 换上 valimart-code 的 package.json / README / NOTICE，npm pack 到 dist/。
 *
 * 用法：node packages/valimart-code/scripts/build.mjs [--no-pack]
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { findTar } from '../../../scripts/lib/find-tar.mjs'
import { npmEnvironment, npmInvocation, resolveNpmRegistry } from '../../../scripts/lib/npm-cli.mjs'
import { applyPatches, PATCHES } from './patches.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
const repoRoot = path.resolve(pkgRoot, '..', '..')
const buildDir = path.join(repoRoot, 'build', 'valimart-code')
const cacheDir = path.join(buildDir, 'cache')
const outDir = path.join(buildDir, 'package')
const distDir = path.join(repoRoot, 'dist')

const pin = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'pin.json'), 'utf8'))
const own = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
const log = (msg) => console.log(`[valimart-code] ${msg}`)

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true, ...opts })
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(' ')} 失败（${r.status}）：${(r.stderr || r.stdout || r.error?.message || '').trim().slice(-800)}`)
  return r.stdout
}

function npm(args, cwd) {
  const inv = npmInvocation()
  return run(inv.cmd, [...inv.pre, ...args], { cwd, shell: inv.shell, env: npmEnvironment() })
}

function integrityOf(file) {
  return `sha512-${crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')}`
}

/** 固定版本的上游 tarball：缓存里有且 integrity 对得上就用缓存。 */
function fetchUpstream() {
  fs.mkdirSync(cacheDir, { recursive: true })
  const name = `${pin.upstream.replace(/^@/, '').replace('/', '-')}-${pin.version}.tgz`
  const file = path.join(cacheDir, name)
  if (!fs.existsSync(file) || integrityOf(file) !== pin.integrity) {
    log(`npm pack ${pin.upstream}@${pin.version}`)
    npm(['pack', `${pin.upstream}@${pin.version}`, '--pack-destination', cacheDir, '--registry', resolveNpmRegistry()], cacheDir)
  }
  const got = integrityOf(file)
  if (got !== pin.integrity) throw new Error(`${name} 的 integrity 不符：期望 ${pin.integrity}，实际 ${got}`)
  return file
}

function extract(tarball) {
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(buildDir, { recursive: true })
  // npm 包的根目录就叫 package/，正好解到 build/valimart-code/package
  run(findTar(), ['-xzf', tarball, '-C', buildDir])
  if (!fs.existsSync(path.join(outDir, 'cli-entry.js'))) throw new Error('上游包里没有 cli-entry.js：包结构变了，先看 pin.json 的版本')
}

async function bundleRuntime() {
  const runtimeDir = path.join(pkgRoot, 'runtime')
  const entryPoints = fs.readdirSync(runtimeDir).filter((f) => f.endsWith('.mjs')).map((f) => path.join(runtimeDir, f))
  await build({
    entryPoints,
    outdir: path.join(outDir, 'valimart'),
    outExtension: { '.js': '.mjs' },
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    chunkNames: 'shared/[name]-[hash]',
    legalComments: 'none',
    logLevel: 'warning',
  })
  fs.cpSync(path.join(pkgRoot, 'skills'), path.join(outDir, 'valimart', 'skills'), { recursive: true })
}

function writeManifest(upstream) {
  const manifest = {
    name: own.name,
    version: own.version,
    description: own.description,
    type: 'module',
    bin: { valimart: 'valimart/valimart.mjs' },
    files: [...new Set([...(upstream.files ?? []), 'valimart', 'NOTICE.md', 'README.qwen-code.md'])],
    engines: upstream.engines,
    optionalDependencies: upstream.optionalDependencies,
    config: upstream.config,
    license: 'SEE LICENSE IN LICENSE',
    author: own.author,
    homepage: own.homepage,
    repository: own.repository,
    valimart: { upstream: pin.upstream, qwenCode: pin.version, patches: PATCHES.map((p) => p.mark) },
  }
  fs.writeFileSync(path.join(outDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  fs.renameSync(path.join(outDir, 'README.md'), path.join(outDir, 'README.qwen-code.md'))
  fs.copyFileSync(path.join(pkgRoot, 'README.md'), path.join(outDir, 'README.md'))
  fs.writeFileSync(
    path.join(outDir, 'NOTICE.md'),
    [
      '# NOTICE',
      '',
      `valimart code ${own.version} 是 [Qwen Code](${pin.repository}) ${pin.version}（${pin.upstream}，Apache License 2.0，见 LICENSE）的二次开发版本。`,
      '',
      '相对上游 npm 包的改动：',
      '',
      `- 锚点补丁（${PATCHES.length} 个，源码见 valimart-harness 仓库 packages/valimart-code/scripts/patches.mjs）：${PATCHES.map((p) => p.mark).join('、')}`,
      '- 新增 `valimart/`：valimart 启动器、desk MCP 服务、SessionStart 公司上下文、状态栏、/desk-* 斜杠命令与公司技能',
      '- package.json 换成 valimart-code（命令名 valimart），原 README 改名 README.qwen-code.md',
      '',
    ].join('\n'),
  )
}

async function main() {
  const tarball = fetchUpstream()
  extract(tarball)
  const upstream = JSON.parse(fs.readFileSync(path.join(outDir, 'package.json'), 'utf8'))
  if (upstream.version !== pin.version) throw new Error(`上游包版本 ${upstream.version} 与 pin.json ${pin.version} 不符`)
  const { applied } = applyPatches(outDir, PATCHES, log)
  log(`补丁 ${applied.length}/${PATCHES.length}`)
  await bundleRuntime()
  writeManifest(upstream)
  if (process.argv.includes('--no-pack')) {
    log(`已生成 ${outDir}`)
    return
  }
  fs.mkdirSync(distDir, { recursive: true })
  npm(['pack', '--pack-destination', distDir], outDir)
  const file = path.join(distDir, `${own.name}-${own.version}.tgz`)
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  log(`${path.relative(repoRoot, file)} ${fs.statSync(file).size} 字节 sha256 ${sha256}`)
}

await main()
