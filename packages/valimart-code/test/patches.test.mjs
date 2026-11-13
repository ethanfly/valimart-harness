/**
 * 锚点补丁的规矩：每条锚点恰好命中一次才套用；重跑幂等；文件缺失 / 命中多次硬失败。
 * 用假源码树跑（每个补丁的目标文件里只放它的 from 片段），不依赖网络与 Qwen Code 真源码——
 * 真源码的锚点由 scripts/build.mjs 在构建时验证（对不上就硬失败）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { applyPatches, PATCHES, QwenPatchError } from '../scripts/patches.mjs'

function fakeTree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valimart-patches-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const patch of PATCHES) {
    const file = path.join(dir, patch.file)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${patch.edits.map((e) => e.from).join('\n')}\n`)
  }
  return dir
}

test('锚点各命中一次：全部套用；重跑只跳过且内容不变', (t) => {
  const dir = fakeTree(t)
  const first = applyPatches(dir)
  assert.equal(first.applied.length, PATCHES.length)
  const snapshot = new Map(PATCHES.map((p) => [p.file, fs.readFileSync(path.join(dir, p.file), 'utf8')]))

  const second = applyPatches(dir)
  assert.deepEqual(second.applied, [])
  assert.equal(second.skipped.length, PATCHES.length)
  for (const [file, text] of snapshot) assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), text)
})

test('目标文件缺失：硬失败并点名补丁', (t) => {
  const dir = fakeTree(t)
  fs.rmSync(path.join(dir, PATCHES[0].file))
  assert.throws(
    () => applyPatches(dir),
    (err) => err instanceof QwenPatchError && err.code === 'file-missing' && err.detail.startsWith(`${PATCHES[0].file}|`),
  )
})

test('锚点对不上（升了上游版本）：硬失败', (t) => {
  const dir = fakeTree(t)
  fs.writeFileSync(path.join(dir, PATCHES[0].file), 'nothing matches\n')
  assert.throws(
    () => applyPatches(dir),
    (err) => err instanceof QwenPatchError && err.code === 'anchor-not-unique',
  )
})

test('同一锚点出现两次：拒绝，不猜改哪一处', (t) => {
  const dir = fakeTree(t)
  const patch = PATCHES[0]
  fs.appendFileSync(path.join(dir, patch.file), `${patch.edits[0].from}\n`)
  assert.throws(
    () => applyPatches(dir),
    (err) => err instanceof QwenPatchError && err.code === 'anchor-not-unique' && err.detail.includes(patch.edits[0].name),
  )
})
