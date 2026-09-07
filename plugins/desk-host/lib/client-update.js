/**
 * 登录后从公司网关后台拉客户端 Setup.exe 到 client-next，下次启动再静默安装。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DOWNLOAD_TIMEOUT_MS = 600_000

export function resolveAppDir() {
  return process.env.DESK_APP_DIR ?? path.join(os.homedir(), '.company-desk', 'app')
}

export function resolveClientPendingDir() {
  return path.join(resolveAppDir(), 'client-next')
}

export function resolvePayloadDir() {
  return process.env.DESK_PAYLOAD_DIR || ''
}

async function loadHelpers() {
  if (process.env.NODE_TEST_CONTEXT) {
    return import(new URL('../../../scripts/lib/client-update.mjs', import.meta.url).href)
  }
  const packaged = path.join(resolveAppDir(), 'scripts', 'lib', 'client-update.mjs')
  if (fs.existsSync(packaged)) return import(pathToFileURL(packaged).href)
  return import(new URL('../../../scripts/lib/client-update.mjs', import.meta.url).href)
}

async function loadHash() {
  const packaged = path.join(resolveAppDir(), 'scripts', 'lib', 'kernel-update.mjs')
  if (fs.existsSync(packaged)) return import(pathToFileURL(packaged).href)
  return import(new URL('../../../scripts/lib/kernel-update.mjs', import.meta.url).href)
}

/**
 * @param {{ gateway: { get: Function, request: Function }, pendingDir: string, localBuildId?: string, localInstallerVersion?: string, payloadDir?: string, log?: (msg: string) => void }} opts
 */
export async function fetchClientUpdate({
  gateway,
  pendingDir,
  localBuildId,
  localInstallerVersion,
  payloadDir,
  log = () => {},
} = {}) {
  try {
    const helpers = await loadHelpers()
    const { hashFile } = await loadHash()
    const current = await gateway.get('/api/client/current')
    let pending = helpers.readClientPending(pendingDir)
    const paths = helpers.clientPendingPaths(pendingDir)
    const local = typeof helpers.readLocalPayload === 'function' ? helpers.readLocalPayload(payloadDir || resolvePayloadDir()) : null
    const buildId = localBuildId || local?.buildId
    const installerVersion = localInstallerVersion || local?.installerVersion

    if (pending && (pending.sha256 !== current?.sha256 || pending.buildId !== current?.buildId)) {
      helpers.clearClientPending(pendingDir)
      pending = null
    }
    if (pending && !fs.existsSync(paths.exe)) {
      helpers.clearClientPending(pendingDir)
      pending = null
      log('pending exe 缺失，清除记录后重新下载')
    }

    const decision = helpers.shouldFetchClientUpdate(current, buildId, pending, { installerVersion })
    if (!decision.fetch) {
      if (decision.reason === 'same-build' && pending) helpers.clearClientPending(pendingDir)
      if (decision.reason === 'already-pending') return { action: 'skip', detail: 'already-pending' }
      return { action: 'skip', detail: decision.reason }
    }

    const buf = await gateway.request('GET', '/api/client/download', { timeoutMs: DOWNLOAD_TIMEOUT_MS })
    if (!Buffer.isBuffer(buf) || !buf.length) {
      helpers.clearClientPending(pendingDir)
      log('client installer empty')
      return { action: 'error', detail: 'empty-installer' }
    }

    fs.mkdirSync(pendingDir, { recursive: true })
    fs.writeFileSync(paths.partial, buf)
    const sha = hashFile(paths.partial)
    if (sha !== current.sha256) {
      helpers.clearClientPending(pendingDir)
      log(`client sha256 mismatch (${sha} ≠ ${current.sha256})`)
      return { action: 'error', detail: 'hash-mismatch' }
    }
    fs.renameSync(paths.partial, paths.exe)
    helpers.writeClientPending(pendingDir, {
      buildId: current.buildId,
      sha256: current.sha256,
      version: current.version,
      filename: current.filename,
    })
    log(`downloaded ${current.buildId}`)
    return { action: 'downloaded', detail: current.buildId }
  } catch (err) {
    log(err.message ?? String(err))
    return { action: 'error', detail: err.message ?? String(err) }
  }
}
