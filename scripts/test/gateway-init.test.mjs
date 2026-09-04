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
  assert.deepEqual(cfg, { host: '0.0.0.0', port: 8790, publicUrl: 'http://gw-host:8790', dataDir: r.dataDir })
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
