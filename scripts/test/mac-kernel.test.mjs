import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { findTar } from '../lib/find-tar.mjs'
import { nodePtyDarwinRequirements, restoreDarwinNodePty } from '../lib/mac-kernel.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-pty-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source')
  const stage = path.join(root, 'stage')
  const cacheDir = path.join(root, 'cache')
  const rel = 'node_modules/@deepseek-ai/dsh/node_modules/node-pty'
  const version = '1.2.0-beta.15'
  const put = (base, file, data) => {
    const dest = path.join(base, file)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, data)
  }
  put(source, `${rel}/package.json`, JSON.stringify({ name: 'node-pty', version }))
  put(source, `${rel}/lib/index.js`, 'local patch')
  put(source, `${rel}/prebuilds/win32-x64/pty.node`, 'windows')
  fs.cpSync(source, stage, { recursive: true })
  fs.mkdirSync(cacheDir)
  const pack = ({ archiveVersion = version, name = 'node-pty', files = ['pty.node', 'spawn-helper'] } = {}) => {
    const pkg = path.join(root, 'tar-source')
    fs.rmSync(pkg, { recursive: true, force: true })
    put(pkg, 'package/package.json', JSON.stringify({ name, version: archiveVersion }))
    put(pkg, 'package/lib/index.js', 'upstream, must not replace patch')
    for (const file of files) put(pkg, `package/prebuilds/darwin-x64/${file}`, `darwin ${file}`)
    put(pkg, 'package/prebuilds/linux-x64/pty.node', 'must not restore')
    const r = spawnSync(findTar(), ['-czf', path.join(cacheDir, `node-pty-${version}.tgz`), '-C', pkg, 'package'], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr || r.error?.message)
  }
  return { root, source, stage, cacheDir, rel, version, put, pack }
}

test('trimmed Windows node-pty: exact prerelease cache restores stage only, preserves patches, idempotent', (t) => {
  const f = fixture(t)
  const req = nodePtyDarwinRequirements(f.source)
  assert.equal(req.length, 1)
  assert.equal(req[0].spec, 'node-pty@1.2.0-beta.15')
  assert.equal(req[0].tgz, 'node-pty-1.2.0-beta.15.tgz')
  f.pack()
  assert.equal(restoreDarwinNodePty(f), 1)
  for (const file of ['pty.node', 'spawn-helper']) {
    assert.equal(fs.readFileSync(path.join(f.stage, f.rel, 'prebuilds/darwin-x64', file), 'utf8'), `darwin ${file}`)
    assert.equal(fs.existsSync(path.join(f.source, f.rel, 'prebuilds/darwin-x64', file)), false)
  }
  assert.equal(fs.readFileSync(path.join(f.stage, f.rel, 'lib/index.js'), 'utf8'), 'local patch')
  assert.equal(fs.existsSync(path.join(f.stage, f.rel, 'prebuilds/linux-x64')), false)
  assert.equal(fs.readFileSync(path.join(f.stage, f.rel, 'package.json'), 'utf8'), fs.readFileSync(path.join(f.source, f.rel, 'package.json'), 'utf8'))
  fs.rmSync(f.cacheDir, { recursive: true })
  assert.equal(restoreDarwinNodePty(f), 0, 'complete prebuilds need no cache/network')
  assert.equal(fs.readdirSync(f.root).some((n) => n.startsWith('.node-pty-darwin-')), false)
})

test('missing cache fails early with exact npm pack version', (t) => {
  const f = fixture(t)
  assert.throws(() => restoreDarwinNodePty(f), /npm pack node-pty@1\.2\.0-beta\.15/)
})

for (const [label, options, expected] of [
  ['wrong version', { archiveVersion: '1.2.0-beta.14' }, /版本不匹配/],
  ['wrong package', { name: 'not-node-pty' }, /版本不匹配/],
  ['missing helper', { files: ['pty.node'] }, /缺完整 darwin-x64/],
]) {
  test(`rejects ${label} cache without changing stage package`, (t) => {
    const f = fixture(t)
    f.pack(options)
    assert.throws(() => restoreDarwinNodePty(f), expected)
    assert.equal(fs.existsSync(path.join(f.stage, f.rel, 'prebuilds/darwin-x64')), false)
    assert.equal(fs.readdirSync(f.root).some((n) => n.startsWith('.node-pty-darwin-')), false)
  })
}

test('partial/empty prebuilds repaired and multiple installed versions discovered', (t) => {
  const f = fixture(t)
  f.put(f.stage, `${f.rel}/prebuilds/darwin-x64/pty.node`, '')
  f.pack()
  assert.equal(restoreDarwinNodePty(f), 1)
  f.put(f.stage, 'node_modules/node-pty/package.json', JSON.stringify({ name: 'node-pty', version: '1.1.0' }))
  const req = nodePtyDarwinRequirements(f.stage)
  assert.deepEqual(req.map((r) => r.spec), ['node-pty@1.1.0'])
})
