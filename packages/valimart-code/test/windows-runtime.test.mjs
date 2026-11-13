import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ensureWindowsRuntime, releaseAssetUrl } from '../bin/windows-runtime.mjs'
import { windowsStubFiles } from '../scripts/publish-npm.mjs'

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valimart-winrt-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 假解压：只要求结果里有 bin\valimart.cmd，和正式 zip 的顶层结构一致（bin/ lib/）。 */
function fakeExtract(zip, dest) {
  fs.mkdirSync(path.join(dest, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(dest, 'bin', 'valimart.cmd'), '@echo off\n')
}

test('下载地址指向同版本的 Release 资产', () => {
  assert.equal(
    releaseAssetUrl('0.2.3'),
    'https://github.com/ethanfly/valimart-harness/releases/download/latest/valimart-code-0.2.3-windows-x64.zip',
  )
})

test('第一次下载、解压、放到缓存；第二次直接用缓存不再下载', async (t) => {
  const cacheRoot = tmp(t)
  const stubDir = tmp(t)
  let downloads = 0
  const fetchImpl = async () => {
    downloads++
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }
  }
  const first = await ensureWindowsRuntime({ version: '0.2.3', stubDir, cacheRoot, fetchImpl, extract: fakeExtract })
  assert.equal(first, path.join(cacheRoot, '0.2.3', 'bin', 'valimart.cmd'))
  assert.equal(downloads, 1)
  assert.ok(fs.existsSync(first))

  const second = await ensureWindowsRuntime({ version: '0.2.3', stubDir, cacheRoot, fetchImpl, extract: fakeExtract })
  assert.equal(second, first)
  assert.equal(downloads, 1, '缓存命中不应再下载')
})

test('占位包里已经有程序（旧版整包）就直接用，不下载', async (t) => {
  const stubDir = tmp(t)
  fs.mkdirSync(path.join(stubDir, 'bin'))
  fs.writeFileSync(path.join(stubDir, 'bin', 'valimart.cmd'), '@echo off\n')
  const fetchImpl = async () => {
    throw new Error('不应下载')
  }
  const got = await ensureWindowsRuntime({ version: '0.2.1', stubDir, cacheRoot: tmp(t), fetchImpl, extract: fakeExtract })
  assert.equal(got, path.join(stubDir, 'bin', 'valimart.cmd'))
})

test('下载失败：报 HTTP 状态，不留下半成品缓存', async (t) => {
  const cacheRoot = tmp(t)
  const fetchImpl = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })
  await assert.rejects(
    ensureWindowsRuntime({ version: '0.2.3', stubDir: tmp(t), cacheRoot, fetchImpl, extract: fakeExtract }),
    /HTTP 404/,
  )
  assert.equal(fs.existsSync(path.join(cacheRoot, '0.2.3')), false)
  assert.deepEqual(fs.readdirSync(cacheRoot).filter((n) => n.startsWith('.download')), [])
})

test('zip 解压后缺入口：报版本包损坏，不进缓存', async (t) => {
  const cacheRoot = tmp(t)
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) })
  const brokenExtract = (_zip, dest) => fs.mkdirSync(path.join(dest, 'lib'), { recursive: true })
  await assert.rejects(
    ensureWindowsRuntime({ version: '0.2.3', stubDir: tmp(t), cacheRoot, fetchImpl, extract: brokenExtract }),
    /损坏/,
  )
  assert.equal(fs.existsSync(path.join(cacheRoot, '0.2.3')), false)
})

test('Windows 占位包只带 package.json，版本与资产名对得上，体积不含程序', () => {
  const files = windowsStubFiles('0.2.3')
  assert.deepEqual(Object.keys(files), ['package.json'])
  const pkg = JSON.parse(files['package.json'])
  assert.equal(pkg.name, 'valimart-code-windows-x64')
  assert.equal(pkg.version, '0.2.3')
  assert.deepEqual(pkg.os, ['win32'])
  assert.deepEqual(pkg.cpu, ['x64'])
  assert.deepEqual(pkg.files, ['package.json'])
  assert.equal(pkg.valimart.releaseAsset, 'valimart-code-0.2.3-windows-x64.zip')
})
