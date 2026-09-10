/**
 * Mixed 模型 resolver（T02）。
 *
 * 职责（计划 T02「唯一 model resolver」）：
 * - 规范化后校验目录唯一性：重复 modelId、清洗后 provider 碰撞 → 显式冲突清单，不静默挑第一个。
 * - (catalogProvider, modelId) → ResolvedRoute：runtimeModelId（/v1 线上传的模型 id，单一权威）+ capabilitiesRevision。
 * - 角色能力声明（planner/executor/reviewer）：模型配置 mixedRoles 声明 + 探针结果覆盖；
 *   capabilitiesRevision 变化（目录刷新/模型下架/能力变更）即旧 ResolvedRoute 明确失效。
 *
 * 纯模块：不碰 db/网络，网关与测试共用。
 */
import crypto from 'node:crypto'

/** modelId 规范化：去首尾空白、折叠内部空白（大小写保留——模型 id 区分大小写）。 */
export function normalizeModelId(id) {
  return String(id ?? '').replace(/\s+/g, ' ').trim()
}

/** provider 规范化：trim + 小写（provider 不区分大小写）。 */
export function normalizeProvider(provider) {
  return String(provider ?? '').trim().toLowerCase()
}

/**
 * 角色能力三值：mixedRoles 声明/探针结果优先于启发式。
 * 启发式刻意保守（计划：「不能凭模型名字自动认定能力」）：
 * - planner：需要已知大上下文（≥128k）或视觉输入；未知 → false，由用户显式保存后使用。
 * - executor：未显式禁用工具即视为可执行。
 * - reviewer：审核不依赖特殊能力 → 默认 true。
 */
export function roleCapabilities(model) {
  const declared = model?.mixedRoles && typeof model.mixedRoles === 'object' ? model.mixedRoles : {}
  const input = Array.isArray(model?.input) ? model.input.join(',') : ''
  const hasImages = input.includes('image')
  const hasTools = model?.tools !== false
  const bigContext = typeof model?.contextWindow === 'number' && model.contextWindow >= 128_000
  const planner = declared.planner ?? (hasImages || bigContext)
  const executor = declared.executor ?? hasTools
  const reviewer = declared.reviewer ?? true
  return { planner: !!planner, executor: !!executor, reviewer: !!reviewer }
}

/**
 * 目录索引：唯一性校验 + 能力修订号。
 * @param catalog modelCatalog(cfg) 的扁平日志
 * @returns {
 *   byKey: Map<'provider\u0000modelId', entry>,   // 规范化键 → 条目（冲突键不在其中）
 *   conflicts: [{ kind:'duplicate-modelId'|'provider-collision', key, providers, models }],
 *   capabilitiesRevision: string,                 // 目录内容+能力的稳定指纹
 * }
 */
export function buildCatalogIndex(catalog) {
  const conflicts = []
  const seen = new Map() // 规范化键 'provider\u0000modelId' → [entry...]
  const providersSeen = new Map() // 规范化 provider → 原样 provider 集合
  const modelIdsSeen = new Map() // 规范化 modelId → 规范化 provider 集合（/v1 线上传的是裸 modelId，跨上游重复即歧义）
  for (const m of catalog ?? []) {
    const modelId = normalizeModelId(m?.id)
    const provider = normalizeProvider(m?.provider)
    if (!modelId || !provider) continue
    const key = `${provider}\u0000${modelId}`
    if (!seen.has(key)) seen.set(key, [])
    seen.get(key).push({ modelId, provider, entry: m })
    if (!providersSeen.has(provider)) providersSeen.set(provider, new Set())
    providersSeen.get(provider).add(String(m.provider ?? ''))
    if (!modelIdsSeen.has(modelId)) modelIdsSeen.set(modelId, new Set())
    modelIdsSeen.get(modelId).add(provider)
  }
  // 跨上游重复 modelId：/v1 线上传的是裸 modelId，两个上游同 id 即歧义 —— 该 id 全部拒绝
  const duplicateModelIds = new Set(
    [...modelIdsSeen.entries()].filter(([, providers]) => providers.size > 1).map(([id]) => id),
  )
  for (const [modelId, providers] of [...modelIdsSeen.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (providers.size > 1) {
      conflicts.push({
        kind: 'duplicate-modelId',
        key: modelId,
        providers: [...providers].sort(),
        models: [modelId],
      })
    }
  }
  // 清洗后 provider 碰撞：不同原样 provider 归一到同一规范化值（如 'DeepSeek' 与 'deepseek'）—— 全部拒绝
  const collidingProviders = new Set()
  for (const [provider, originals] of providersSeen) {
    if (originals.size > 1) {
      collidingProviders.add(provider)
      const models = [...seen.keys()]
        .filter((k) => k.startsWith(`${provider}\u0000`))
        .map((k) => k.slice(provider.length + 1))
      conflicts.push({ kind: 'provider-collision', key: provider, providers: [...originals].sort(), models })
    }
  }
  const byKey = new Map()
  for (const [key, hits] of seen) {
    const provider = key.slice(0, key.indexOf('\u0000'))
    const modelId = key.slice(provider.length + 1)
    if (collidingProviders.has(provider)) continue // 碰撞 provider 下的模型一律不进入唯一索引
    if (duplicateModelIds.has(modelId)) continue // 跨上游重复 modelId 不进入唯一索引：resolve 显式报 model_ambiguous
    if (hits.length > 1) {
      conflicts.push({
        kind: 'duplicate-modelId',
        key: modelId,
        providers: [...new Set(hits.map((h) => h.provider))],
        models: hits.map((h) => h.modelId),
      })
      continue // 同上游重复 modelId 同样拒绝
    }
    byKey.set(key, hits[0].entry)
  }
  return {
    byKey,
    conflicts,
    capabilitiesRevision: catalogRevision(catalog),
  }
}

/** 目录内容+能力的稳定指纹：排序后 sha256。目录变化（增删改/能力变更）→ 指纹变化 → 旧路由失效。 */
export function catalogRevision(catalog) {
  const rows = (catalog ?? [])
    .map((m) => {
      const modelId = normalizeModelId(m?.id)
      const provider = normalizeProvider(m?.provider)
      const caps = roleCapabilities(m)
      const efforts = JSON.stringify(normalizeEfforts(m?.reasoningEfforts))
      return [
        provider,
        modelId,
        String(m?.contextWindow ?? ''),
        String(m?.maxTokens ?? ''),
        JSON.stringify(Array.isArray(m?.input) ? m.input : []),
        efforts,
        caps.planner,
        caps.executor,
        caps.reviewer,
      ].join('\u0001')
    })
    .sort()
  return 'rev-' + crypto.createHash('sha256').update(rows.join('\n'), 'utf8').digest('hex').slice(0, 32)
}

/** reasoningEfforts 可能是数组或 {档位: 映射} 对象；规范化为可比较结构。 */
function normalizeEfforts(efforts) {
  if (efforts === undefined || efforts === null || efforts === false) return []
  if (Array.isArray(efforts)) return efforts
  if (typeof efforts === 'object') return Object.keys(efforts).sort()
  return []
}

/**
 * 创建 resolver。
 * @param {object} opts
 * @param {Array} opts.catalog  modelCatalog(cfg)
 * @returns {{ resolve(route): ResolvedRoute, index, conflicts, capabilitiesRevision }}
 */
export function createModelResolver({ catalog }) {
  const { byKey, conflicts, capabilitiesRevision } = buildCatalogIndex(catalog)
  const resolve = (route) => {
    const modelId = normalizeModelId(route?.modelId)
    const provider = normalizeProvider(route?.catalogProvider)
    if (!modelId) throw resolverError('bad_request', 'modelId 不能为空')
    if (!provider) throw resolverError('bad_request', 'catalogProvider 不能为空')
    const entry = byKey.get(`${provider}\u0000${modelId}`)
    if (!entry) {
      if (conflicts.some((c) => c.kind === 'duplicate-modelId' && c.key === modelId)) {
        throw resolverError('model_ambiguous', `模型 ${modelId} 在多个上游重复，目录需要去重`)
      }
      if (conflicts.some((c) => c.kind === 'provider-collision' && c.key === provider)) {
        throw resolverError('provider_collision', `上游 ${provider} 存在清洗后碰撞的 provider 写法，目录需要修正`)
      }
      throw resolverError('model_not_found', `模型 ${modelId}（provider ${provider}）不在公司目录`)
    }
    if (route?.reasoningEffort !== undefined && route.reasoningEffort !== null && route.reasoningEffort !== '') {
      const efforts = normalizeEfforts(entry.reasoningEfforts)
      if (!efforts.length || !efforts.includes(route.reasoningEffort)) {
        throw resolverError('effort_unsupported', `模型 ${modelId} 不支持推理强度 ${route.reasoningEffort}`)
      }
    }
    return {
      catalogProvider: entry.provider,
      modelId: normalizeModelId(entry.id),
      ...(route?.reasoningEffort !== undefined && route.reasoningEffort !== null && route.reasoningEffort !== ''
        ? { reasoningEffort: route.reasoningEffort }
        : {}),
      runtimeModelId: normalizeModelId(entry.id), // /v1 线上传的模型 id——唯一权威，客户端不得自行拼接
      capabilities: roleCapabilities(entry),
      capabilitiesRevision,
    }
  }
  return {
    resolve,
    index: byKey,
    conflicts,
    capabilitiesRevision,
  }
}

export class ResolverError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ResolverError'
    this.code = code
  }
}
function resolverError(code, message) {
  return new ResolverError(code, message)
}

/** 校验已保存的 ResolvedRoute 是否仍然有效（目录刷新后明确失效，不静默沿用）。 */
export function routeStillValid(saved, resolver) {
  if (!saved || typeof saved !== 'object') return false
  if (saved.capabilitiesRevision !== resolver.capabilitiesRevision) return false
  try {
    const fresh = resolver.resolve(saved)
    return fresh.runtimeModelId === saved.runtimeModelId
  } catch {
    return false
  }
}
