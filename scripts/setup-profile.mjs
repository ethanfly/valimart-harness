/**
 * 安装 THE DIVA 的 dsh profile（名为 desk）：
 *   $DSH_HOME/profiles/desk/{package.json, cordis.patch.yml, node_modules/@company-desk/*}
 * 并让本仓库的插件能解析到 dsh 内置包（company-desk/node_modules/@deepseek-ai → dsh 的扁平回退目录）。
 *
 * 内核：先跑 scripts/install-kernel.mjs（幂等）——把锁定版本的 @deepseek-ai/dsh 装进独立前缀并打公司补丁；
 * 已装好时只是校验一遍。不需要任何别的仓库。逻辑在 scripts/lib/bootstrap.mjs。
 * 用法：node scripts/setup-profile.mjs [--prefix <dir>] [--dsh-home <dir>]
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultDshHome, defaultPrefix } from './kernel/locate.mjs'
import { ensureKernelDev, ensureProfile } from './lib/bootstrap.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (k) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] && !String(args[i + 1]).startsWith('-') ? args[i + 1] : undefined
}
const prefix = path.resolve(argOf('--prefix') ?? defaultPrefix())
const dshHome = path.resolve(argOf('--dsh-home') ?? defaultDshHome())
const log = (m) => console.log(`[setup-profile] ${m}`)

try {
  const kernel = ensureKernelDev({ prefix, dshHome, verify: true, log })
  ensureProfile({ profileName: 'desk', dshHome, root, pluginsDir: path.join(root, 'plugins'), patchFile: path.join(root, 'profile', 'cordis.patch.yml'), kernel, log })
  log(`完成。启动：node scripts/launch.mjs（或 node "${kernel.bin}" --profile desk --no-open）`)
} catch (err) {
  console.error(`[setup-profile] ${err.message}`)
  process.exit(1)
}
