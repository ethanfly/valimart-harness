/**
 * Company catalog model + 思考强度 helpers.
 * reasoningEfforts may be an array ['low','high'] or a map { off: null, high: 'high' }.
 */
export function catalogModels(company) {
  return Array.isArray(company?.models) ? company.models : []
}

export function catalogModelId(company) {
  const models = catalogModels(company)
  const def = company?.defaultModel
  if (def && models.some((m) => m.id === def)) return def
  if (models[0]?.id) return models[0].id
  throw new Error('公司目录里没有可用模型')
}

export function findCatalogModel(company, id) {
  return catalogModels(company).find((m) => m.id === id) ?? null
}

export function listEfforts(model) {
  const raw = model?.reasoningEfforts
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String).filter((x) => x && x !== 'false')
  if (typeof raw === 'object') return Object.keys(raw)
  if (typeof raw === 'string') return raw.split(/[,\s/]+/).filter(Boolean)
  return []
}

export function resolveSelection(company, { modelId, effort } = {}) {
  const models = catalogModels(company)
  const model = (modelId && findCatalogModel(company, modelId)) || findCatalogModel(company, catalogModelId(company))
  if (!model) throw new Error('公司目录里没有可用模型')
  const efforts = listEfforts(model)
  let nextEffort = effort ?? null
  if (nextEffort && efforts.length && !efforts.includes(String(nextEffort))) {
    nextEffort = efforts[0] ?? null
  }
  if (!efforts.length) nextEffort = nextEffort ?? null
  return { model, modelId: model.id, effort: nextEffort, efforts }
}
