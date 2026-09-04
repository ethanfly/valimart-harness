/**
 * 安装 THE DIVA 的 dsh profile（名为 desk）：
 *   $DSH_HOME/profiles/desk/{package.json, cordis.patch.yml, node_modules/@company-desk/*}
 * 并让本仓库的插件能解析到 dsh 内置包（company-desk/node_modules/@deepseek-ai → dsh 的扁平回退目录）。
 *
 * 内核：先跑 scripts/install-kernel.mjs（幂等）——把锁定版本的 @deepseek-ai/dsh 装进独立前缀并打公司补丁；
 * 已装好时只是校验一遍。不需要任何别的仓库。
 * 用法：node scripts/setup-profile.mjs [--prefix <dir>] [--dsh-home <dir>]
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defaultDshHome, defaultPrefix, locateKernel } from './kernel/locate.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (k) => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : undefined
}
const prefix = path.resolve(argOf('--prefix') ?? defaultPrefix())
const dshHome = path.resolve(argOf('--dsh-home') ?? defaultDshHome())

// 0) 内核（装 / 校验 / 补缺的补丁）
{
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'install-kernel.mjs'), '--prefix', prefix, '--dsh-home', dshHome], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error('[setup-profile] 内核未就绪，停止。')
    process.exit(1)
  }
}
const kernel = locateKernel(prefix)
if (!kernel) {
  console.error(`[setup-profile] ${prefix} 下找不到 dsh 内核`)
  process.exit(1)
}
const dshBin = kernel.bin

const link = (linkPath, target) => {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  try {
    const st = fs.lstatSync(linkPath)
    if (st.isSymbolicLink()) {
      if (path.resolve(fs.readlinkSync(linkPath)) === path.resolve(target)) return 'kept'
      fs.unlinkSync(linkPath)
    } else if (st.isDirectory()) {
      fs.rmSync(linkPath, { recursive: true, force: true })
    } else fs.unlinkSync(linkPath)
  } catch {
    /* 不存在 */
  }
  fs.symlinkSync(target, linkPath, 'junction')
  return 'linked'
}

// 1) profile 目录与清单
const profileDir = path.join(dshHome, 'profiles', 'desk')
fs.mkdirSync(profileDir, { recursive: true })
const manifestPath = path.join(profileDir, 'package.json')
const manifest = {
  name: 'dsh-profile-desk',
  private: true,
  description: 'THE DIVA · 企业交付工作台（company-desk）',
  dependencies: {
    '@company-desk/desk-host': `file:${path.join(root, 'plugins', 'desk-host').replace(/\\/g, '/')}`,
    '@company-desk/desk-ui': `file:${path.join(root, 'plugins', 'desk-ui').replace(/\\/g, '/')}`,
  },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
fs.writeFileSync(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
fs.copyFileSync(path.join(root, 'profile', 'cordis.patch.yml'), path.join(profileDir, 'cordis.patch.yml'))
console.log(`[setup-profile] profile: ${profileDir}`)

// 2) 公司插件链接进 profile 的 node_modules
for (const name of ['desk-host', 'desk-ui']) {
  const r = link(path.join(profileDir, 'node_modules', '@company-desk', name), path.join(root, 'plugins', name))
  console.log(`[setup-profile] @company-desk/${name} ${r}`)
}

// 3) 让本仓库插件解析到 dsh 内置包：先让 dsh 自愈扁平回退目录（--dump-default-config 不启动服务）
try {
  execFileSync(process.execPath, [dshBin, '--profile', 'desk', '--dump-default-config'], { stdio: 'ignore', env: { ...process.env, DSH_HOME: dshHome } })
} catch (err) {
  console.warn(`[setup-profile] dsh 自检未通过（继续）：${err.message}`)
}
const flat = path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
if (!fs.existsSync(flat)) {
  console.error(`[setup-profile] 缺少 dsh 扁平回退目录 ${flat}，请先成功启动一次 dsh。`)
  process.exit(1)
}
const r = link(path.join(root, 'node_modules', '@deepseek-ai'), flat)
console.log(`[setup-profile] node_modules/@deepseek-ai → ${flat} (${r})`)

// 4) 状态目录
fs.mkdirSync(path.join(dshHome, 'desk'), { recursive: true })
console.log(`[setup-profile] 完成。启动：node scripts/launch.mjs（或 node "${dshBin}" --profile desk --no-open）`)
