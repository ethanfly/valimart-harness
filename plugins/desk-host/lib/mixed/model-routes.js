/**
 * Mixed 宿主侧模型路由（T03，对齐网关 GET /api/mixed/catalog 与 T02 server/src/model-resolver.js）。
 *
 * 职责（计划 §6.2）：
 * - 持有从网关拉取的目录快照：capabilitiesRevision、冲突列表、gatewayInstanceId；
 * - 配置时解析角色路由（拒绝跨 provider 重复 modelId / 碰撞 → 显式冲突，不取首项）；
 * - 公司目录内模型可由用户指定给任意角色；派发前只校验是否仍在目录（下架 → 明确失效），
 *   但绝不重新解析到另一模型（run 内模型快照固定）。
 */
import { MixedError } from './contracts.js'

const ROLES = ['planner', 'executor', 'reviewer']

function modelKey(provider, modelId) {
  return `${provider}\u0000${modelId}`
}

/**
 * @param {object} opts
 * @param {() => Promise<object>} opts.fetchCatalog 返回网关 /api/mixed/catalog 的 JSON
 *        {gatewayInstanceId, capabilitiesRevision, models:[{id, provider, capabilities?, mixedRoles?, ...}], conflicts:[]}
 */
export class ModelRoutes {
  constructor({ fetchCatalog }) {
    if (typeof fetchCatalog !== 'function') throw new Error('ModelRoutes 需要 fetchCatalog()')
    this.fetchCatalog = fetchCatalog
    this.snapshot = null // {fetchedAt, gatewayInstanceId, capabilitiesRevision, byKey: Map, conflicts: [], rawModels: []}
  }

  async refresh() {
    const raw = await this.fetchCatalog()
    const byKey = new Map()
    for (const m of raw.models ?? []) {
      const key = modelKey(m.provider ?? m.catalogProvider, m.id ?? m.modelId)
      if (byKey.has(key)) continue // 网关已拒绝重复；宿主侧防御性去重
      byKey.set(key, m)
    }
    this.snapshot = {
      fetchedAt: new Date().toISOString(),
      gatewayInstanceId: raw.gatewayInstanceId ?? null,
      capabilitiesRevision: raw.capabilitiesRevision ?? null,
      conflicts: raw.conflicts ?? [],
      byKey,
      rawModels: raw.models ?? [],
    }
    return this.snapshot
  }

  requireSnapshot() {
    if (!this.snapshot) throw new MixedError('route_not_resolved', '模型目录尚未从网关同步（需先登录）')
    return this.snapshot
  }

  conflicts() {
    return this.requireSnapshot().conflicts
  }

  /**
   * 解析一个角色路由（配置保存时调用）。
   * @param {'planner'|'executor'|'reviewer'} role
   * @param {{catalogProvider, modelId, reasoningEffort?}} route
   */
  resolveRole(role, route) {
    const snap = this.requireSnapshot()
    if (!ROLES.includes(role)) throw new MixedError('route_unavailable', `未知角色 ${role}`)
    const key = modelKey(route.catalogProvider, route.modelId)
    const conflict = snap.conflicts.find((c) => (c.key ?? c.modelId) === route.modelId)
    if (conflict) {
      throw new MixedError(
        conflict.kind === 'provider-collision' ? 'route_unavailable' : 'route_unavailable',
        `模型 ${route.modelId} 在目录中存在 ${conflict.kind === 'provider-collision' ? 'provider 碰撞' : '跨厂商重名'}，已被禁用`,
      )
    }
    const m = snap.byKey.get(key)
    if (!m) {
      const sameName = snap.rawModels.filter((x) => (x.id ?? x.modelId) === route.modelId)
      if (sameName.length) throw new MixedError('route_unavailable', `模型 ${route.modelId} 不存在于 provider ${route.catalogProvider}（目录中有: ${sameName.map((x) => x.provider ?? x.catalogProvider).join(', ')}）`)
      throw new MixedError('route_unavailable', `模型 ${route.catalogProvider}/${route.modelId} 不在公司目录（可能已下架）`)
    }
    const caps = roleCapabilitiesOf(m)
    return {
      catalogProvider: route.catalogProvider,
      modelId: route.modelId,
      ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
      runtimeModelId: m.id ?? m.modelId,
      // 用户从公司目录显式点选即生效；启发式/mixedRoles 只作快照标注，不拦保存。
      capabilities: { ...caps, [role]: true },
      capabilitiesRevision: snap.capabilitiesRevision,
    }
  }

  /**
   * 校验 run 内已解析的模型快照是否仍可用（每阶段派发前调用）。
   * 返回 {ok, problems:[{role, reason}]}；ok=false 时宿主必须停止派发并提示，而不是换模型。
   */
  validateRunModels(models) {
    const snap = this.requireSnapshot()
    const problems = []
    for (const role of ROLES) {
      const saved = models?.[role]
      if (!saved) { problems.push({ role, reason: '缺少路由快照' }); continue }
      const m = snap.byKey.get(modelKey(saved.catalogProvider, saved.modelId))
      if (!m) { problems.push({ role, reason: `模型 ${saved.modelId} 已下架` }); continue }
    }
    return { ok: problems.length === 0, problems }
  }
}

/** 能力判定：优先目录显式声明（mixedRoles），否则保守推断（与网关 roleCapabilities 一致）。 */
function roleCapabilitiesOf(m) {
  if (m.mixedRoles && typeof m.mixedRoles === 'object') {
    return {
      planner: !!m.mixedRoles.planner,
      executor: !!m.mixedRoles.executor,
      reviewer: !!m.mixedRoles.reviewer,
    }
  }
  const input = Array.isArray(m.input) ? m.input : []
  const contextWindow = typeof m.contextWindow === 'number' ? m.contextWindow : null
  const tools = m.tools !== false
  return {
    planner: (contextWindow !== null && contextWindow >= 128000) || input.includes('image'),
    executor: tools,
    reviewer: true,
  }
}
