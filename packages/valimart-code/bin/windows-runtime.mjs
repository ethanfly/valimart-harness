/**
 * Windows 的 npm 平台包只是个小占位（没有 exe，npm 上传 176 MB 的包会卡住）。
 * 第一次运行时从 GitHub Release 下载同版本的 zip，解压到本机缓存，之后直接用。
 *
 * 缓存目录：%LOCALAPPDATA%\valimart-code\<版本>\bin\valimart.cmd
 * 下载先写临时目录，解压成功、确认入口存在才改名到正式位置，中途失败不留半成品。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const RELEASE_BASE = 'https://github.com/ethanfly/valimart-harness/releases/download/latest'

export function releaseAssetUrl(version) {
  return `${RELEASE_BASE}/valimart-code-${version}-windows-x64.zip`
}

export function defaultCacheRoot(env = process.env) {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(local, 'valimart-code')
}

function launcherIn(root) {
  return path.join(root, 'bin', 'valimart.cmd')
}

/**
 * Windows 自带的 bsdtar 才认 zip；Git for Windows 的 GNU tar 在 PATH 前面时会解压失败，所以写死系统自带的。
 */
export function extractZip(zipFile, dest) {
  const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  const cmd = fs.existsSync(systemTar) ? systemTar : 'tar'
  fs.mkdirSync(dest, { recursive: true })
  const r = spawnSync(cmd, ['-xf', zipFile, '-C', dest], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) {
    throw new Error(`解压 ${path.basename(zipFile)} 失败：${(r.stderr || r.error?.message || '').trim()}`)
  }
}

/**
 * 返回可以直接 spawn 的入口 bin\valimart.cmd 路径。
 * @param {object} opts
 * @param {string} opts.version     与入口包同版本
 * @param {string} opts.stubDir     npm 平台占位包的目录（里面可能是 0.2.1 那种整包，已带 exe）
 * @param {string} opts.cacheRoot   缓存根目录（默认 %LOCALAPPDATA%\valimart-code）
 */
export async function ensureWindowsRuntime({
  version,
  stubDir,
  cacheRoot,
  fetchImpl = fetch,
  extract = extractZip,
  log = () => {},
}) {
  const bundled = launcherIn(stubDir)
  if (fs.existsSync(bundled)) return bundled

  const dest = path.join(cacheRoot, version)
  const cached = launcherIn(dest)
  if (fs.existsSync(cached)) return cached

  fs.mkdirSync(cacheRoot, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(cacheRoot, `.download-${version}-`))
  try {
    const url = releaseAssetUrl(version)
    log(`首次运行：正在下载 valimart code ${version} 的 Windows 程序（约 76 MB，只下一次）…`)
    const res = await fetchImpl(url)
    if (!res.ok) {
      throw new Error(`下载 ${url} 失败：HTTP ${res.status}。请确认能访问 github.com，或稍后重试。`)
    }
    const zip = path.join(tmp, 'valimart-code.zip')
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
    const unpacked = path.join(tmp, 'unpacked')
    extract(zip, unpacked)
    if (!fs.existsSync(launcherIn(unpacked))) {
      throw new Error(`${url} 解压后没有 bin\\valimart.cmd，版本包可能损坏。`)
    }
    try {
      fs.renameSync(unpacked, dest)
    } catch (err) {
      // 并发启动时另一个进程可能已经放好了；以它为准。
      if (!fs.existsSync(cached)) throw err
    }
    return cached
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
