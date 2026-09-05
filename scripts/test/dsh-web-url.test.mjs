import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDshWebUrlWatcher, parseDshWebUrl, resolveDshWebUrl, sameWebOrigin } from '../lib/dsh-web-url.mjs'

test('parseDshWebUrl：从内核 stdout 抽出带 token 的地址', () => {
  assert.equal(parseDshWebUrl('unrelated'), null)
  assert.equal(parseDshWebUrl('dsh web: http://127.0.0.1:3470/?token=abc123'), 'http://127.0.0.1:3470/?token=abc123')
  assert.equal(
    parseDshWebUrl('boot\ndsh web: http://127.0.0.1:3470/?token=abc.\nready'),
    'http://127.0.0.1:3470/?token=abc',
  )
  assert.equal(parseDshWebUrl('dsh web: file:///tmp/x'), null)
})

test('sameWebOrigin：token URL 与 303 后的 / 同源', () => {
  assert.equal(sameWebOrigin('http://127.0.0.1:3470/?token=x', 'http://127.0.0.1:3470/'), true)
  assert.equal(sameWebOrigin('http://127.0.0.1:3470/', 'https://example.com/'), false)
})

test('createDshWebUrlWatcher：跨 chunk 拼出地址后只取第一次', async () => {
  const w = createDshWebUrlWatcher()
  w.feed('starting ')
  const pending = w.wait(2000)
  w.feed('dsh web: http://127.0.0.1:3470/?token=one\n')
  w.feed('dsh web: http://127.0.0.1:3470/?token=two\n')
  assert.equal(await pending, 'http://127.0.0.1:3470/?token=one')
  assert.equal(w.get(), 'http://127.0.0.1:3470/?token=one')
})

test('createDshWebUrlWatcher：先锁住无 token 的地址，后到的 token 要升级', () => {
  const w = createDshWebUrlWatcher()
  w.feed('dsh web: http://127.0.0.1:3470')
  assert.equal(w.get(), 'http://127.0.0.1:3470/')
  w.feed('/?token=late\n')
  assert.equal(w.get(), 'http://127.0.0.1:3470/?token=late')
})

test('resolveDshWebUrl：printed 无 token 且 401 不能当就绪', async () => {
  let printed = 'http://127.0.0.1:3470/'
  let n = 0
  const fetchImpl = async () => {
    n += 1
    if (n >= 2) printed = 'http://127.0.0.1:3470/?token=upgrade'
    return { ok: false, status: 401 }
  }
  const url = await resolveDshWebUrl({
    port: 3470,
    getPrinted: () => printed,
    fetchImpl,
    timeoutMs: 2000,
    intervalMs: 10,
  })
  assert.equal(url, 'http://127.0.0.1:3470/?token=upgrade')
})

test('resolveDshWebUrl：401 不算就绪，必须等到 printed token URL', async () => {
  let probes = 0
  const fetchImpl = async (url) => {
    probes += 1
    if (String(url).includes('token=')) return { ok: true, status: 200 }
    return { ok: false, status: 401 }
  }
  const url = await resolveDshWebUrl({
    port: 3470,
    getPrinted: () => (probes >= 1 ? 'http://127.0.0.1:3470/?token=launch' : null),
    fetchImpl,
    timeoutMs: 2000,
    intervalMs: 10,
  })
  assert.equal(url, 'http://127.0.0.1:3470/?token=launch')
})

test('resolveDshWebUrl：旧内核打出无 token 的 dsh web 行后用它', async () => {
  const url = await resolveDshWebUrl({
    port: 3470,
    getPrinted: () => 'http://127.0.0.1:3470/',
    fetchImpl: async () => ({ ok: true, status: 200 }),
    timeoutMs: 500,
    intervalMs: 10,
  })
  assert.equal(url, 'http://127.0.0.1:3470/')
})

test('resolveDshWebUrl：HTTP 先 404/200 不能当就绪，必须等 dsh web 行', async () => {
  let printed = null
  let n = 0
  const url = await resolveDshWebUrl({
    port: 3470,
    getPrinted: () => printed,
    fetchImpl: async () => {
      n += 1
      if (n >= 2) printed = 'http://127.0.0.1:3470/?token=after-listen'
      return { ok: false, status: 404 }
    },
    timeoutMs: 2000,
    intervalMs: 10,
  })
  assert.equal(url, 'http://127.0.0.1:3470/?token=after-listen')
})

test('resolveDshWebUrl：探测裸地址期间才打出 token，不能退回裸 /', async () => {
  let printed = null
  const fetchImpl = async (url) => {
    if (String(url).includes('token=')) return { ok: false, status: 303 }
    await new Promise((r) => setTimeout(r, 20))
    printed = 'http://127.0.0.1:3470/?token=late'
    return { ok: true, status: 200 }
  }
  const url = await resolveDshWebUrl({
    port: 3470,
    getPrinted: () => printed,
    fetchImpl,
    timeoutMs: 2000,
    intervalMs: 10,
  })
  assert.equal(url, 'http://127.0.0.1:3470/?token=late')
})

test('resolveDshWebUrl：一直 401 且没有 printed URL 则失败', async () => {
  await assert.rejects(
    () =>
      resolveDshWebUrl({
        port: 3470,
        getPrinted: () => null,
        fetchImpl: async () => ({ ok: false, status: 401 }),
        timeoutMs: 80,
        intervalMs: 20,
      }),
    /登录令牌/,
  )
})
