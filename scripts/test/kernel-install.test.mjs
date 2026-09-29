import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { formatNpmInstallError, kernelGlobalInstallArgs, profilePluginStatus, removeUnpinnedProfilePlugins } from '../lib/kernel-prepare.mjs'
import { resolveNpmRegistry } from '../lib/npm-cli.mjs'
import { PIN, stampPath } from '../kernel/locate.mjs'

test('kernel install args pin prerelease drift with --before', () => {
  const args = kernelGlobalInstallArgs({
    prefix: 'D:\\a\\kernel',
    spec: '@deepseek-ai/dsh@0.1.5-rc.2',
    windows: true,
    installBefore: '2026-09-22T05:00:00.000Z',
  })
  assert.equal(args.at(-2), '--before')
  assert.equal(args.at(-1), '2026-09-22T05:00:00.000Z')
  assert.ok(args.includes('--ignore-scripts'))
  assert.equal(kernelGlobalInstallArgs({ prefix: 'p', spec: 'a@1' }).includes('--before'), false)
})

test('formatNpmInstallError：带退出码和 stderr，不说检查网络', () => {
  const msg = formatNpmInstallError({
    status: 1,
    stdout: 'npm notice',
    stderr: 'npm ERR! 404 Not Found - GET https://registry.npmmirror.com/@deepseek-ai/dsh/0.1.3-alpha.1',
  })
  assert.match(msg, /退出码 1/)
  assert.match(msg, /404 Not Found/)
  assert.match(msg, /0\.1\.3-alpha\.1/)
  assert.equal(msg.includes('检查网络'), false)
})

test('formatNpmInstallError：只留输出尾部约 800 字', () => {
  const stderr = 'HEAD' + 'e'.repeat(900) + 'TAIL-404-not-found'
  const msg = formatNpmInstallError({ status: 1, stdout: '', stderr })
  assert.match(msg, /退出码 1/)
  assert.match(msg, /TAIL-404-not-found/)
  assert.equal(msg.includes('HEAD'), false)
  assert.ok(msg.length < 950)
})

test('resolveNpmRegistry：调用方优先于环境变量，缺省 npmmirror', () => {
  const prev = process.env.npm_config_registry
  try {
    delete process.env.npm_config_registry
    assert.equal(resolveNpmRegistry(), 'https://registry.npmmirror.com')
    assert.equal(resolveNpmRegistry('https://registry.npmjs.org/'), 'https://registry.npmjs.org')
    process.env.npm_config_registry = 'https://example.com/npm/'
    assert.equal(resolveNpmRegistry(), 'https://example.com/npm')
    assert.equal(resolveNpmRegistry('https://custom.example/'), 'https://custom.example')
  } finally {
    if (prev === undefined) delete process.env.npm_config_registry
    else process.env.npm_config_registry = prev
  }
})

function writeBareKernel(prefix, version) {
  const root = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  fs.writeFileSync(path.join(root, 'lib', 'bin.js'), '')
}

test('profilePluginStatus：按前缀里的实际版本报 ok', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-plugin-status-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const plugin = PIN.profilePlugins[0]
  fs.mkdirSync(path.join(dir, 'node_modules', plugin.name), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules', plugin.name, 'package.json'), JSON.stringify({ name: plugin.name, version: plugin.version }) + '\n')
  const [status] = profilePluginStatus({ prefix: dir, plugins: [plugin] })
  assert.equal(status.ok, true)
  const [missing] = profilePluginStatus({ prefix: dir, plugins: [{ name: '@no/such', version: '1.0.0' }] })
  assert.equal(missing.ok, false)
  assert.equal(missing.version, null)
})

test('removeUnpinnedProfilePlugins：卸掉 stamp 里已不在 pin 的插件', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-unpin-plugin-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  writeBareKernel(dir, '9.0.0')
  const leftover = path.join(dir, 'node_modules', 'dsh-better-sidebar')
  fs.mkdirSync(path.join(leftover, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(leftover, 'package.json'), '{"name":"dsh-better-sidebar"}\n')
  const keptName = PIN.profilePlugins[0].name
  const kept = path.join(dir, 'node_modules', keptName)
  fs.mkdirSync(path.join(kept, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(kept, 'package.json'), JSON.stringify({ name: keptName }) + '\n')
  fs.writeFileSync(stampPath(dir), JSON.stringify({
    profilePlugins: ['dsh-better-sidebar@0.18.0', `${keptName}@9.9.9`],
  }) + '\n')
  const removed = removeUnpinnedProfilePlugins({ prefix: dir, log: () => {} })
  assert.deepEqual(removed, ['dsh-better-sidebar'])
  assert.equal(fs.existsSync(leftover), false)
  assert.ok(fs.existsSync(path.join(kept, 'package.json')))
})
