/**
 * Mixed 模型 resolver 单元测试（T02）：重复 modelId、清洗后 provider 碰撞、
 * 能力声明/探针、目录刷新后明确失效、reasoningEffort 校验。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelCatalog } from '../src/config.js'
import {
  normalizeModelId,
  normalizeProvider,
  roleCapabilities,
  catalogRevision,
  buildCatalogIndex,
  createModelResolver,
  routeStillValid,
  ResolverError,
} from '../src/model-resolver.js'

const catalog = [
  { id: 'deepseek-v4-pro', name: 'DeepSeek Pro', provider: 'deepseek', contextWindow: 1_000_000, maxTokens: 384_000, reasoningEfforts: { off: null, high: 'high', max: 'max' }, input: ['text'] },
  { id: 'deepseek-v4-flash', provider: 'deepseek', contextWindow: 1_000_000, maxTokens: 384_000, reasoningEfforts: { off: null, high: 'high', max: 'max' }, input: ['text'] },
  { id: 'grok-4.6', provider: 'grok', contextWindow: 256_000, maxTokens: 32_000, reasoningEfforts: ['low', 'high'], input: ['text', 'image'] },
]

test('规范化：modelId trim + 折叠空白保大小写；provider 小写 trim', () => {
  assert.equal(normalizeModelId('  Grok-   4.6 '), 'Grok- 4.6')
  assert.equal(normalizeModelId('GROK-4.6'), 'GROK-4.6')
  assert.equal(normalizeProvider(' DeepSeek '), 'deepseek')
})

test('resolve：返回 ResolvedRoute（runtimeModelId + capabilitiesRevision + 角色能力）', () => {
  const r = createModelResolver({ catalog })
  const route = r.resolve({ catalogProvider: 'deepseek', modelId: 'deepseek-v4-pro' })
  assert.equal(route.runtimeModelId, 'deepseek-v4-pro')
  assert.equal(route.catalogProvider, 'deepseek')
  assert.equal(route.modelId, 'deepseek-v4-pro')
  assert.ok(route.capabilitiesRevision.startsWith('rev-'))
  assert.deepEqual(route.capabilities, { planner: true, executor: true, reviewer: true })
})

test('resolve：大小写/空白不敏感地命中同一模型', () => {
  const r = createModelResolver({ catalog })
  const a = r.resolve({ catalogProvider: 'DEEPSEEK', modelId: ' deepseek-v4-pro ' })
  assert.equal(a.runtimeModelId, 'deepseek-v4-pro')
})

test('重复 modelId（两个上游同 id）→ 冲突清单 + resolve 显式拒绝 model_ambiguous', () => {
  const dup = [
    ...catalog,
    { id: 'deepseek-v4-pro', provider: 'mirror', contextWindow: 1_000_000, maxTokens: 384_000, input: ['text'] },
  ]
  const r = createModelResolver({ catalog: dup })
  assert.ok(r.conflicts.some((c) => c.kind === 'duplicate-modelId' && c.models.includes('deepseek-v4-pro')))
  assert.throws(
    () => r.resolve({ catalogProvider: 'deepseek', modelId: 'deepseek-v4-pro' }),
    (e) => e instanceof ResolverError && e.code === 'model_ambiguous',
  )
})

test('清洗后 provider 碰撞（DeepSeek 与 deepseek 两种写法）→ 该 provider 下全部模型不可解析', () => {
  const clash = [
    { id: 'm-1', provider: 'DeepSeek', input: ['text'] },
    { id: 'm-2', provider: 'deepseek', input: ['text'] },
  ]
  const r = createModelResolver({ catalog: clash })
  assert.ok(r.conflicts.some((c) => c.kind === 'provider-collision' && c.providers.includes('DeepSeek') && c.providers.includes('deepseek')))
  assert.throws(() => r.resolve({ catalogProvider: 'DeepSeek', modelId: 'm-1' }), (e) => e.code === 'provider_collision')
  assert.throws(() => r.resolve({ catalogProvider: 'deepseek', modelId: 'm-2' }), (e) => e.code === 'provider_collision')
})

test('模型下架 → model_not_found；capabilitiesRevision 变化 → 旧路由明确失效', () => {
  const before = createModelResolver({ catalog })
  const saved = before.resolve({ catalogProvider: 'grok', modelId: 'grok-4.6' })
  assert.ok(routeStillValid(saved, before))
  const after = createModelResolver({ catalog: catalog.filter((m) => m.id !== 'grok-4.6') })
  assert.notEqual(after.capabilitiesRevision, before.capabilitiesRevision)
  assert.throws(() => after.resolve(saved), (e) => e.code === 'model_not_found')
  assert.equal(routeStillValid(saved, after), false)
})

test('能力修订号只随目录内容/能力变化：同内容两次构建稳定，与条目顺序无关', () => {
  assert.equal(catalogRevision(catalog), catalogRevision(catalog))
  assert.equal(catalogRevision(catalog), catalogRevision([...catalog].reverse()))
  const changed = catalog.map((m) => (m.id === 'grok-4.6' ? { ...m, mixedRoles: { executor: false } } : m))
  assert.notEqual(catalogRevision(changed), catalogRevision(catalog))
})

test('角色能力：声明（mixedRoles）覆盖启发式；启发式保守（未知上下文不自动认定 planner）', () => {
  assert.deepEqual(roleCapabilities({ input: ['text'], mixedRoles: { planner: false, executor: true, reviewer: false } }), { planner: false, executor: true, reviewer: false })
  // 只有文本、上下文未知 → 不自动认定 planner 能力（不能凭名字/缺省认定）
  assert.deepEqual(roleCapabilities({ input: ['text'] }), { planner: false, executor: true, reviewer: true })
  // 已知大上下文 → planner 可用
  assert.equal(roleCapabilities({ input: ['text'], contextWindow: 200_000 }).planner, true)
  // 视觉输入 → planner 可用
  assert.equal(roleCapabilities({ input: ['text', 'image'] }).planner, true)
  // 显式禁用工具 → executor 不可用
  assert.equal(roleCapabilities({ input: ['text'], tools: false }).executor, false)
})

test('reasoningEffort：不支持的档位显式拒绝；支持的档位写进 ResolvedRoute', () => {
  const r = createModelResolver({ catalog })
  const ok = r.resolve({ catalogProvider: 'deepseek', modelId: 'deepseek-v4-pro', reasoningEffort: 'high' })
  assert.equal(ok.reasoningEffort, 'high')
  assert.throws(() => r.resolve({ catalogProvider: 'deepseek', modelId: 'deepseek-v4-pro', reasoningEffort: 'ultra' }), (e) => e.code === 'effort_unsupported')
})

test('buildCatalogIndex：空 catalog 可用，capabilitiesRevision 稳定', () => {
  const r = createModelResolver({ catalog: [] })
  assert.equal(r.index.size, 0)
  assert.ok(r.capabilitiesRevision.startsWith('rev-'))
})

test('mock 上游默认 mixedRoles 三角色都开（离线演示可配 Mixed）', () => {
  const cat = modelCatalog({
    upstreams: { mock: { id: 'mock', kind: 'mock', label: 'Mock', models: [{ id: 'mock-echo', name: 'Echo', contextWindow: 32768 }] } },
  })
  assert.deepEqual(cat[0].mixedRoles, { planner: true, executor: true, reviewer: true })
  assert.deepEqual(roleCapabilities(cat[0]), { planner: true, executor: true, reviewer: true })
})
