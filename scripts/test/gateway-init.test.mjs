import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { init } from '../../installer/gateway/init.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function fakeInstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-gw-'))
  const inst = path.join(dir, 'THE DIVA Gateway')
  fs.mkdirSync(path.join(inst, 'server'), { recursive: true })
  fs.mkdirSync(path.join(inst, 'service'), { recursive: true })
  fs.copyFileSync(path.join(repo, 'installer', 'gateway', 'TheDivaGateway.xml.tpl'), path.join(inst, 'service', 'TheDivaGateway.xml.tpl'))
  return { dir, inst, programData: path.join(dir, 'ProgramData') }
}

test('init：建数据目录、写默认 config.local.json、渲染服务 XML', () => {
  const { inst, programData } = fakeInstall()
  const r = init(inst, { programData, computerName: 'GW-HOST' })
  assert.equal(r.dataDir, path.join(programData, 'THE DIVA Gateway', 'data'))
  assert.ok(fs.existsSync(r.dataDir))
  assert.ok(fs.existsSync(r.logDir))
  assert.equal(r.wroteConfig, true)
  assert.equal(r.port, 8790)
  assert.equal(r.publicUrl, 'http://gw-host:8790')
  const cfg = JSON.parse(fs.readFileSync(path.join(inst, 'server', 'config.local.json'), 'utf8'))
  assert.deepEqual(cfg, { host: '0.0.0.0', port: 8790, publicUrl: 'http://gw-host:8790', dataDir: r.dataDir, seedUsers: [] })
  const xml = fs.readFileSync(path.join(inst, 'service', 'TheDivaGateway.xml'), 'utf8')
  assert.match(xml, /<id>TheDivaGateway<\/id>/)
  assert.ok(xml.includes(`<executable>${inst}\\runtime\\node.exe</executable>`))
  assert.ok(xml.includes(`<env name="DESK_GATEWAY_DATA" value="${r.dataDir}"/>`))
  assert.ok(xml.includes(`<logpath>${r.logDir}</logpath>`))
  assert.ok(!xml.includes('{{'), '没有残留占位符')
})

test('init：已有 config.local.json 不覆盖，但端口从里面读；XML 每次重写', () => {
  const { inst, programData } = fakeInstall()
  fs.writeFileSync(path.join(inst, 'server', 'config.local.json'), JSON.stringify({ host: '0.0.0.0', port: 9000, company: { name: 'X' } }))
  const r = init(inst, { programData, computerName: 'A' })
  assert.equal(r.wroteConfig, false)
  assert.equal(r.port, 9000)
  assert.equal(JSON.parse(fs.readFileSync(path.join(inst, 'server', 'config.local.json'), 'utf8')).company.name, 'X')
  fs.writeFileSync(path.join(inst, 'service', 'TheDivaGateway.xml'), 'stale')
  init(inst, { programData, computerName: 'A' })
  assert.match(fs.readFileSync(path.join(inst, 'service', 'TheDivaGateway.xml'), 'utf8'), /<service>/)
})

test('init：新建的 config.local.json 带 seedUsers: []（不创建 config.json 里的演示账号）；已有配置原样保留、不注入 seedUsers', () => {
  const { inst, programData } = fakeInstall()
  const configFile = path.join(inst, 'server', 'config.local.json')
  init(inst, { programData, computerName: 'A' })
  const fresh = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  assert.ok(Array.isArray(fresh.seedUsers), 'seedUsers 是数组')
  assert.equal(fresh.seedUsers.length, 0, 'seedUsers 为空：deepMerge 整体替换数组，config.json 的演示账号不会被种下')
  assert.ok(!('seedAdmin' in fresh), '不覆盖 seedAdmin，种子管理员 boss 仍由 config.json 提供')
  // 管理员改过的配置（自定义 seedUsers、没有 seedUsers 都算）：再跑 init 一个字节都不动
  for (const existing of [JSON.stringify({ host: '0.0.0.0', port: 9000, seedUsers: [{ username: 'ops', password: 'x' }] }), JSON.stringify({ port: 9001 })]) {
    fs.writeFileSync(configFile, existing)
    const r = init(inst, { programData, computerName: 'A' })
    assert.equal(r.wroteConfig, false)
    assert.equal(fs.readFileSync(configFile, 'utf8'), existing)
  }
})

test('init：路径里的 & 会被 XML 转义', () => {
  const { dir, programData } = fakeInstall()
  const inst = path.join(dir, 'A & B')
  fs.mkdirSync(path.join(inst, 'server'), { recursive: true })
  fs.mkdirSync(path.join(inst, 'service'), { recursive: true })
  fs.copyFileSync(path.join(repo, 'installer', 'gateway', 'TheDivaGateway.xml.tpl'), path.join(inst, 'service', 'TheDivaGateway.xml.tpl'))
  init(inst, { programData, computerName: 'A' })
  const xml = fs.readFileSync(path.join(inst, 'service', 'TheDivaGateway.xml'), 'utf8')
  assert.ok(xml.includes('A &amp; B\\runtime\\node.exe'))
})
