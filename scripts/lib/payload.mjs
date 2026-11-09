/**
 * build-payload.mjs 用到的纯函数（单测覆盖）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 内核修剪：只删运行期绝不加载的东西。relPath 相对内核前缀根。
 *  targetPlatform/targetArch = 目标客户端平台（默认构建机平台），决定保留哪一份 node-pty 预编译。 */
export function shouldPrune(relPath, targetPlatform = process.platform, targetArch = process.arch) {
  const p = relPath.replace(/\\/g, '/')
  if (/\.d\.(ts|mts|cts)$/.test(p)) return true
  if (/\.(js|cjs|mjs|d\.ts|d\.mts|d\.cts)\.map$/.test(p)) return true
  const m = /\/node-pty\/prebuilds\/([^/]+)\//.exec(p)
  if (m && m[1] !== `${targetPlatform}-${targetArch}`) return true
  // 非 Windows 目标：node-pty 的 ConPTY / winpty 产物只有 Windows 会加载
  if (targetPlatform !== 'win32' && /\/node-pty\/(build\/Release\/conpty|third_party\/conpty)\//.test(p)) return true
  return false
}

/**
 * 打包前剥掉内核前缀顶层 node_modules/@deepseek-ai/* 的 peer 链接（保留 dsh 本身）。
 * 这些链接是 ensureProfile 在运行时用 linkKernelPeers 建的；fs.cpSync/tar 会跟随 junction
 * 把内容复制成实体，让 kernel.tar 凭空翻倍。员工机器启动时会重新建，所以不进包。
 * 注意：stage 里的副本可能已被 cpSync 展开成真目录，所以不能只删 symlink。
 */
export function stripKernelPeerLinks(prefix) {
  const scope = path.join(prefix, 'node_modules', '@deepseek-ai')
  if (!fs.existsSync(scope)) return 0
  let removed = 0
  for (const entry of fs.readdirSync(scope)) {
    if (entry === 'dsh') continue
    fs.rmSync(path.join(scope, entry), { recursive: true, force: true })
    removed++
  }
  return removed
}

/**
 * 安装包 payload/scripts 必须带上的文件。
 * desk-host 用 `../../../scripts/...` 在加载时 import 它们。漏拷一个，插件整份加载失败，
 * 内核仍会把登录页开起来，但 /desk/api 没有注册，静态服务器对 GET 回空 404、对 POST 回空 405。
 */
export const CLIENT_PAYLOAD_SCRIPTS = [
  'scripts/kernel/patches.mjs',
  'scripts/kernel/locate.mjs',
  'scripts/kernel/pin.json',
  'scripts/lib/bootstrap.mjs',
  'scripts/lib/find-tar.mjs',
  'scripts/lib/lan-protocol.mjs',
  'scripts/lib/git-head.mjs',
  'scripts/lib/model-input.mjs',
  'scripts/lib/client-update.mjs',
  'scripts/lib/drive-mirror-index.mjs',
]

/** 把 cordis.patch.yml 里 desk-host 的 gatewayUrl 换成公司地址；url 为空则不改。 */
export function patchGatewayUrl(yamlText, url) {
  if (!url) return yamlText
  const clean = url.replace(/\/+$/, '')
  if (!/gatewayUrl:\s*'[^']*'/.test(yamlText)) throw new Error('cordis.patch.yml 里找不到 gatewayUrl')
  return yamlText.replace(/gatewayUrl:\s*'[^']*'/, `gatewayUrl: '${clean}'`)
}

/** 例：20260904-0102（UTC）。buildId 与 installerVersion 共用，避免两次 Date 对不齐。 */
export function buildStamp(now = new Date()) {
  const iso = now.toISOString()
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 16).replace(':', '')}`
}

/** 例：0.1.0+0.1.1-rc.2.20260904-0102.abcdef01 */
export function makeBuildId({ version, kernelVersion, digest, now = new Date() }) {
  return `${version}+${kernelVersion}.${buildStamp(now)}.${digest.slice(0, 8)}`
}

/** 安装包 / 界面用的版本号：营销版本 + 构建时间。例：0.1.0-20260907.0652 */
export function makeInstallerVersion({ version, now = new Date() }) {
  return `${version}-${buildStamp(now).replace('-', '.')}`
}

/** 若干文件内容的 sha1（按文件名排序后逐个喂进去，顺序无关）。 */
export function digestFiles(files) {
  const h = crypto.createHash('sha1')
  for (const f of [...files].sort((a, b) => path.basename(a).localeCompare(path.basename(b)))) {
    h.update(path.basename(f))
    h.update(fs.readFileSync(f))
  }
  return h.digest('hex')
}
