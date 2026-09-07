/**
 * DriveMirror：墓碑用 Set 存储；pushPersonal / pull / sync 必须串行，否则双写 index/tomb。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DriveMirror } from '../../plugins/desk-host/lib/drive-mirror.js'

function makeMirror({ root, gateway, username = 'alice' }) {
  return new DriveMirror({
    root,
    gateway,
    state: { data: { user: { username } }, save() {} },
    log: () => {},
  })
}

test('pushPersonal：墓碑是 Set 时跳过已删文件，且不调用 includes 崩溃', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-mirror-tomb-'))
  const rel = '_office/alice/_memory/old.txt'
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), 'should not be pushed')
  const puts = []
  const mirror = makeMirror({
    root,
    gateway: {
      put: async (url) => {
        puts.push(url)
      },
    },
  })
  assert.ok(mirror.tomb instanceof Set)
  mirror.tomb.add(rel)
  await assert.doesNotReject(() => mirror.pushPersonal())
  assert.equal(puts.length, 0)
  fs.rmSync(root, { recursive: true, force: true })
})

test('pushPersonal：非墓碑的本地新文件会回推', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-mirror-push-'))
  const rel = '_office/alice/_memory/note.txt'
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), 'hello')
  const puts = []
  const mirror = makeMirror({
    root,
    gateway: {
      put: async (url, buf) => {
        puts.push({ url, bytes: buf.length })
      },
    },
  })
  const r = await mirror.pushPersonal()
  assert.equal(r.pushed, 1)
  assert.equal(puts.length, 1)
  assert.match(puts[0].url, /note\.txt/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('sync 的 pushPersonal 未结束时，后到的 pull 必须排队', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-mirror-lock-'))
  const rel = '_office/alice/_memory/note.txt'
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), 'hello')
  const events = []
  let releasePut
  const putGate = new Promise((resolve) => {
    releasePut = resolve
  })
  const mirror = makeMirror({
    root,
    gateway: {
      put: async () => {
        events.push('put-start')
        await putGate
        events.push('put-end')
      },
      get: async (url) => {
        if (String(url).includes('/api/drive/snapshot')) {
          events.push('snapshot')
          return { files: [], memoryLayers: [] }
        }
        return Buffer.from('')
      },
    },
  })
  const syncP = mirror.sync()
  const started = Date.now()
  while (!events.includes('put-start')) {
    if (Date.now() - started > 2000) {
      const err = await syncP.catch((e) => e)
      assert.fail(`pushPersonal 未开始回推：${err?.message ?? events.join(',')}`)
    }
    await new Promise((r) => setTimeout(r, 5))
  }
  const pullP = mirror.pull()
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(!events.includes('snapshot'), 'pull 不得在 pushPersonal 进行中抢跑')
  releasePut()
  await Promise.all([syncP, pullP])
  assert.ok(events.includes('put-end'))
  assert.ok(events.includes('snapshot'))
  const snapAt = events.indexOf('snapshot')
  assert.ok(snapAt > events.indexOf('put-end'), '首次 snapshot 必须排在 put 之后')
  fs.rmSync(root, { recursive: true, force: true })
})
