/**
 * 登录后从公司网关后台拉内核 tar 到 kernel-next。
 * pending 读写复用 appDir/scripts/lib/kernel-update.mjs（安装版 DESK_APP_DIR；开发仓库 fallback 相对路径）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TARBALL_TIMEOUT_MS = 600_000

export function resolveAppDir() {
  return process.env.DESK_APP_DIR ?? path.join(os.homedir(), '.company-desk', 'app')
}

export function resolvePendingDir() {
  return path.join(resolveAppDir(), 'kernel-next')
}

/** 优先读当前 dsh 启动入口所属包，避免开发版显示/比较安装版的内核版本。 */
export function readLocalKernelVersion(appDir = resolveAppDir(), { entryFile = process.argv[1] } = {}) {
  if (entryFile) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.resolve(path.dirname(entryFile), '..', 'package.json'), 'utf8'))
      if (manifest.name === '@deepseek-ai/dsh' && manifest.version) return manifest.version
    } catch {
      /* 非 dsh 入口（测试、管理脚本）仍按安装目录查找。 */
    }
  }
  const pkgs = [
    path.join(appDir, 'kernel', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    path.join(appDir, 'kernel', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    path.join(os.homedir(), '.company-desk', 'kernel', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    path.join(os.homedir(), '.company-desk', 'kernel', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ]
  for (const pkg of pkgs) {
    try {
      const v = JSON.parse(fs.readFileSync(pkg, 'utf8')).version
      if (v) return v
    } catch {
      /* 下一候选 */
    }
  }
  return null
}

function skipReason(current, localVersion) {
  if (current?.bundled) return 'bundled'
  if (!current?.sha256) return 'no-sha256'
  if (current.version === localVersion) return 'same-version'
  return null
}

async function loadPendingHelpers() {
  const packaged = path.join(resolveAppDir(), 'scripts', 'lib', 'kernel-update.mjs')
  if (fs.existsSync(packaged)) return import(pathToFileURL(packaged).href)
  return import(new URL('../../../scripts/lib/kernel-update.mjs', import.meta.url).href)
}

/**
 * @param {{ gateway: { get: Function, request: Function }, pendingDir: string, localVersion?: string, log?: (msg: string) => void }} opts
 * @returns {Promise<{ action: 'skip'|'downloaded'|'cleared'|'error', detail: string }>}
 */
export async function fetchKernelUpdate({ gateway, pendingDir, localVersion, log = () => {} }) {
  try {
    const helpers = await loadPendingHelpers()
    const current = await gateway.get('/api/kernel/current')
    const pending = helpers.readPending(pendingDir)

    if (pending && pending.sha256 !== current.sha256) {
      helpers.clearPending(pendingDir)
      if (skipReason(current, localVersion)) {
        log(`cleared stale pending (sha ≠ current ${current.version ?? 'bundled'})`)
        return { action: 'cleared', detail: 'sha-mismatch' }
      }
    } else if (pending && pending.sha256 === current.sha256) {
      // 记录在但 tar 丢了（清盘/杀软/中断残留）：不能一直短路成 already-pending —— 那样升级永不生效
      if (!fs.existsSync(helpers.pendingPaths(pendingDir).tar)) {
        helpers.clearPending(pendingDir)
        log('pending tar 缺失，清除记录后重新下载')
      } else {
        return { action: 'skip', detail: 'already-pending' }
      }
    }

    const skip = skipReason(current, localVersion)
    if (skip) return { action: 'skip', detail: skip }

    const buf = await gateway.request('GET', '/api/kernel/tarball', { timeoutMs: TARBALL_TIMEOUT_MS })
    if (!Buffer.isBuffer(buf) || !buf.length) {
      helpers.clearPending(pendingDir)
      log('tarball empty')
      return { action: 'error', detail: 'empty-tarball' }
    }

    const paths = helpers.pendingPaths(pendingDir)
    fs.mkdirSync(pendingDir, { recursive: true })
    fs.writeFileSync(paths.partial, buf)
    const sha = helpers.hashFile(paths.partial)
    if (sha !== current.sha256) {
      helpers.clearPending(pendingDir)
      log(`tarball sha256 mismatch (${sha} ≠ ${current.sha256})`)
      return { action: 'error', detail: 'hash-mismatch' }
    }
    fs.renameSync(paths.partial, paths.tar)
    helpers.writePending(pendingDir, { version: current.version, sha256: current.sha256 })
    log(`downloaded ${current.version}`)
    return { action: 'downloaded', detail: current.version }
  } catch (err) {
    log(err.message ?? String(err))
    return { action: 'error', detail: err.message ?? String(err) }
  }
}
