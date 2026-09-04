/**
 * 备份网关数据目录：gateway.sqlite（serialize 一致快照）+ drive/ + 遗留 JSON/JSONL。
 *   node scripts/backup-gateway.mjs
 *   node scripts/backup-gateway.mjs --data-dir <dir> --out <zip或目录>
 *
 * 默认 data-dir：DESK_GATEWAY_DATA → %ProgramData%\valimart harness Gateway\data（旧版 THE DIVA Gateway 仍识别）→ server/data
 * 默认 out：<data-dir 的上一级>/backups/gateway-YYYYMMDD-HHMMSS.zip
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

function sqlitePath(dataDir) {
  return path.join(dataDir, 'gateway.sqlite')
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function defaultDataDir() {
  if (process.env.DESK_GATEWAY_DATA) return path.resolve(process.env.DESK_GATEWAY_DATA)
  if (process.platform === 'win32' && process.env.ProgramData) {
    const next = path.join(process.env.ProgramData, 'valimart harness Gateway', 'data')
    const legacy = path.join(process.env.ProgramData, 'THE DIVA Gateway', 'data')
    if (fs.existsSync(next)) return next
    if (fs.existsSync(legacy)) return legacy
    return next
  }
  return path.join(root, 'server', 'data')
}

export function stampName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `gateway-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

export function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  fs.cpSync(src, dest, { recursive: true })
}

/** @returns {{ dir: string, sqlite?: string, drive?: boolean, extras: string[] }} */
export function snapshotDataDir(dataDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  const extras = []
  const dbFile = sqlitePath(dataDir)
  let sqlite
  if (fs.existsSync(dbFile)) {
    const db = new DatabaseSync(dbFile, { readOnly: true })
    try {
      sqlite = path.join(destDir, 'gateway.sqlite')
      // node:sqlite 的 DatabaseSync 没有 serialize()；VACUUM INTO 是一致快照。
      const dest = sqlite.replaceAll('\\', '/').replaceAll("'", "''")
      db.exec(`VACUUM INTO '${dest}'`)
    } finally {
      db.close()
    }
  }
  const drive = path.join(dataDir, 'drive')
  let hasDrive = false
  if (fs.existsSync(drive)) {
    copyTree(drive, path.join(destDir, 'drive'))
    hasDrive = true
  }
  for (const name of fs.readdirSync(dataDir)) {
    if (name === 'drive' || name.startsWith('gateway.sqlite')) continue
    const src = path.join(dataDir, name)
    if (!fs.statSync(src).isFile()) continue
    if (!/\.(json|jsonl)$/i.test(name)) continue
    fs.copyFileSync(src, path.join(destDir, name))
    extras.push(name)
  }
  fs.writeFileSync(
    path.join(destDir, 'manifest.json'),
    JSON.stringify({ createdAt: new Date().toISOString(), source: path.resolve(dataDir), sqlite: !!sqlite, drive: hasDrive, extras }, null, 2) + '\n',
  )
  return { dir: destDir, sqlite, drive: hasDrive, extras }
}

export function zipDir(dir, zipFile) {
  fs.mkdirSync(path.dirname(zipFile), { recursive: true })
  if (fs.existsSync(zipFile)) fs.rmSync(zipFile)
  if (process.platform === 'win32') {
    const r = spawnSync('tar', ['-a', '-cf', zipFile, '-C', dir, '.'], { encoding: 'utf8' })
    if (r.status !== 0) {
      const ps = spawnSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path (Join-Path '${dir.replace(/'/g, "''")}' '*') -DestinationPath '${zipFile.replace(/'/g, "''")}'`], { encoding: 'utf8' })
      if (ps.status !== 0) throw new Error(ps.stderr || r.stderr || '压缩失败')
    }
  } else {
    const r = spawnSync('tar', ['-czf', zipFile, '-C', dir, '.'], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr || 'tar 失败')
  }
  return zipFile
}

function argOf(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

export function backupGateway({ dataDir = defaultDataDir(), out, keepDir = false } = {}) {
  if (!fs.existsSync(dataDir)) throw new Error(`数据目录不存在：${dataDir}`)
  const name = stampName()
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-backup-'))
  const snapDir = path.join(staging, name)
  const snap = snapshotDataDir(dataDir, snapDir)
  let artifact
  if (out && !/\.(zip|tgz|tar\.gz)$/i.test(out) && (keepDir || (fs.existsSync(out) && fs.statSync(out).isDirectory()) || !path.extname(out))) {
    const dest = path.extname(out) ? out : path.join(out, name)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true })
    fs.cpSync(snapDir, dest, { recursive: true })
    artifact = dest
  } else {
    const zip = out || path.join(path.dirname(dataDir), 'backups', `${name}.zip`)
    zipDir(snapDir, zip)
    artifact = zip
  }
  fs.rmSync(staging, { recursive: true, force: true })
  return { ...snap, artifact }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    const r = backupGateway({ dataDir: argOf('--data-dir'), out: argOf('--out') })
    console.log(`[backup] ${r.artifact}`)
  } catch (err) {
    console.error(`[backup] ${err.message}`)
    process.exit(1)
  }
}
