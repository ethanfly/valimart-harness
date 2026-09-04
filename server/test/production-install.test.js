/**
 * 安装/生产空库：不播种演示账号，目录无 mock，通道未接，公司盘无示例正文。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../src/index.js'
import { Drive } from '../src/drive.js'

let gw
let base
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-prod-install-'))

before(async () => {
  gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: tmp,
    packaged: true,
    seedAdmin: false,
    seedUsers: [],
    seedDriveSamples: false,
    company: { name: 'valimart harness', plan: '团队版', seats: 20 },
    upstreams: {
      mock: { kind: 'mock', label: 'Mock', models: [{ id: 'mock-echo', name: 'Mock Echo' }] },
      deepseek: { kind: 'openai-compatible', label: 'DeepSeek', apiKeyEnv: '', apiKeyFile: '', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] },
    },
    channels: [
      { id: 'grok', label: 'Grok', kind: 'subscription', baseUrl: 'https://api.x.ai/v1', hint: 'grok-4.6' },
      { id: 'chatgpt', label: 'ChatGPT', kind: 'subscription', baseUrl: 'https://api.openai.com/v1', hint: 'gpt-5.5' },
      { id: 'claude', label: 'Claude', kind: 'subscription', baseUrl: 'https://api.anthropic.com/v1', hint: 'claude-opus-4-6' },
      { id: 'deepseek', label: 'DeepSeek', kind: 'key', baseUrl: 'https://api.deepseek.com', hint: 'deepseek-v4-pro' },
    ],
    fetchReleases: async () => [],
  })
  base = await gw.listen()
})

after(async () => {
  await gw.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function api(method, p, { token, body } = {}) {
  const r = await fetch(base + p, {
    method,
    headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await r.json().catch(() => ({}))
  return { status: r.status, json }
}

test('生产空库：无用户、无 mock 上游、公司盘只有空目录结构', () => {
  assert.equal(gw.db.listUsers().length, 0)
  assert.ok(!gw.cfg.upstreams.mock, 'packaged 必须剥掉 overrides 里的 mock')
  assert.equal(gw.cfg.seedAdmin, false)
  assert.deepEqual(gw.cfg.seedUsers, [])
  const driveRoot = gw.drive.root
  assert.ok(fs.existsSync(path.join(driveRoot, '_shared', 'handbook')))
  assert.ok(fs.existsSync(path.join(driveRoot, '_shared', 'skills')))
  assert.ok(!fs.existsSync(path.join(driveRoot, '_shared', 'handbook', '00-岗位手册-总则.md')))
  assert.ok(!fs.existsSync(path.join(driveRoot, '_shared', 'skills', 'company-briefing', 'SKILL.md')))
  assert.ok(fs.existsSync(path.join(driveRoot, '_shared', '_memory', 'README.md')))
})

test('引导后 API 空列表：只有刚创建的管理员，无任务，通道全未接，模型目录无 mock', async () => {
  const setup = await api('POST', '/api/setup', {
    body: {
      companyName: '正式公司',
      admin: { username: 'admin', displayName: '系统管理员', password: 'admin123456', department: '管理层' },
      device: 'test',
    },
  })
  assert.equal(setup.status, 201, setup.json.error?.message)
  const token = setup.json.sessionToken
  assert.ok(!setup.json.company.models.some((m) => m.id === 'mock-echo' || /mock/i.test(m.provider ?? '')))

  const people = await api('GET', '/api/people', { token })
  assert.equal(people.status, 200)
  assert.deepEqual(people.json.users.map((u) => u.username), ['admin'])
  assert.ok(!people.json.users.some((u) => ['boss', 'emp-a', 'mingan'].includes(u.username)))

  const tasks = await api('GET', '/api/tasks', { token })
  assert.equal(tasks.status, 200)
  assert.deepEqual(tasks.json.tasks, [])

  const colleagues = await api('GET', '/api/colleagues', { token })
  assert.equal(colleagues.status, 200)
  assert.deepEqual(colleagues.json.users.map((u) => u.username), ['admin'])
  assert.ok(colleagues.json.channels.length > 0, '通道目录可以有')
  for (const c of colleagues.json.channels) {
    assert.equal(c.connected, false, `${c.id} 必须未接`)
    assert.equal(c.statusLabel, '未接')
    assert.equal(c.modelCount, 0)
    assert.equal(c.source, null)
  }

  const models = await api('GET', '/v1/models', { token: setup.json.gatewayToken })
  assert.equal(models.status, 200)
  const ids = (models.json.data ?? []).map((m) => m.id)
  assert.ok(!ids.includes('mock-echo'))
})

test('Drive.ensureLayout({ seedSamples:false }) 不写示例正文', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-drive-empty-'))
  try {
    const drive = new Drive(dir)
    drive.ensureLayout({ seedSamples: false })
    assert.ok(!fs.existsSync(path.join(dir, '_shared', 'handbook', '00-岗位手册-总则.md')))
    assert.ok(!fs.existsSync(path.join(dir, '_shared', 'skills', 'company-briefing', 'SKILL.md')))
    drive.ensureLayout({ seedSamples: true })
    assert.ok(fs.existsSync(path.join(dir, '_shared', 'handbook', '00-岗位手册-总则.md')))
    assert.ok(fs.existsSync(path.join(dir, '_shared', 'skills', 'company-briefing', 'SKILL.md')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
