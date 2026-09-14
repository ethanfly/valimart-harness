import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { verifyMacSessionLock } from '../lib/mac-session-lock.mjs'
import { darwinSystemRequirements } from '../lib/mac-kernel.mjs'

const lockSource = 'import { tryLockExclusive } from "@deepseek-ai/node-addon-system/flock";'
function fixture() {
  const base = '@deepseek-ai/node-addon-system'
  const bytes = Buffer.alloc(32)
  bytes.writeUInt32LE(0xfeedfacf, 0)
  bytes.writeUInt32LE(0x01000007, 4)
  const entries = {
    [`${base}/package.json`]: JSON.stringify({ exports: { './flock': { default: './lib/flock.js' } }, optionalDependencies: { [`${base}-darwin-x64`]: '0.1.2' } }),
    [`${base}/lib/flock.js`]: 'const filename = \'system.node\'; const dir = \'bin\'; const manifest = `@deepseek-ai/node-addon-system-${platform}-${arch}/package.json`; export async function tryLockExclusive() { loadBinding().tryLock() }',
    [`${base}-darwin-x64/package.json`]: JSON.stringify({ name: `${base}-darwin-x64`, version: '0.1.2', os: ['darwin'], cpu: ['x64'] }),
    [`${base}-darwin-x64/bin/system.node`]: bytes,
  }
  return { entries, readEntry: (name) => { if (!(name in entries)) throw new Error(`missing ${name}`); return entries[name] } }
}
test('new lock validates Darwin native package, version, loader syntax and Mach-O', () => {
  assert.equal(verifyMacSessionLock({ lockSource, ...fixture() }), 'node-addon-system')
})
for (const [label, key, value, error] of [
  ['missing native', '@deepseek-ai/node-addon-system-darwin-x64/bin/system.node', null, /missing/],
  ['Windows native', '@deepseek-ai/node-addon-system-darwin-x64/bin/system.node', Buffer.from('MZ Windows binary'), /Mach-O/],
  ['invalid loader syntax', '@deepseek-ai/node-addon-system/lib/flock.js', 'export async function {', /语法错误/],
  ['wrong platform version', '@deepseek-ai/node-addon-system-darwin-x64/package.json', '{}', /版本\/平台不匹配/],
]) {
  test(`rejects ${label}`, () => {
    const f = fixture()
    if (value === null) delete f.entries[key]; else f.entries[key] = value
    assert.throws(() => verifyMacSessionLock({ lockSource, ...f }), error)
  })
}
test('legacy koffi lock remains accepted; old fs-ext and invalid syntax rejected', () => {
  assert.equal(verifyMacSessionLock({ lockSource: '// company-session-lock-v2\nfunction companyPosixFlock() { koffi.load("libc") }' }), 'koffi')
  assert.throws(() => verifyMacSessionLock({ lockSource: 'import { flock } from "fs-ext";' }), /fs-ext/)
  assert.throws(() => verifyMacSessionLock({ lockSource: 'function {' }), /语法错误/)
})
test('system requirements use entry package exact optional version; old kernels require nothing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-system-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.deepEqual(darwinSystemRequirements(root), [])
  const dir = path.join(root, 'node_modules/@deepseek-ai/node-addon-system')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ optionalDependencies: { '@deepseek-ai/node-addon-system-darwin-x64': '0.1.2' } }))
  assert.equal(darwinSystemRequirements(root)[0].spec, '@deepseek-ai/node-addon-system-darwin-x64@0.1.2')
})
