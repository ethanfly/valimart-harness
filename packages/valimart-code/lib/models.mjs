/**
 * 公司网关模型目录 → Qwen Code 的 modelProviders.openai 条目。
 *
 * - 生图 / 视频模型不进聊天目录；单价按人记账在网关，这里不写价格。
 * - 密钥：每条都用 envKey VALIMART_GATEWAY_TOKEN，由启动器从登录态注入进程环境，不落进任何 settings 文件。
 * - 思考档位：网关对外统一 OpenAI 兼容 + DeepSeek 思维链（与 desk-host、pi 包的 thinkingFormat: 'deepseek' 一致），
 *   其它厂商由网关在服务端转换。Qwen Code 的 deepseek-openai profile 正好发 thinking + reasoning_effort，
 *   并在历史里的 assistant 消息上回传 reasoning_content。
 *   网关目录写成数组（['low','high']）或 {档位: 上游取值}（{off:null, high:'high', max:'max'}），取 Qwen 认识的档位。
 */
import { resolveModelInput } from '../../../scripts/lib/model-input.mjs'

export const GATEWAY_TOKEN_ENV = 'VALIMART_GATEWAY_TOKEN'

const GEN_ONLY = /imagine-image|imagine-video|dall-e|gpt-image|flux|qwen-image|image-generation|video-generation|text-to-video/i

/** Qwen Code 的推理档位（低 → 高）。 */
export const QWEN_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

export function isChatModel(id) {
  const s = String(id ?? '')
  return Boolean(s) && !GEN_ONLY.test(s)
}

/** 网关 reasoningEfforts → Qwen 档位列表（按低到高排）；不支持思考返回 []。 */
export function qwenEfforts(reasoningEfforts) {
  let values = []
  if (Array.isArray(reasoningEfforts)) values = reasoningEfforts
  else if (reasoningEfforts && typeof reasoningEfforts === 'object') values = Object.values(reasoningEfforts)
  const set = new Set(values.filter((v) => typeof v === 'string').map((v) => v.trim()))
  return QWEN_EFFORTS.filter((e) => set.has(e))
}

export function defaultEffort(efforts) {
  if (efforts.includes('high')) return 'high'
  if (efforts.includes('medium')) return 'medium'
  return efforts[efforts.length - 1]
}

export function v1BaseUrl(gatewayUrl) {
  return `${String(gatewayUrl ?? '').replace(/\/+$/, '')}/v1`
}

export function toQwenModel(raw, baseUrl) {
  const id = String(raw?.id ?? '').trim()
  const entry = {
    id,
    name: String(raw.name ?? raw.display_name ?? id),
    ...(raw.providerLabel ? { description: `公司网关 · ${raw.providerLabel}` } : {}),
    baseUrl,
    envKey: GATEWAY_TOKEN_ENV,
    generationConfig: {
      ...(Number(raw.contextWindow) > 0 ? { contextWindowSize: Number(raw.contextWindow) } : {}),
      ...(resolveModelInput(raw).includes('image') ? { modalities: { image: true } } : {}),
    },
  }
  const efforts = qwenEfforts(raw.reasoningEfforts)
  if (efforts.length) entry.capabilities = { reasoning: { profile: 'deepseek-openai', efforts, defaultEffort: defaultEffort(efforts) } }
  return entry
}

/** 公司默认模型排第一：/model 列表与首次启动都先看到它。 */
export function toQwenModels(catalog, { gatewayUrl, defaultModel } = {}) {
  const baseUrl = v1BaseUrl(gatewayUrl)
  const seen = new Set()
  const out = []
  for (const raw of Array.isArray(catalog) ? catalog : []) {
    const id = String(raw?.id ?? '').trim()
    if (!isChatModel(id) || seen.has(id)) continue
    seen.add(id)
    out.push(toQwenModel(raw, baseUrl))
  }
  const at = out.findIndex((m) => m.id === defaultModel)
  return at > 0 ? [out[at], ...out.slice(0, at), ...out.slice(at + 1)] : out
}

/** 登录态里的公司默认模型 / 快速推理模型；不在聊天目录里就退回第一个 / 不设。 */
export function pickModels(state, models) {
  const ids = models.map((m) => m.id)
  const wanted = String(state?.company?.defaultModel ?? state?.defaultModel ?? '').trim()
  const fast = String(state?.company?.quickInferenceModel ?? '').trim()
  return {
    main: ids.includes(wanted) ? wanted : ids[0] ?? '',
    fast: ids.includes(fast) ? fast : '',
  }
}
