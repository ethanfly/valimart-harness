/**
 * 出 Linux x64 网关发行包：
 *   node scripts/build-gateway-linux.mjs
 * 产物：dist/valimart-harness-Gateway-linux-x64-<ver>.tar.gz
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGatewayLinux } from './lib/gateway-linux.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pins = JSON.parse(fs.readFileSync(path.join(root, 'installer', 'pins.json'), 'utf8'))
const log = (m) => console.log(`[dist:gateway:linux] ${m}`)

try {
  const r = await buildGatewayLinux({ repoRoot: root, pins, log })
  log(`${r.outFile} (${(r.size / 1024 / 1024).toFixed(1)} MB)`)
} catch (err) {
  console.error(`[dist:gateway:linux] ${err.message}`)
  process.exit(1)
}
