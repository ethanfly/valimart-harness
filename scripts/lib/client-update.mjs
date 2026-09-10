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

export function readLocalPayload(payloadDir) {
  if (!payloadDir) return null
  try {
    const j = JSON.parse(fs.readFileSync(path.join(payloadDir, 'payload.json'), 'utf8'))
    if (!j || typeof j !== 'object') return null
    const buildId = typeof j.buildId === 'string' && j.buildId ? j.buildId : null
    if (!buildId) return null
    return {
      version: typeof j.version === 'string' && j.version ? j.version : null,
      buildId,
      builtAt: typeof j.builtAt === 'string' ? j.builtAt : null,
      kernelVersion: typeof j.kernel?.version === 'string' ? j.kernel.version : null,
      installerVersion: typeof j.installerVersion === 'string' && j.installerVersion ? j.installerVersion : null,
    }
  } catch {
    return null
  }
}

export function readLocalBuildId(payloadDir) {
  return readLocalPayload(payloadDir)?.buildId ?? null
}

export function clientPublicInfo(payloadDir, fallbackVersion = '0.1.0') {
  return (
    readLocalPayload(payloadDir) ?? {
      version: fallbackVersion,
      buildId: 'dev',
      builtAt: null,
      kernelVersion: null,
      installerVersion: null,
    }
  )
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

/** 打进安装包版权串，上传时从 PE 明文扫出来。 */
export const CLIENT_BUILD_MARK = 'VMBUILD '

const BUILD_ID_RE = /\d+\.\d+\.\d+\+[A-Za-z0-9._+-]+/
const INSTALLER_VER_RE = /\d+\.\d+\.\d+-\d{8}\.\d{4}/

export function extractClientMetaFromInstaller(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null
  const head = buf.subarray(0, Math.min(buf.length, 8 * 1024 * 1024))
  const text = `${head.toString('utf16le')}\n${head.toString('latin1')}`
  const marked = text.match(/VMBUILD ([^\s\0]+)/)
  const buildId = marked?.[1] || text.match(BUILD_ID_RE)?.[0] || null
  const installerVersion = text.match(INSTALLER_VER_RE)?.[0] || null
  if (!buildId && !installerVersion) return null
  return { buildId, installerVersion }
}

export function resolvePublishedBuildId({ headerBuildId, extracted } = {}) {
  const extractedId = typeof extracted?.buildId === 'string' ? extracted.buildId.trim() : ''
  if (extractedId) return extractedId
  const header = String(headerBuildId ?? '').trim()
  if (header) return header
  const ver = typeof extracted?.installerVersion === 'string' ? extracted.installerVersion.trim() : ''
  return ver
}

export function sameInstalledClient(remote, local = {}) {
  if (!remote) return false
  if (local.buildId && remote.buildId === local.buildId) return true
  const ver = local.installerVersion
  return Boolean(ver && typeof remote.filename === 'string' && remote.filename.includes(ver))
}

/** Compare release version then UTC build minute; kernel version and digest
 * identify a build but do not determine which desktop release is newer. */
export function isOlderClient(remote, local = {}) {
  const key = (info) => {
    const build = /^(\d+)\.(\d+)\.(\d+)\+.*\.(\d{8})-(\d{4})\.[a-f\d]+$/i.exec(info.buildId ?? '')
    const installer = /(?:^|Setup-)(\d+)\.(\d+)\.(\d+)-(\d{8})\.(\d{4})(?:\.exe)?$/i.exec(info.installerVersion || info.filename || '')
    return (build || installer)?.slice(1).map(Number)
  }
  const a = key(remote ?? {})
  const b = key(local)
  if (!a || !b) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i]
  }
  return false
}

export function shouldFetchClientUpdate(current, localBuildId, pending, local = {}) {
  if (!current?.available || !current.buildId || !current.sha256) return { fetch: false, reason: 'unavailable' }
  if (sameInstalledClient(current, { buildId: localBuildId, installerVersion: local.installerVersion })) {
    return { fetch: false, reason: 'same-build' }
  }
  if (isOlderClient(current, { buildId: localBuildId, installerVersion: local.installerVersion })) return { fetch: false, reason: 'older-build' }
  if (pending?.sha256 === current.sha256 && pending.buildId === current.buildId) return { fetch: false, reason: 'already-pending' }
  return { fetch: true, reason: 'newer' }
}

export function silentInstallArgs() {
  // --updated：让 NSIS 等旧进程退出再换文件。不传 --force-run，避免走
  // electron-builder 的 StartApp（打开开始菜单快捷方式；沙箱 /D= 装过会把
  // .lnk 指到旧目录，更新完看起来像没启动）。
  return ['/S', '--updated']
}

export function shouldApplyClientUpdate(pending, { packaged, exeExists, sha, localBuildId, localInstallerVersion } = {}) {
  if (!packaged) return { apply: false, reason: 'dev' }
  if (!pending?.buildId || !pending.sha256) return { apply: false, reason: 'no-pending' }
  if (sameInstalledClient(pending, { buildId: localBuildId, installerVersion: localInstallerVersion })) {
    return { apply: false, reason: 'already-current' }
  }
  if (isOlderClient(pending, { buildId: localBuildId, installerVersion: localInstallerVersion })) return { apply: false, reason: 'older-build' }
  if (!exeExists) return { apply: false, reason: 'no-exe' }
  if (sha && sha !== pending.sha256) return { apply: false, reason: 'hash-mismatch' }
  return { apply: true, args: silentInstallArgs() }
}

export function defaultClientPendingDir(appDir) {
  return path.join(appDir, 'client-next')
}

/**
 * 安装版启动时：hash 核对通过则拉起 Setup.exe /S --updated，由调用方随后退出进程。
 * 安装器完成文件替换后启动新版，不能让旧进程提前 app.relaunch()。
 * spawn / hashFile 注入，方便单测且桌面主进程不必再复制判定。
 */
export function applyPendingClientUpdate({ pendingDir, payloadDir, packaged, hashFile, spawn, afterSpawn } = {}) {
  if (typeof hashFile !== 'function') throw new Error('applyPendingClientUpdate 需要 hashFile')
  if (typeof spawn !== 'function') throw new Error('applyPendingClientUpdate 需要 spawn')
  const pending = readClientPending(pendingDir)
  const paths = clientPendingPaths(pendingDir)
  const exeExists = Boolean(pendingDir) && fs.existsSync(paths.exe)
  const sha = exeExists ? hashFile(paths.exe) : ''
  const local = readLocalPayload(payloadDir)
  const decision = shouldApplyClientUpdate(pending, {
    packaged,
    exeExists,
    sha,
    localBuildId: local?.buildId,
    localInstallerVersion: local?.installerVersion,
  })
  if (!decision.apply) {
    if (pendingDir && ['already-current', 'hash-mismatch', 'older-build'].includes(decision.reason)) {
      clearClientPending(pendingDir)
    }
    return { applied: false, reason: decision.reason }
  }
  const child = spawn(paths.exe, decision.args, { detached: true, stdio: 'ignore', windowsHide: true })
  if (child && typeof child.unref === 'function') child.unref()
  afterSpawn?.({ buildId: pending.buildId, args: decision.args, exe: paths.exe })
  return { applied: true, buildId: pending.buildId, args: decision.args }
}
