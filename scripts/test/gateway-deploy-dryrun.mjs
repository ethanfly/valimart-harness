/**
 * 本机干跑验收：用「树莓派 Docker 部署」那套配置（关播种、绝对数据目录、host 0.0.0.0）
 * 拉起网关，检查 /health、/api/setup（needsSetup 应为 true）、管理页、并确认没播种演示账号。
 *
 *   node scripts/test/gateway-deploy-dryrun.mjs
 *
 * 不依赖 Docker；只验证服务端在「生产式配置」下能起来且行为正确。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createGateway } from '../../server/src/index.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-dryrun-'))
const dataDir = path.join(tmp, 'data')
fs.mkdirSync(dataDir, { recursive: true })

// 快照源码目录里的 server/data（开发数据，通常本来就存在且被 .gitignore 忽略）：
// 要验的是「跑网关不会往源码目录写东西」，不是「这个目录必须不存在」。
const appDataDir = path.join(process.cwd(), 'server', 'data')
const snapshot = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort().join(',') : '<不存在>')
const beforeAppData = snapshot(appDataDir)

const PORT = 18791
const checks = []
const ok = (name, pass, detail = '') => {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const get = (p) =>
  new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('timeout')))
  })

const gateway = createGateway({
  host: '0.0.0.0',
  port: PORT,
  publicUrl: `http://127.0.0.1:${PORT}`,
  dataDir,
  seedAdmin: false,
  seedUsers: [],
  seedDriveSamples: false,
  packaged: true,
  lanDiscover: false,
  upstreams: { mock: { kind: 'mock', label: 'Mock', models: [{ id: 'mock-echo', name: 'Mock Echo' }] } },
})

const url = await gateway.listen()
ok('网关已监听 0.0.0.0', !!url, url)

try {
  ok('数据目录已创建', fs.existsSync(dataDir), dataDir)

  const health = await get('/health')
  ok('/health 200', health.status === 200, `status=${health.status}`)
  const h = JSON.parse(health.body)
  ok('/health 带 product 标识', h.product === 'valimart-harness', `product=${h.product} ok=${h.ok}`)

  const setup = await get('/api/setup')
  const s = JSON.parse(setup.body)
  ok('needsSetup=true（没有播种演示账号）', s.needsSetup === true, `needsSetup=${s.needsSetup}`)

  const admin = await get('/admin')
  ok('/admin 可达', admin.status === 200, `status=${admin.status}`)

  const brand = await get('/admin/brand/valimart-mark.png')
  ok('管理页品牌图可读（源码部署必须带上 assets）', brand.status === 200, `status=${brand.status}`)

  const dbFile = path.join(dataDir, 'gateway.sqlite')
  ok('sqlite 落盘到数据目录', fs.existsSync(dbFile), dbFile)
  ok('sqlite 头部正确', fs.readFileSync(dbFile).subarray(0, 15).toString() === 'SQLite format 3', '')

  const drive = path.join(dataDir, 'drive')
  ok('公司盘 drive/ 建在数据目录（不是 /app）', fs.existsSync(drive), drive)

  const inApp = path.join(process.cwd(), 'server', 'data')
  ok('没往源码目录写数据（快照未变）', snapshot(inApp) === beforeAppData, `${inApp} → ${beforeAppData}`)
} finally {
  await gateway.close()
}

const failed = checks.filter((c) => !c.pass)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
