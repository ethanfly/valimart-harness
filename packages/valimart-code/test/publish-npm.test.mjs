import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { archivesFor, packageRoot, PLATFORMS, rewritePackage } from '../scripts/publish-npm.mjs'

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valimart-npm-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('tar 顶层目录和 zip 裸内容都能找到 package.json', (t) => {
  const dir = tmp(t)
  const nested = path.join(dir, 'nested', 'valimart-code')
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(path.join(nested, 'package.json'), '{"version":"0.2.1"}\n')
  assert.equal(packageRoot(path.join(dir, 'nested')), nested)

  const flat = path.join(dir, 'flat')
  fs.mkdirSync(flat)
  fs.writeFileSync(path.join(flat, 'package.json'), '{"version":"0.2.1"}\n')
  assert.equal(packageRoot(flat), flat)
})

test('改写成平台包：名字、os/cpu、版本必须和入口包一致', (t) => {
  const dir = tmp(t)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'valimart-code', version: '0.2.1', valimart: { qwenCode: '1.0.0-preview.1' } }))
  const spec = PLATFORMS.find((p) => p.id === 'linux-x64')
  const next = rewritePackage(dir, spec, '0.2.1')
  assert.equal(next.name, 'valimart-code-linux-x64')
  assert.deepEqual(next.os, ['linux'])
  assert.deepEqual(next.cpu, ['x64'])
  assert.equal(next.valimart.qwenCode, '1.0.0-preview.1')
  assert.throws(() => rewritePackage(dir, spec, '9.9.9'), /不一致/)
})

test('按版本找齐三个归档，多一个或少一个都失败', (t) => {
  const dir = tmp(t)
  const touch = (name) => fs.writeFileSync(path.join(dir, name), '')
  touch('valimart-code-0.2.1-linux-x64.tar.gz')
  touch('valimart-code-0.2.1-darwin-arm64.tar.gz')
  touch('valimart-code-0.2.1-windows-x64.zip')
  touch('valimart-code-0.2.0-linux-x64.tar.gz')
  const found = archivesFor(dir, '0.2.1')
  assert.deepEqual(found.map((f) => f.spec.id), ['linux-x64', 'darwin-arm64', 'windows-x64'])
  fs.rmSync(path.join(dir, 'valimart-code-0.2.1-windows-x64.zip'))
  assert.throws(() => archivesFor(dir, '0.2.1'), /windows-x64/)
})
