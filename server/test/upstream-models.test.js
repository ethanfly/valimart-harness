import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  discoverUpstreamModels,
  fallbackModelsFor,
  inferModelMeta,
  mergeDiscoveredModels,
  modelsListUrl,
  normalizeDiscoveredModel,
} from '../src/upstream-models.js'
import { isUpstreamQuotaExhausted } from '../src/upstream-quota.js'

test('inferModelMeta：按 id 自动补上下文与思考强度', () => {
  const gpt = inferModelMeta('gpt-5.5')
  assert.equal(gpt.contextWindow, 256_000)
  assert.deepEqual(gpt.reasoningEfforts, ['low', 'medium', 'high'])
  const ds = inferModelMeta('deepseek-v4-pro')
  assert.equal(ds.contextWindow, 1_000_000)
  assert.ok(ds.reasoningEfforts.high)
})

test('modelsListUrl / normalizeDiscoveredModel', () => {
  assert.equal(modelsListUrl('https://api.x.ai/v1'), 'https://api.x.ai/v1/models')
  assert.equal(modelsListUrl('https://api.x.ai/v1/'), 'https://api.x.ai/v1/models')
  const m = normalizeDiscoveredModel({ id: 'grok-4.6', display_name: 'Grok 4.6' }, { reasoningEfforts: ['low', 'high'] })
  assert.equal(m.name, 'Grok 4.6')
  assert.equal(normalizeDiscoveredModel({ id: 'grok-4.6' }).name, undefined)
  assert.equal(m.contextWindow, 256_000)
  assert.deepEqual(m.reasoningEfforts, ['low', 'high'])
})

test('discoverUpstreamModels：OpenAI 目录 + 手填合并', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ data: [{ id: 'foo-1', context_window: 99000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  const r = await discoverUpstreamModels({
    baseUrl: 'https://example.test/v1',
    credential: 'sk-x',
    fetchImpl,
  })
  assert.equal(r.source, 'upstream')
  assert.equal(r.models[0].id, 'foo-1')
  assert.equal(r.models[0].contextWindow, 99000)
  const merged = mergeDiscoveredModels([{ id: 'foo-1' }], r.models, { reasoningEfforts: ['low'] }, {})
  assert.equal(merged[0].contextWindow, 99000)
  assert.deepEqual(merged[0].reasoningEfforts, ['low'])
})

test('discoverUpstreamModels：失败回退内置目录', async () => {
  const r = await discoverUpstreamModels({
    baseUrl: 'https://api.x.ai/v1',
    credential: 'x',
    channel: { id: 'grok', hint: 'grok-4.6' },
    fetchImpl: async () => new Response('no', { status: 401 }),
  })
  assert.equal(r.source, 'fallback')
  assert.ok(r.models.some((m) => m.id === 'grok-4.6'))
  assert.ok(fallbackModelsFor({ id: 'chatgpt' }).length > 0)
})

test('isUpstreamQuotaExhausted：额度用尽才切号，普通 429 不切', () => {
  assert.equal(isUpstreamQuotaExhausted(402, ''), true)
  assert.equal(isUpstreamQuotaExhausted(429, '{"error":{"code":"insufficient_quota"}}'), true)
  assert.equal(isUpstreamQuotaExhausted(429, 'too many requests'), false)
  assert.equal(isUpstreamQuotaExhausted(400, 'bad request'), false)
})
