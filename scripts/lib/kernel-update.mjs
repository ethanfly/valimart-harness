import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SOURCE_REPO = 'https://github.com/deepseek-ai/deepseek-harness'
export const SOURCE_API = 'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=20'
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmmirror.com'

export function resolveNpmRegistry(explicit) {
  const fromArg = typeof explicit === 'string' ? explicit.trim().replace(/\/+$/, '') : ''
  if (fromArg) return fromArg
  const fromEnv = typeof process.env.npm_config_registry === 'string' ? process.env.npm_config_registry.trim().replace(/\/+$/, '') : ''
  if (fromEnv) return fromEnv
  return DEFAULT_NPM_REGISTRY
}

export function npmPackumentUrl(registry) {
  return `${resolveNpmRegistry(registry)}/@deepseek-ai%2Fdsh`
}

export async function fetchNpmVersions({ registry, fetchImpl } = {}) {
  const fetchFn = fetchImpl ?? globalThis.fetch
  const r = await fetchFn(npmPackumentUrl(registry), {
    headers: { Accept: 'application/json', 'User-Agent': 'the-diva-gateway' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) throw new Error('npm registry HTTP ' + r.status)
  const j = await r.json()
  return Object.keys(j.versions ?? {})
}

export function annotateDiscoverWithNpm(discover, npmVersions, { queryFailed = false } = {}) {
  return (discover ?? []).map((d) => {
    if (queryFailed || npmVersions == null) return { ...d, onNpm: null }
    return { ...d, onNpm: npmVersions.includes(d.version) }
  })
}

export function parseReleaseTag(tag) {
  const m = /^dsh-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(String(tag ?? ''))
  return m ? { version: m[1] } : null
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v ?? ''))
  if (!m) return null
  const pre = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre }
}

function cmpPre(a, b) {
  // 无预发布 > 有预发布；alpha < rc < 数字标识；逐段比较
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  const rank = (p) => (p === 'alpha' ? 1 : p === 'rc' ? 2 : typeof p === 'number' ? 10 : 0)
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    const rx = rank(x), ry = rank(y)
    if (rx !== ry) return rx - ry
    return String(x).localeCompare(String(y))
  }
  return 0
}

export function newerThan(a, b) {
  const A = parseSemver(a), B = parseSemver(b)
  if (!A || !B) return false
  if (A.major !== B.major) return A.major > B.major
  if (A.minor !== B.minor) return A.minor > B.minor
  if (A.patch !== B.patch) return A.patch > B.patch
  return cmpPre(A.pre, B.pre) > 0
}

export function filterDiscoverable(releases, currentVersion) {
  const out = []
  for (const r of releases ?? []) {
    if (r?.draft) continue
    const parsed = parseReleaseTag(r.tag_name)
    if (!parsed) continue
    if (currentVersion && !newerThan(parsed.version, currentVersion)) continue
    out.push({ tag: r.tag_name, version: parsed.version, name: r.name ?? r.tag_name, prerelease: !!r.prerelease })
  }
  return out.sort((x, y) => (newerThan(x.version, y.version) ? -1 : newerThan(y.version, x.version) ? 1 : 0))
}

export function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export function defaultPendingDir() {
  return path.join(os.homedir(), '.company-desk', 'app', 'kernel-next')
}

export function pendingPaths(dir) {
  return {
    dir,
    tar: path.join(dir, 'kernel.tar'),
    partial: path.join(dir, 'kernel.tar.partial'),
    json: path.join(dir, 'pending.json'),
  }
}

export function readPending(dir) {
  const f = pendingPaths(dir).json
  if (!fs.existsSync(f)) return null
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (!j.version || !j.sha256) return null
    return j
  } catch {
    return null
  }
}

export function writePending(dir, { version, sha256 }) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(pendingPaths(dir).json, JSON.stringify({ version, sha256, downloadedAt: new Date().toISOString() }, null, 2) + '\n')
}

export function clearPending(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}
