/**
 * 搜索密钥（AnySearch）随登录从网关同步到本机凭据：写入 / 跳过 / 移除 / 容错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ANYSEARCH_KEY_REF, syncSearchCredentials } from '../../plugins/desk-host/lib/search-key.js'

/** 内核的 credentialRef 是 brand 函数；这里用等价的可比较标记。 */
const credentialRef = (name) => `ref:${name}`
const REF = credentialRef(ANYSEARCH_KEY_REF)

function fakeCredentials(initial = null) {
  const store = { value: initial, sets: 0, unsets: 0 }
  return {
    store,
    async resolve(ref) {
      assert.equal(ref, REF)
      return store.value === null ? undefined : { value: store.value }
    },
    async set(ref, value) {
      assert.equal(ref, REF)
      store.sets += 1
      store.value = value
    },
    async unset(ref) {
      assert.equal(ref, REF)
      store.unsets += 1
      store.value = null
    },
  }
}

const gatewayWith = (apiKey) => ({
  get: async (p) => {
    assert.equal(p, '/api/search/anysearch')
    return { anysearch: apiKey ? { apiKey } : null }
  },
})

test('syncSearchCredentials：网关配了 key、本机为空 → 写入并标记已配置', async () => {
  const credentials = fakeCredentials(null)
  const r = await syncSearchCredentials({ gateway: gatewayWith('as_sk_new'), credentials, credentialRef })
  assert.deepEqual(r, { action: 'set', detail: 'company', configured: true })
  assert.equal(credentials.store.value, 'as_sk_new')
})

test('syncSearchCredentials：本机已是同一把 key → 跳过，不重复写', async () => {
  const credentials = fakeCredentials('as_sk_same')
  const r = await syncSearchCredentials({ gateway: gatewayWith('as_sk_same'), credentials, credentialRef })
  assert.deepEqual(r, { action: 'skip', detail: 'unchanged', configured: true })
  assert.equal(credentials.store.sets, 0)
})

test('syncSearchCredentials：网关换 key → 覆盖本机旧值', async () => {
  const credentials = fakeCredentials('as_sk_old')
  const r = await syncSearchCredentials({ gateway: gatewayWith('as_sk_new'), credentials, credentialRef })
  assert.equal(r.action, 'set')
  assert.equal(credentials.store.value, 'as_sk_new')
})

test('syncSearchCredentials：网关没配 → 移除本机 key，回到匿名额度', async () => {
  const credentials = fakeCredentials('as_sk_old')
  const r = await syncSearchCredentials({ gateway: gatewayWith(null), credentials, credentialRef })
  assert.deepEqual(r, { action: 'unset', detail: 'anonymous', configured: false })
  assert.equal(credentials.store.value, null)
  assert.equal(credentials.store.unsets, 1)
})

test('syncSearchCredentials：两边都没有 → 跳过且保持匿名', async () => {
  const credentials = fakeCredentials(null)
  const r = await syncSearchCredentials({ gateway: gatewayWith(null), credentials, credentialRef })
  assert.deepEqual(r, { action: 'skip', detail: 'anonymous', configured: false })
})

test('syncSearchCredentials：网关读取失败 → 保持本机现状（不给 configured，别把状态改坏）', async () => {
  const credentials = fakeCredentials('as_sk_old')
  const gateway = { get: async () => { throw new Error('网关返回 404') } }
  const r = await syncSearchCredentials({ gateway, credentials, credentialRef })
  assert.deepEqual(r, { action: 'error', detail: 'gateway' })
  assert.equal(credentials.store.value, 'as_sk_old')
})

test('syncSearchCredentials：写入被只读来源遮蔽 → 只报错，不动本机', async () => {
  const credentials = fakeCredentials(null)
  credentials.set = async () => { throw new Error('read-only source shadows this ref') }
  const r = await syncSearchCredentials({ gateway: gatewayWith('as_sk_new'), credentials, credentialRef })
  assert.deepEqual(r, { action: 'error', detail: 'shadowed', configured: false })
  assert.equal(credentials.store.value, null)
})
