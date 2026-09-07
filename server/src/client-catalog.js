/**
 * 网关客户端目录：dataDir/clients/<buildId>/client.exe + manifest.json + current.json。
 */
import fs from 'node:fs'
import path from 'node:path'
import { hashFile } from '../../scripts/lib/kernel-update.mjs'
import { assertSafeBuildId } from '../../scripts/lib/client-update.mjs'

function catalogError(message, code) {
  const err = new Error(message)
  err.code = code
  return err
}

export function openClientCatalog(dataDir) {
  const root = path.join(dataDir, 'clients')
  const currentFile = path.join(root, 'current.json')

  const versionDir = (buildId) => path.join(root, buildId)
  const exeOf = (buildId) => path.join(versionDir(buildId), 'client.exe')
  const manifestOf = (buildId) => path.join(versionDir(buildId), 'manifest.json')

  const ensureRoot = () => fs.mkdirSync(root, { recursive: true })

  const readManifest = (buildId) => {
    const f = manifestOf(buildId)
    if (!fs.existsSync(f)) return null
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'))
    } catch {
      return null
    }
  }

  const readCurrent = () => {
    if (!fs.existsSync(currentFile)) return null
    try {
      return JSON.parse(fs.readFileSync(currentFile, 'utf8'))
    } catch {
      return null
    }
  }

  const writeCurrent = (obj) => {
    ensureRoot()
    fs.writeFileSync(currentFile, JSON.stringify(obj, null, 2) + '\n')
    return obj
  }

  const employeeView = () => {
    const cur = readCurrent()
    if (!cur?.buildId) return { available: false }
    const exe = exeOf(cur.buildId)
    return {
      available: fs.existsSync(exe),
      buildId: cur.buildId,
      version: cur.version ?? '',
      sha256: cur.sha256,
      bytes: cur.bytes ?? (fs.existsSync(exe) ? fs.statSync(exe).size : 0),
      filename: cur.filename ?? 'valimart-harness-Setup.exe',
    }
  }

  const listStored = () => {
    if (!fs.existsSync(root)) return []
    const out = []
    for (const name of fs.readdirSync(root)) {
      if (name === 'current.json' || name.startsWith('.')) continue
      const dir = versionDir(name)
      if (!fs.statSync(dir).isDirectory()) continue
      const exe = exeOf(name)
      const manifest = readManifest(name)
      if (!manifest || !fs.existsSync(exe)) continue
      out.push({
        buildId: manifest.buildId ?? name,
        version: manifest.version ?? '',
        sha256: manifest.sha256,
        bytes: manifest.bytes ?? fs.statSync(exe).size,
        filename: manifest.filename ?? 'valimart-harness-Setup.exe',
        builtAt: manifest.builtAt,
      })
    }
    return out.sort((a, b) => String(b.builtAt ?? b.buildId).localeCompare(String(a.builtAt ?? a.buildId)))
  }

  const saveArtifact = ({ buildId, exePath, manifest }) => {
    const id = assertSafeBuildId(buildId)
    ensureRoot()
    const destDir = versionDir(id)
    const destExe = exeOf(id)
    fs.mkdirSync(destDir, { recursive: true })
    if (!exePath || !fs.existsSync(exePath)) throw catalogError('缺少客户端安装包', 'not_found')
    const sha = hashFile(exePath)
    if (manifest?.sha256 && manifest.sha256 !== sha) throw catalogError('sha256 与文件不符', 'sha256_mismatch')
    if (path.resolve(exePath) !== path.resolve(destExe)) fs.copyFileSync(exePath, destExe)
    const man = {
      buildId: id,
      version: manifest?.version ?? '',
      sha256: sha,
      bytes: manifest?.bytes ?? fs.statSync(destExe).size,
      filename: manifest?.filename ?? path.basename(exePath),
      builtAt: manifest?.builtAt ?? new Date().toISOString(),
    }
    fs.writeFileSync(manifestOf(id), JSON.stringify(man, null, 2) + '\n')
    return man
  }

  const publish = (buildId) => {
    const id = assertSafeBuildId(buildId)
    const exe = exeOf(id)
    const manifest = readManifest(id)
    if (!manifest || !fs.existsSync(exe)) throw catalogError('该版本尚未入库', 'not_found')
    const sha = hashFile(exe)
    if (sha !== manifest.sha256) throw catalogError('sha256 与文件不符', 'sha256_mismatch')
    const old = readCurrent()
    return writeCurrent({
      buildId: manifest.buildId ?? id,
      version: manifest.version ?? '',
      sha256: manifest.sha256,
      bytes: manifest.bytes,
      filename: manifest.filename,
      publishedAt: new Date().toISOString(),
      previous: old ? { buildId: old.buildId, sha256: old.sha256 } : null,
    })
  }

  const rollback = () => {
    const cur = readCurrent()
    if (!cur?.previous?.buildId) throw catalogError('没有可回滚的上一版本', 'no_previous')
    const prevId = assertSafeBuildId(cur.previous.buildId)
    const exe = exeOf(prevId)
    const manifest = readManifest(prevId)
    if (!manifest || !fs.existsSync(exe)) throw catalogError('上一版本目录已不存在', 'previous_missing')
    const sha = hashFile(exe)
    if (sha !== manifest.sha256) throw catalogError('sha256 与文件不符', 'sha256_mismatch')
    return writeCurrent({
      buildId: manifest.buildId ?? prevId,
      version: manifest.version ?? '',
      sha256: manifest.sha256,
      bytes: manifest.bytes,
      filename: manifest.filename,
      publishedAt: new Date().toISOString(),
      previous: { buildId: cur.buildId, sha256: cur.sha256 },
    })
  }

  const remove = (buildId) => {
    const id = assertSafeBuildId(buildId)
    const destDir = versionDir(id)
    if (!fs.existsSync(destDir) || !readManifest(id)) throw catalogError('该版本尚未入库', 'not_found')
    const cur = readCurrent()
    fs.rmSync(destDir, { recursive: true, force: true })
    if (cur?.buildId === id) {
      const prevId = cur.previous?.buildId
      if (prevId && prevId !== id && fs.existsSync(exeOf(prevId)) && readManifest(prevId)) {
        const manifest = readManifest(prevId)
        writeCurrent({
          buildId: manifest.buildId ?? prevId,
          version: manifest.version ?? '',
          sha256: manifest.sha256,
          bytes: manifest.bytes,
          filename: manifest.filename,
          publishedAt: new Date().toISOString(),
          previous: null,
        })
      } else if (fs.existsSync(currentFile)) {
        fs.rmSync(currentFile, { force: true })
      }
    } else if (cur?.previous?.buildId === id) {
      writeCurrent({ ...cur, previous: null })
    }
    return { removed: id, current: readCurrent(), stored: listStored() }
  }

  const downloadPath = () => {
    const cur = readCurrent()
    if (!cur?.buildId) return null
    const p = exeOf(cur.buildId)
    return fs.existsSync(p) ? path.resolve(p) : null
  }

  const adminView = () => ({ current: readCurrent(), stored: listStored() })

  return { readCurrent, employeeView, listStored, saveArtifact, publish, rollback, remove, downloadPath, adminView }
}
