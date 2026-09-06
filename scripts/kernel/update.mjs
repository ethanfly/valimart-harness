/**
 * 内核更新 CLI：发现 GitHub Release、试打补丁打 tar、发布到网关。
 *
 *   node scripts/kernel/update.mjs discover [--current 0.1.1-rc.2]
 *   node scripts/kernel/update.mjs prepare --version 0.1.2-rc.1 [--out build/kernel-update] [--prefix <tmp>]
 *   node scripts/kernel/update.mjs publish --gateway http://127.0.0.1:8790 --user boss --password … --from build/kernel-update/0.1.2-rc.1
 *
 * 退出码：用法 64；业务失败 1；成功 0。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SOURCE_API, filterDiscoverable } from '../lib/kernel-update.mjs'
import { prepareKernelTarball } from '../lib/kernel-prepare.mjs'
import { PIN, defaultDshHome } from './locate.mjs'

const args = process.argv.slice(2)
const has = (k) => args.includes(k)
const argOf = (k) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] && !String(args[i + 1]).startsWith('-') ? args[i + 1] : undefined
}

function usage(msg) {
  if (msg) console.error(msg)
  console.error(`用法：
  node scripts/kernel/update.mjs discover [--current <ver>] [--gateway <url>] [--user <admin>] [--password <…>]
  node scripts/kernel/update.mjs prepare --version <ver> [--out build/kernel-update] [--prefix <dir>] [--skills-dir <dir>]
  node scripts/kernel/update.mjs publish --gateway <url> --user <admin> --password <…> --from <dir>`)
  process.exit(64)
}

function die(msg, code = 1) {
  console.error(msg)
  process.exit(code)
}

async function githubReleases() {
  const r = await fetch(SOURCE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'the-diva-kernel-update',
      ...(process.env.GITHUB_TOKEN ? { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) throw new Error('GitHub HTTP ' + r.status)
  return r.json()
}

async function loginSession(gateway, username, password) {
  const r = await fetch(gateway.replace(/\/+$/, '') + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, gatewayToken: false, device: 'kernel-update-cli' }),
  })
  const json = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(json.error?.message ?? `登录失败 HTTP ${r.status}`)
  if (!json.sessionToken) throw new Error('登录成功但没有 sessionToken')
  return json.sessionToken
}

async function resolveCurrent() {
  const explicit = argOf('--current')
  if (explicit) return explicit
  const gateway = argOf('--gateway') ?? process.env.DESK_GATEWAY_URL
  const user = argOf('--user')
  const password = argOf('--password')
  if (gateway && user && password) {
    try {
      const token = await loginSession(gateway, user, password)
      const r = await fetch(String(gateway).replace(/\/+$/, '') + '/api/kernel/current', {
        headers: { authorization: 'Bearer ' + token },
      })
      const json = await r.json().catch(() => ({}))
      if (r.ok && json.version) return json.version
    } catch {
      /* 拉不到就退回 pin */
    }
  }
  return PIN.version
}

async function cmdDiscover() {
  const current = await resolveCurrent()
  const releases = await githubReleases()
  const out = filterDiscoverable(releases, current)
  console.log(`current=${current}`)
  if (!out.length) {
    console.log('(没有比 current 新的可发现版本)')
    return
  }
  for (const x of out) console.log(`${x.tag}\t${x.version}\t${x.name}`)
}

function cmdPrepare() {
  const version = argOf('--version')
  if (!version) usage('缺少 --version')
  const outDir = path.resolve(argOf('--out') ?? 'build/kernel-update')
  const givenPrefix = argOf('--prefix')
  // 没给 --prefix 时用临时目录装内核（几百 MB）：成功失败都要清掉，别每次 prepare 泄漏一份完整安装
  const tempPrefix = givenPrefix ? null : fs.mkdtempSync(path.join(os.tmpdir(), `diva-kprep-${version}-`))
  const prefix = path.resolve(givenPrefix ?? tempPrefix)
  const skillsDir = path.resolve(argOf('--skills-dir') ?? path.join(defaultDshHome(), 'desk', 'drive', '_shared', 'skills'))
  const log = (msg) => console.log(`[kernel] ${msg}`)
  try {
    const { tarPath, manifest } = prepareKernelTarball({ version, prefix, outDir, skillsDir, log })
    log(`写出 ${tarPath}`)
    console.log(JSON.stringify(manifest, null, 2))
  } finally {
    if (tempPrefix) fs.rmSync(tempPrefix, { recursive: true, force: true })
  }
}

async function cmdPublish() {
  const gateway = argOf('--gateway') ?? process.env.DESK_GATEWAY_URL
  const user = argOf('--user')
  const password = argOf('--password')
  const from = argOf('--from')
  if (!gateway || !user || !password || !from) usage('publish 需要 --gateway --user --password --from')
  const dir = path.resolve(from)
  const manifestFile = path.join(dir, 'manifest.json')
  const tarFile = path.join(dir, 'kernel.tar')
  if (!fs.existsSync(manifestFile)) die(`--from 目录缺少 manifest.json：${dir}`)
  if (!fs.existsSync(tarFile)) die(`--from 目录缺少 kernel.tar：${dir}`)
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const token = await loginSession(gateway, user, password)
  const body = fs.readFileSync(tarFile)
  const r = await fetch(String(gateway).replace(/\/+$/, '') + '/api/admin/kernel/publish', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/octet-stream',
      'x-kernel-version': manifest.version ?? '',
      'x-kernel-sha256': manifest.sha256 ?? '',
      'x-kernel-source-tag': manifest.sourceTag ?? '',
    },
    body,
  })
  const json = await r.json().catch(() => ({}))
  if (!r.ok) die(json.error?.message ?? `发布失败 HTTP ${r.status}`)
  console.log(JSON.stringify(json, null, 2))
}

const cmd = args[0]
if (!cmd || cmd.startsWith('-') || has('--help') || has('-h')) usage()

try {
  if (cmd === 'discover') await cmdDiscover()
  else if (cmd === 'prepare') cmdPrepare()
  else if (cmd === 'publish') await cmdPublish()
  else usage(`未知命令 ${cmd}`)
} catch (err) {
  die(err.message ?? String(err))
}
