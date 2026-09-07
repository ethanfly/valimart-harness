/**
 * build-payload.mjs 用到的纯函数（单测覆盖）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 内核修剪：只删运行期绝不加载的东西。relPath 相对内核前缀根。 */
export function shouldPrune(relPath) {
  const p = relPath.replace(/\\/g, '/')
  if (/\.d\.(ts|mts|cts)$/.test(p)) return true
  if (/\.(js|cjs|mjs|d\.ts|d\.mts|d\.cts)\.map$/.test(p)) return true
  const m = /\/node-pty\/prebuilds\/([^/]+)\//.exec(p)
  if (m && m[1] !== 'win32-x64') return true
  return false
}

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
