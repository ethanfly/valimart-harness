/**
 * 锚点补丁的四条规矩：每条锚点恰好命中一次才套用；重跑幂等；locate 对不上或多处命中硬失败。
 * 用假包跑，不依赖网络与 Qwen Code 真包（真包由 scripts/build.mjs 验证）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { applyPatches, PATCHES, QwenPatchError } from '../scripts/patches.mjs'

const BUNDLE = path.join('chunks', 'bundle.js')

/** 每个锚点（locate 与各 edit 的 from）各写一次进假 bundle；返回包目录。 */
function fakePackage(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valimart-patches-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'chunks'))
  const snippets = new Set()
  for (const patch of PATCHES) {
    snippets.add(patch.locate)
    for (const edit of patch.edits) snippets.add(edit.from)
  }
  fs.writeFileSync(path.join(dir, BUNDLE), [...snippets].join('\n'))
  return dir
}

test('锚点各命中一次：全部套用；重跑只跳过且内容不变', (t) => {
  const dir = fakePackage(t)
  const first = applyPatches(dir)
  assert.equal(first.applied.length, PATCHES.length)
  const patched = fs.readFileSync(path.join(dir, BUNDLE), 'utf8')
  assert.match(patched, /You are Valimart Code/)

  const second = applyPatches(dir)
  assert.deepEqual(second.applied, [])
  assert.equal(second.skipped.length, PATCHES.length)
  assert.equal(fs.readFileSync(path.join(dir, BUNDLE), 'utf8'), patched)
})

test('locate 对不上：硬失败并点名是哪条补丁', (t) => {
  const dir = fakePackage(t)
  fs.writeFileSync(path.join(dir, BUNDLE), 'nothing matches')
  assert.throws(
    () => applyPatches(dir),
    (err) => err instanceof QwenPatchError && err.code === 'locate-not-unique' && err.detail.startsWith(`${PATCHES[0].mark}|`),
  )
})

test('locate 在两个文件里都出现：拒绝，不猜该改哪个', (t) => {
  const dir = fakePackage(t)
  fs.writeFileSync(path.join(dir, 'cli.js'), PATCHES[1].locate)
  assert.throws(
    () => applyPatches(dir),
    (err) => err instanceof QwenPatchError && err.code === 'locate-not-unique',
  )
})

test('edit 的 from 在文件里出现两次：拒绝', (t) => {
  const dir = fakePackage(t)
  fs.appendFileSync(path.join(dir, BUNDLE), `\n${PATCHES[1].edits[0].from}`)
  assert.throws(
    () => applyPatches(dir),
    (err) => err instanceof QwenPatchError && err.code === 'anchor-not-unique',
  )
})
