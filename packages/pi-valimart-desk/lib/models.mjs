/**
 * 把公司网关目录映射成 pi registerProvider 的 models。
 * 生图 / 视频不进聊天 provider；单价按人记账在网关，pi 侧 cost 全 0，避免当成美元。
 */

const GEN_ONLY =
  /imagine-image|imagine-video|dall-e|gpt-image|flux|qwen-image|image-generation|video-generation|text-to-video/i

export function isChatModel(id) {
  const s = String(id ?? '')
  return Boolean(s) && !GEN_ONLY.test(s)
}

export function inferModelInput(id) {
  const s = String(id ?? '')
  if (!s || GEN_ONLY.test(s) || /^mock[-_]?/i.test(s)) return ['text']
  return ['text', 'image']
}

function thinkingLevelMap(efforts) {
  if (!efforts || typeof efforts !== 'object') return undefined
  return {
    minimal: efforts.minimal ?? efforts.off ?? null,
    low: efforts.low ?? null,
    medium: efforts.medium ?? null,
    high: efforts.high ?? null,
    xhigh: efforts.xhigh ?? null,
    max: efforts.max ?? null,
  }
}

export function toPiModels(catalog = [], { baseUrl } = {}) {
  const out = []
  for (const raw of catalog) {
    const id = String(raw?.id ?? '').trim()
    if (!isChatModel(id)) continue
    const efforts = raw.reasoningEfforts
    const reasoning = Boolean(efforts && typeof efforts === 'object' && Object.values(efforts).some((v) => v != null && v !== false))
    const model = {
      id,
      name: String(raw.name ?? raw.display_name ?? id),
      reasoning,
      input: Array.isArray(raw.input) && raw.input.length ? raw.input.filter((x) => x === 'text' || x === 'image') : inferModelInput(id),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: Number(raw.contextWindow) > 0 ? Number(raw.contextWindow) : 128000,
      maxTokens: Number(raw.maxTokens) > 0 ? Number(raw.maxTokens) : 8192,
      compat: { supportsDeveloperRole: false, ...(reasoning ? { supportsReasoningEffort: true } : {}) },
    }
    if (reasoning) {
      const map = thinkingLevelMap(efforts)
      if (map) model.thinkingLevelMap = map
    }
    if (baseUrl) model.baseUrl = baseUrl
    if (!model.input.includes('text')) model.input = ['text', ...model.input]
    out.push(model)
  }
  return out
}

export function v1BaseUrl(gatewayUrl) {
  return `${String(gatewayUrl ?? '').replace(/\/+$/, '')}/v1`
}
