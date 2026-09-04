/**
 * 网关内核目录：dataDir/kernels/ 下的 current.json、已存 tar、GitHub 发现。
 */
import fs from 'node:fs'
import path from 'node:path'
import { SOURCE_API, SOURCE_REPO, filterDiscoverable, hashFile, parseReleaseTag } from '../../scripts/lib/kernel-update.mjs'

function catalogError(message, code) {
  const err = new Error(message)
  err.code = code
  return err
}

function assertSafeVersion(version) {
  if (typeof version !== 'string' || !version || version.includes('/') || version.includes('\\') || version.includes('..') || version === 'current.json') {
    throw catalogError('非法版本号', 'bad_version')
  }
}

async function defaultFetchReleases() {
  const r = await fetch(SOURCE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'the-diva-gateway',
      ...(process.env.GITHUB_TOKEN ? { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) throw new Error('GitHub HTTP ' + r.status)
  return r.json()
}

export function openKernelCatalog(dataDir, { pinVersion, fetchReleases } = {}) {
  const root = path.join(dataDir, 'kernels')
  const currentFile = path.join(root, 'current.json')
  const fetchFn = fetchReleases ?? defaultFetchReleases

  const versionDir = (version) => path.join(root, version)
  const tarOf = (version) => path.join(versionDir(version), 'kernel.tar')
  const manifestOf = (version) => path.join(versionDir(version), 'manifest.json')

  const ensureRoot = () => fs.mkdirSync(root, { recursive: true })

  const readManifest = (version) => {
    const f = manifestOf(version)
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

  const defaultSourceTag = (version, given) => {
    if (given) return given
    const tag = 'dsh-v' + version
    return parseReleaseTag(tag) ? tag : null
  }

  const employeeView = () => {
    const cur = readCurrent()
    if (!cur) {
      return { version: pinVersion, sha256: null, sourceTag: null, bundled: true, tarball: false }
    }
    return {
      version: cur.version,
      sha256: cur.sha256,
      sourceTag: cur.sourceTag ?? null,
      bundled: false,
      tarball: fs.existsSync(tarOf(cur.version)),
    }
  }

  const listStored = () => {
    if (!fs.existsSync(root)) return []
    const out = []
    for (const name of fs.readdirSync(root)) {
      if (name === 'current.json' || name.startsWith('.')) continue
      const dir = versionDir(name)
      if (!fs.statSync(dir).isDirectory()) continue
      const tar = tarOf(name)
      const manifest = readManifest(name)
      if (!manifest || !fs.existsSync(tar)) continue
      const bytes = manifest.bytes ?? fs.statSync(tar).size
      out.push({ version: manifest.version ?? name, sha256: manifest.sha256, bytes })
    }
    return out.sort((a, b) => String(b.version).localeCompare(String(a.version)))
  }

  const saveArtifact = ({ version, tarPath, manifest }) => {
    assertSafeVersion(version)
    ensureRoot()
    const destDir = versionDir(version)
    const destTar = tarOf(version)
    fs.mkdirSync(destDir, { recursive: true })
    if (!tarPath || !fs.existsSync(tarPath)) throw catalogError('缺少 kernel.tar', 'not_found')
    const sha = hashFile(tarPath)
    if (manifest?.sha256 && manifest.sha256 !== sha) throw catalogError('sha256 与文件不符', 'sha256_mismatch')
    if (path.resolve(tarPath) !== path.resolve(destTar)) fs.copyFileSync(tarPath, destTar)
    const man = {
      package: manifest?.package ?? '@deepseek-ai/dsh',
      version: manifest?.version ?? version,
      sha256: sha,
      bytes: manifest?.bytes ?? fs.statSync(destTar).size,
      sourceTag: defaultSourceTag(version, manifest?.sourceTag),
      sourceRepo: manifest?.sourceRepo ?? SOURCE_REPO,
      patched: manifest?.patched ?? '',
      builtAt: manifest?.builtAt ?? new Date().toISOString(),
    }
    fs.writeFileSync(manifestOf(version), JSON.stringify(man, null, 2) + '\n')
    return man
  }

  const publish = (version) => {
    assertSafeVersion(version)
    const tar = tarOf(version)
    const manifest = readManifest(version)
    if (!manifest || !fs.existsSync(tar)) throw catalogError('该版本尚未入库', 'not_found')
    const sha = hashFile(tar)
    if (sha !== manifest.sha256) throw catalogError('sha256 与文件不符', 'sha256_mismatch')
    const old = readCurrent()
    return writeCurrent({
      version: manifest.version ?? version,
      sha256: manifest.sha256,
      sourceTag: manifest.sourceTag ?? defaultSourceTag(version),
      sourceRepo: manifest.sourceRepo ?? SOURCE_REPO,
      publishedAt: new Date().toISOString(),
      previous: old ? { version: old.version, sha256: old.sha256 } : null,
    })
  }

  const rollback = () => {
    const cur = readCurrent()
    if (!cur?.previous) throw catalogError('没有可回滚的上一版本', 'no_previous')
    const prevVer = cur.previous.version
    assertSafeVersion(prevVer)
    const tar = tarOf(prevVer)
    const manifest = readManifest(prevVer)
    if (!manifest || !fs.existsSync(tar)) throw catalogError('上一版本目录已不存在', 'previous_missing')
    const sha = hashFile(tar)
    if (sha !== manifest.sha256) throw catalogError('sha256 与文件不符', 'sha256_mismatch')
    return writeCurrent({
      version: manifest.version ?? prevVer,
      sha256: manifest.sha256,
      sourceTag: manifest.sourceTag ?? defaultSourceTag(prevVer),
      sourceRepo: manifest.sourceRepo ?? SOURCE_REPO,
      publishedAt: new Date().toISOString(),
      previous: { version: cur.version, sha256: cur.sha256 },
    })
  }

  const tarballPath = () => {
    const cur = readCurrent()
    if (!cur) return null
    const p = tarOf(cur.version)
    return fs.existsSync(p) ? path.resolve(p) : null
  }

  const adminView = async () => {
    const current = readCurrent()
    let discover = []
    let discoverError = null
    try {
      const releases = await fetchFn()
      discover = filterDiscoverable(releases, current?.version ?? pinVersion)
    } catch (err) {
      discoverError = err.message ?? String(err)
    }
    return { current, stored: listStored(), discover, discoverError, pinVersion }
  }

  return { readCurrent, employeeView, listStored, saveArtifact, publish, rollback, tarballPath, adminView }
}
