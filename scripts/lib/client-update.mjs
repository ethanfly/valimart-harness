/**
 * 客户端整包更新共用：buildId 校验、本机 payload、pending、是否拉取/应用。
 */
import fs from 'node:fs'
import path from 'node:path'

export function assertSafeBuildId(buildId) {
  const id = String(buildId ?? '').trim()
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..') || id === 'current.json' || id.startsWith('.')) {
    const err = new Error('非法客户端版本号')
    err.code = 'bad_version'
    throw err
  }
  return id
}

export function readLocalBuildId(payloadDir) {
  if (!payloadDir) return null
  try {
    const j = JSON.parse(fs.readFileSync(path.join(payloadDir, 'payload.json'), 'utf8'))
    return typeof j.buildId === 'string' && j.buildId ? j.buildId : null
  } catch {
    return null
  }
}

export function clientPendingPaths(dir) {
  return {
    dir,
    exe: path.join(dir, 'client.exe'),
    partial: path.join(dir, 'client.exe.partial'),
    json: path.join(dir, 'pending.json'),
  }
}

export function readClientPending(dir) {
  const f = clientPendingPaths(dir).json
  if (!fs.existsSync(f)) return null
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (!j.buildId || !j.sha256) return null
    return j
  } catch {
    return null
  }
}

export function writeClientPending(dir, { buildId, sha256, version, filename }) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    clientPendingPaths(dir).json,
    JSON.stringify({ buildId, sha256, version: version ?? '', filename: filename ?? '', downloadedAt: new Date().toISOString() }, null, 2) + '\n',
  )
}

export function clearClientPending(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

export function shouldFetchClientUpdate(current, localBuildId, pending) {
  if (!current?.available || !current.buildId || !current.sha256) return { fetch: false, reason: 'unavailable' }
  if (localBuildId && current.buildId === localBuildId) return { fetch: false, reason: 'same-build' }
  if (pending?.sha256 === current.sha256 && pending.buildId === current.buildId) return { fetch: false, reason: 'already-pending' }
  return { fetch: true, reason: 'newer' }
}

export function silentInstallArgs() {
  return ['/S']
}

export function shouldApplyClientUpdate(pending, { packaged, exeExists, sha, localBuildId } = {}) {
  if (!packaged) return { apply: false, reason: 'dev' }
  if (!pending?.buildId || !pending.sha256) return { apply: false, reason: 'no-pending' }
  if (localBuildId && localBuildId === pending.buildId) return { apply: false, reason: 'already-current' }
  if (!exeExists) return { apply: false, reason: 'no-exe' }
  if (sha && sha !== pending.sha256) return { apply: false, reason: 'hash-mismatch' }
  return { apply: true, args: silentInstallArgs() }
}

export function defaultClientPendingDir(appDir) {
  return path.join(appDir, 'client-next')
}

/**
 * 安装版启动时：hash 核对通过则拉起 Setup.exe /S，由调用方随后退出进程。
 * spawn / hashFile 注入，方便单测且桌面主进程不必再复制判定。
 */
export function applyPendingClientUpdate({ pendingDir, payloadDir, packaged, hashFile, spawn, afterSpawn } = {}) {
  if (typeof hashFile !== 'function') throw new Error('applyPendingClientUpdate 需要 hashFile')
  if (typeof spawn !== 'function') throw new Error('applyPendingClientUpdate 需要 spawn')
  const pending = readClientPending(pendingDir)
  const paths = clientPendingPaths(pendingDir)
  const exeExists = Boolean(pendingDir) && fs.existsSync(paths.exe)
  const sha = exeExists ? hashFile(paths.exe) : ''
  const localBuildId = readLocalBuildId(payloadDir)
  const decision = shouldApplyClientUpdate(pending, { packaged, exeExists, sha, localBuildId })
  if (!decision.apply) {
    if (pendingDir && (decision.reason === 'already-current' || decision.reason === 'hash-mismatch')) {
      clearClientPending(pendingDir)
    }
    return { applied: false, reason: decision.reason }
  }
  const child = spawn(paths.exe, decision.args, { detached: true, stdio: 'ignore', windowsHide: true })
  if (child && typeof child.unref === 'function') child.unref()
  afterSpawn?.({ buildId: pending.buildId, args: decision.args, exe: paths.exe })
  return { applied: true, buildId: pending.buildId, args: decision.args }
}
