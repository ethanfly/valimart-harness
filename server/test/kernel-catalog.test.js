/**
 * 内核目录：GitHub 发现项与 npm 上架对照（不打真网）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openKernelCatalog } from '../src/kernel-catalog.js'

function catalogTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-kcat-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('adminView：discover 标 onNpm；npm 查询失败不整页挂掉', async (t) => {
  const dir = catalogTmp(t)
  const releases = [
    { tag_name: 'dsh-v0.1.3-alpha.1', draft: false, prerelease: true, name: 'v0.1.3-alpha.1' },
    { tag_name: 'dsh-v0.1.2-rc.1', draft: false, prerelease: true, name: 'v0.1.2-rc.1' },
  ]
  const cat = openKernelCatalog(dir, {
    pinVersion: '0.1.1-rc.2',
    fetchReleases: async () => releases,
    fetchNpmVersions: async () => ['0.1.2-rc.1', '0.1.2-alpha.5'],
  })
  const view = await cat.adminView()
  assert.deepEqual(
    view.discover.map((d) => [d.version, d.onNpm]),
    [
      ['0.1.3-alpha.1', false],
      ['0.1.2-rc.1', true],
    ],
  )
  assert.equal(view.discoverError, null)

  const broken = openKernelCatalog(dir, {
    pinVersion: '0.1.1-rc.2',
    fetchReleases: async () => releases,
    fetchNpmVersions: async () => {
      throw new Error('npm down')
    },
  })
  const unk = await broken.adminView()
  assert.equal(unk.discoverError, null)
  assert.ok(unk.discover.length >= 1)
  assert.equal(
    unk.discover.every((d) => d.onNpm === null),
    true,
  )
})
