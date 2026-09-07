import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyInstallGuards, isPackagedGateway, toProductionConfig } from '../../server/src/config.js'
import { assertGatewayStageClean, copyServerSrc, stageGatewayApp, writeStagedGatewayConfig } from '../lib/gateway-stage.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('toProductionConfig：安装包 config 不带 seedUsers / mock，保留未接通道目录', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(repo, 'server', 'config.json'), 'utf8'))
  assert.ok(raw.seedUsers?.length > 0, '开发 config 仍有演示账号，方便 npm run dev')
  assert.equal(raw.upstreams.mock?.kind, 'mock')
  const prod = toProductionConfig(raw)
  assert.equal(prod.seedAdmin, false)
  assert.deepEqual(prod.seedUsers, [])
  assert.equal(prod.seedDriveSamples, false)
  assert.equal(prod.packaged, true)
  assert.ok(!prod.upstreams.mock)
  assert.ok(prod.upstreams.deepseek, '真实上游目录保留，只是未配密钥')
  assert.ok(prod.channels.some((c) => c.id === 'grok'))
  assert.ok(prod.channels.some((c) => c.id === 'chatgpt'))
  assert.ok(prod.channels.some((c) => c.id === 'claude'))
  assert.notEqual(raw.seedAdmin, false, '不改开发 config.json')
})

test('applyInstallGuards：NODE_ENV=production / packaged 去掉种子与 mock', () => {
  const cfg = {
    seedAdmin: { username: 'boss', password: 'boss123456' },
    seedUsers: [{ username: 'emp-a', password: 'x' }],
    seedDriveSamples: true,
    upstreams: { mock: { kind: 'mock', label: 'Mock' }, deepseek: { kind: 'openai-compatible' } },
  }
  applyInstallGuards(cfg, { NODE_ENV: 'production' })
  assert.equal(cfg.seedAdmin, false)
  assert.deepEqual(cfg.seedUsers, [])
  assert.equal(cfg.seedDriveSamples, false)
  assert.ok(!cfg.upstreams.mock)
  assert.ok(cfg.upstreams.deepseek)
  assert.equal(isPackagedGateway({ packaged: true }), true)
  assert.equal(isPackagedGateway({}, { DESK_GATEWAY_PACKAGED: '1' }), true)
  const keep = { seedAdmin: { username: 'boss', password: 'x' }, seedUsers: [{ username: 'a' }], upstreams: { mock: { kind: 'mock' } } }
  applyInstallGuards(keep, {})
  assert.equal(keep.seedAdmin.username, 'boss')
  assert.equal(keep.upstreams.mock.kind, 'mock')
})

test('copyServerSrc：带子目录 oauth-providers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-gw-src-'))
  copyServerSrc(repo, path.join(dir, 'server'))
  assert.ok(fs.existsSync(path.join(dir, 'server', 'src', 'index.js')))
  assert.ok(fs.existsSync(path.join(dir, 'server', 'src', 'oauth-providers', 'chatgpt.js')))
  assert.ok(fs.existsSync(path.join(dir, 'server', 'src', 'upstream-chatgpt.js')))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('writeStagedGatewayConfig + assertGatewayStageClean：不拷 data、不带种子', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-gw-stage-'))
  const stage = path.join(dir, 'stage')
  const prod = writeStagedGatewayConfig(repo, path.join(stage, 'server'))
  assert.equal(prod.seedAdmin, false)
  const checked = assertGatewayStageClean(stage)
  assert.equal(checked.packaged, true)
  assert.ok(!fs.existsSync(path.join(stage, 'server', 'data')))
  fs.mkdirSync(path.join(stage, 'server', 'data'))
  assert.throws(() => assertGatewayStageClean(stage), /data/)
})

test('stageGatewayApp：含客户端目录与共用库', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-gw-client-'))
  const stage = path.join(dir, 'stage')
  stageGatewayApp(repo, stage, { version: '0.0.0-test' })
  assert.ok(fs.existsSync(path.join(stage, 'server', 'src', 'client-catalog.js')))
  assert.ok(fs.existsSync(path.join(stage, 'scripts', 'lib', 'client-update.mjs')))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('stageGatewayApp：服务端引用的 scripts/lib 都必须打进包', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-gw-libs-'))
  const stage = path.join(dir, 'stage')
  stageGatewayApp(repo, stage, { version: '0.0.0-test' })
  const srcDir = path.join(repo, 'server', 'src')
  const needed = new Set()
  for (const name of fs.readdirSync(srcDir, { recursive: true })) {
    const file = path.join(srcDir, name)
    if (!fs.statSync(file).isFile() || !/\.(js|mjs)$/.test(file)) continue
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(/from ['"]\.\.\/\.\.\/scripts\/lib\/([^'"]+)['"]/g)) needed.add(m[1])
  }
  assert.ok(needed.has('model-input.mjs'), 'config/channels 已引用 model-input')
  for (const f of needed) {
    assert.ok(fs.existsSync(path.join(stage, 'scripts', 'lib', f)), `安装包缺少 scripts/lib/${f}`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

test('网关安装器：默认目录是新产品名，并改写旧版 THE DIVA Gateway', () => {
  const nsi = fs.readFileSync(path.join(repo, 'installer', 'gateway.nsi'), 'utf8')
  assert.match(nsi, /!define PRODUCT "valimart harness Gateway"/)
  assert.match(nsi, /InstallDir "\$PROGRAMFILES64\\\${PRODUCT}"/)
  assert.ok(nsi.includes('${WordReplace} $INSTDIR "THE DIVA Gateway"'), '旧目录名必须被改写成 PRODUCT')
})
