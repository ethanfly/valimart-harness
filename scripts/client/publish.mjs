/**
 * 把 dist:client 打出的 Setup.exe 上传到网关并发布为当前客户端。
 *   node scripts/client/publish.mjs --gateway http://127.0.0.1:8790 --user boss --password … --from dist/valimart-harness-Setup-0.1.0.exe
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashFile } from '../lib/kernel-update.mjs'
import { extractClientMetaFromInstaller, readLocalBuildId, resolvePublishedBuildId } from '../lib/client-update.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const has = (k) => args.includes(k)
const argOf = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] && !String(args[i + 1]).startsWith('-') ? args[i + 1] : d
}
const die = (m) => {
  console.error(`[client:publish] ${m}`)
  process.exit(1)
}

if (has('--help') || has('-h') || !args.length) {
  console.log(`node scripts/client/publish.mjs --gateway <url> --user <admin> --password <…> --from <Setup.exe> [--build-id <id>]`)
  process.exit(args.length ? 0 : 64)
}

const gateway = (argOf('--gateway') ?? process.env.DESK_GATEWAY_URL ?? '').replace(/\/+$/, '')
const user = argOf('--user')
const password = argOf('--password')
const from = argOf('--from')
if (!gateway || !user || !password || !from) die('需要 --gateway --user --password --from')

const exe = path.resolve(from)
if (!fs.existsSync(exe)) die(`找不到安装包 ${exe}`)
const payloadDir = path.join(root, 'build', 'payload')
const body = fs.readFileSync(exe)
const buildId = resolvePublishedBuildId({
  headerBuildId: argOf('--build-id') || readLocalBuildId(payloadDir),
  extracted: extractClientMetaFromInstaller(body),
})
if (!buildId) die('缺少 buildId：安装包里读不到，先跑 npm run dist:client，或传 --build-id')
const sha = hashFile(exe)
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version

const login = await fetch(gateway + '/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: user, password, gatewayToken: false, device: 'client-publish' }),
})
const session = await login.json().catch(() => ({}))
if (!login.ok) die(session.error?.message ?? `登录失败 HTTP ${login.status}`)

const r = await fetch(gateway + '/api/admin/client/publish', {
  method: 'POST',
  headers: {
    authorization: 'Bearer ' + session.sessionToken,
    'content-type': 'application/octet-stream',
    'x-client-build-id': buildId,
    'x-client-sha256': sha,
    'x-client-version': version,
    'x-client-filename': path.basename(exe),
  },
  body,
})
const json = await r.json().catch(() => ({}))
if (!r.ok) die(json.error?.message ?? `发布失败 HTTP ${r.status}`)
console.log(JSON.stringify(json, null, 2))
