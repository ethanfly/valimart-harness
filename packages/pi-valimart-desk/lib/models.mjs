/**
 * 把公司网关目录映射成 pi registerProvider 的 models。
 * 生图 / 视频不进聊天 provider；单价按人记账在网关，pi 侧 cost 全 0，避免当成美元。
 *
 * 思考档位：网关目录允许写成数组（['low','high']）或 {档位: 上游取值}。
 * llm-pi-ai / 桌面端要的是后者；pi 还要一份 thinkingLevelMap（缺的档位填 null 才会从 TUI 藏掉）。
 * 网关对外统一 OpenAI 兼容 + deepseek 思维链，其它厂商由网关在服务端转换——跟 desk-host 同一套 compat。
 */

const GEN_ONLY =
  /imagine-image|imagine-video|dall-e|gpt-image|flux|qwen-image|image-generation|video-generation|text-to-video/i

const PI_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 跟 plugins/desk-host 的路由 compat 对齐。 */
export const GATEWAY_COMPAT = {
  thinkingFormat: 'deepseek',
  supportsDeveloperRole: false,
  maxTokensField: 'max_tokens',
  supportsStore: false,
  requiresReasoningContentOnAssistantMessages: true,
}

export function isChatModel(id) {
  const s = String(id ?? '')
  return Boolean(s) && !GEN_ONLY.test(s)
}

export function inferModelInput(id) {
  const s = String(id ?? '')
  if (!s || GEN_ONLY.test(s) || /^mock[-_]?/i.test(s)) return ['text']
  return ['text', 'image']
}

/**
 * 网关 reasoningEfforts → { 档位: 发给上游的字符串 }。
 * 数组 ['low','high'] 变成 { low:'low', high:'high' }；对象里值为 null 的档位（常见 off:null）丢掉，不当成可发送值。
 * 没有可发送档位则返回 null（模型不支持思考）。
 */
export function normalizeReasoningEfforts(v) {
  let src = v
  if (Array.isArray(src)) {
    src = Object.fromEntries(src.filter((e) => typeof e === 'string' && e.trim()).map((e) => [e.trim(), e.trim()]))
  }
  if (!src || typeof src !== 'object') return null
  const out = {}
  for (const [k, val] of Object.entries(src)) {
    if (!PI_LEVELS.includes(k)) continue
    if (typeof val === 'string' && val) out[k] = val
  }
  return Object.keys(out).length ? out : null
}

/**
 * pi 的 thinkingLevelMap：有字符串的档位可调；off 缺省保持可关；其余填 null 从 UI 藏掉。
 * （省略 ≠ 隐藏：standard 档位省略会用 provider 默认映射显示出来。）
 */
export function thinkingLevelMap(supported) {
  if (!supported) return undefined
  const map = {}
  for (const level of PI_LEVELS) {
    if (typeof supported[level] === 'string') map[level] = supported[level]
    else if (level === 'off') continue
    else map[level] = null
  }
  return map
}

export function toPiModels(catalog = [], { baseUrl } = {}) {
  const out = []
  for (const raw of catalog) {
    const id = String(raw?.id ?? '').trim()
    if (!isChatModel(id)) continue
    const supported = normalizeReasoningEfforts(raw.reasoningEfforts)
    const reasoning = Boolean(supported)
    const model = {
      id,
      name: String(raw.name ?? raw.display_name ?? id),
      reasoning,
      input: Array.isArray(raw.input) && raw.input.length ? raw.input.filter((x) => x === 'text' || x === 'image') : inferModelInput(id),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: Number(raw.contextWindow) > 0 ? Number(raw.contextWindow) : 128000,
      maxTokens: Number(raw.maxTokens) > 0 ? Number(raw.maxTokens) : 8192,
      compat: {
        ...GATEWAY_COMPAT,
        ...(reasoning ? { supportsReasoningEffort: true } : {}),
      },
    }
    if (reasoning) {
      const map = thinkingLevelMap(supported)
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
