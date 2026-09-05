import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { initLinux } from '../../installer/gateway/init-linux.mjs'
import { stageGatewayApp } from '../lib/gateway-stage.mjs'
import { buildGatewayLinux, copyLinuxRuntime, packGatewayLinuxTarball } from '../lib/gateway-linux.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function fakeLinuxInstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-gw-linux-'))
  const inst = path.join(dir, 'valimart-harness-gateway')
  fs.mkdirSync(path.join(inst, 'server'), { recursive: true })
  fs.mkdirSync(path.join(inst, 'service'), { recursive: true })
  fs.copyFileSync(path.join(repo, 'installer', 'gateway', 'TheDivaGateway.service.tpl'), path.join(inst, 'service', 'TheDivaGateway.service.tpl'))
  return { dir, inst, stateRoot: path.join(dir, 'var', 'lib', 'valimart-harness-gateway'), logRoot: path.join(dir, 'var', 'log', 'valimart-harness-gateway') }
}

test('stageGatewayApp：源码、品牌图、scripts，不带 data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-gw-app-'))
  const stage = path.join(dir, 'stage')
  stageGatewayApp(repo, stage)
  assert.ok(fs.existsSync(path.join(stage, 'server', 'src', 'index.js')))
  assert.ok(fs.existsSync(path.join(stage, 'server', 'src', 'oauth-providers', 'chatgpt.js')))
  assert.ok(fs.existsSync(path.join(stage, 'plugins', 'desk-ui', 'src', 'client', 'assets', 'valimart-mark.png')))
  assert.ok(fs.existsSync(path.join(stage, 'scripts', 'backup-gateway.mjs')))
  assert.ok(!fs.existsSync(path.join(stage, 'server', 'data')))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('initLinux：建数据目录、写 config.local.json、渲染 systemd 单元', () => {
  const { inst, stateRoot, logRoot } = fakeLinuxInstall()
  const r = initLinux(inst, { stateRoot, logRoot, computerName: 'GW-HOST', userName: 'thediva-gateway' })
  assert.equal(r.wroteConfig, true)
  assert.equal(r.port, 8790)
  assert.equal(r.publicUrl, 'http://gw-host:8790')
  const cfg = JSON.parse(fs.readFileSync(path.join(inst, 'server', 'config.local.json'), 'utf8'))
  assert.equal(cfg.seedAdmin, false)
  assert.deepEqual(cfg.seedUsers, [])
  assert.equal(cfg.packaged, true)
  const unit = fs.readFileSync(r.unitFile, 'utf8')
  assert.match(unit, /User=thediva-gateway/)
  assert.match(unit, /Environment=DESK_GATEWAY_PACKAGED=1/)
  assert.match(unit, /TheDivaGateway\.out\.log/)
  assert.ok(!unit.includes('{{'))
})

test('initLinux：已有 config.local.json 不覆盖，单元每次重写', () => {
  const { inst, stateRoot, logRoot } = fakeLinuxInstall()
  fs.writeFileSync(path.join(inst, 'server', 'config.local.json'), JSON.stringify({ host: '0.0.0.0', port: 9000, company: { name: 'X' } }))
  const r = initLinux(inst, { stateRoot, logRoot, computerName: 'A' })
  assert.equal(r.wroteConfig, false)
  assert.equal(r.port, 9000)
  assert.equal(JSON.parse(fs.readFileSync(path.join(inst, 'server', 'config.local.json'), 'utf8')).company.name, 'X')
  fs.writeFileSync(path.join(inst, 'service', 'TheDivaGateway.service'), 'stale')
  initLinux(inst, { stateRoot, logRoot, computerName: 'A' })
  assert.match(fs.readFileSync(path.join(inst, 'service', 'TheDivaGateway.service'), 'utf8'), /\[Service\]/)
})

test('buildGatewayLinux：假 runtime 打出 tar.gz，内含 install.sh 与 node', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-gw-pack-'))
  const extracted = path.join(dir, 'node-fake')
  fs.mkdirSync(path.join(extracted, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(extracted, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(extracted, 'bin', 'node'), '#!/bin/sh\n')
  fs.writeFileSync(path.join(extracted, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'export {}\n')
  const destRuntime = path.join(dir, 'runtime')
  copyLinuxRuntime(extracted, destRuntime)
  assert.ok(fs.existsSync(path.join(destRuntime, 'bin', 'node')))
  assert.ok(fs.existsSync(path.join(destRuntime, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')))

  const stage = path.join(dir, 'valimart-harness-gateway')
  const dist = path.join(dir, 'dist')
  const pins = { nodeLinuxX64: { version: '25.2.1' } }
  return buildGatewayLinux({
    repoRoot: repo,
    pins,
    stage,
    cache: path.join(dir, 'cache'),
    dist,
    extractedRuntime: extracted,
    log: () => {},
  }).then((built) => {
    assert.ok(fs.existsSync(built.outFile))
    const list = spawnSync('tar', ['-tzf', built.outFile], { encoding: 'utf8' })
    assert.equal(list.status, 0)
    assert.match(list.stdout, /valimart-harness-gateway\/install\.sh/)
    assert.match(list.stdout, /valimart-harness-gateway\/runtime\/bin\/node/)
    assert.match(list.stdout, /valimart-harness-gateway\/server\/src\/index\.js/)
    assert.match(list.stdout, /TheDivaGateway\.service\.tpl/)
    assert.ok(!list.stdout.includes('config.local.json'))
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

test('packGatewayLinuxTarball：顶层目录名与 stage 一致', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-gw-tar-'))
  const stage = path.join(dir, 'valimart-harness-gateway')
  fs.mkdirSync(stage)
  fs.writeFileSync(path.join(stage, 'README.txt'), 'ok\n')
  const out = path.join(dir, 'out.tar.gz')
  packGatewayLinuxTarball(stage, out)
  const list = spawnSync('tar', ['-tzf', out], { encoding: 'utf8' })
  assert.match(list.stdout, /^valimart-harness-gateway\/README\.txt/m)
  fs.rmSync(dir, { recursive: true, force: true })
})
