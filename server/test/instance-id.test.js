/**
 * 网关实例 id：落在 dataDir，重启保持不变。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadInstanceId } from '../src/instance-id.js'

test('loadInstanceId：同一目录两次调用得到同一个 id，并写盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-instance-'))
  try {
    const a = loadInstanceId(dir)
    const b = loadInstanceId(dir)
    assert.equal(typeof a, 'string')
    assert.ok(a.length >= 8)
    assert.equal(a, b)
    assert.equal(fs.readFileSync(path.join(dir, 'instance-id'), 'utf8').trim(), a)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('loadInstanceId：两个目录互不相同', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-instance-a-'))
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-instance-b-'))
  try {
    assert.notEqual(loadInstanceId(a), loadInstanceId(b))
  } finally {
    fs.rmSync(a, { recursive: true, force: true })
    fs.rmSync(b, { recursive: true, force: true })
  }
})
