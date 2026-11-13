/**
 * 公司网关模型目录 → 1.0 的 providers.valimart（CustomProviderSetting，settingsSchema.ts）。
 *
 * - 生图 / 视频模型不进聊天目录；单价按人记账在网关，这里不写价格。
 * - 密钥：apiKey 直接写网关令牌。1.0 的运行时 provider 走「用户 settings 原文 → 解析」这条路径，
 *   全程不做 $VAR 展开（只有 list-models 等走 merged 设置的路径才展开），所以占位符到不了请求头。
 *   令牌本来也只存在本机 ~/.valimart（登录态文件 + 0600 权限的启动设置），不落任何会提交的文件。
 * - 思考档位：capabilities.thinking（modes/supportsEffort/supportedEffortLevels），DeepSeek 思维链由
 *   网关在服务端转换成 OpenAI 兼容字段。
 * - 快速推理模型走 providers.valimart.routing.utility（1.0 没有 fastModel 了）。
 */
import { resolveModelInput } from './model-input.mjs'

export const GATEWAY_TOKEN_ENV = 'VALIMART_GATEWAY_TOKEN'

const GEN_ONLY = /imagine-image|imagine-video|dall-e|gpt-image|flux|qwen-image|image-generation|video-generation|text-to-video/i

/** 1.0 认识的推理档位（低 → 高，CustomProviderThinkingCapability.supportedEffortLevels）。 */
export const QWEN_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

export function isChatModel(id) {
  const s = String(id ?? '')
  return Boolean(s) && !GEN_ONLY.test(s)
}

/** 网关 reasoningEfforts → 1.0 档位列表（按低到高排）；不支持思考返回 []。 */
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

/** 单个模型 → CustomProviderModelSetting。 */
export function toQwenModel(raw) {
  const id = String(raw?.id ?? '').trim()
  const entry = {
    model: id,
    displayName: String(raw.name ?? raw.display_name ?? id),
    ...(Number(raw.contextWindow) > 0 ? { contextWindow: Number(raw.contextWindow) } : {}),
    capabilities: {
      tools: true,
      ...(resolveModelInput(raw).includes('image') ? { vision: true } : {}),
    },
  }
  const efforts = qwenEfforts(raw.reasoningEfforts)
  if (efforts.length) {
    entry.capabilities.thinking = {
      modes: ['enabled'],
      supportsEffort: true,
      supportedEffortLevels: efforts,
    }
  }
  return entry
}

/** 公司目录 → providers.valimart；公司默认模型放 models 首位 + provider.model。 */
export function toProviderSetting(catalog, { gatewayUrl, defaultModel, token } = {}) {
  const models = []
  const seen = new Set()
  for (const raw of Array.isArray(catalog) ? catalog : []) {
    const id = String(raw?.id ?? '').trim()
    if (!isChatModel(id) || seen.has(id)) continue
    seen.add(id)
    models.push(toQwenModel(raw))
  }
  const at = models.findIndex((m) => m.model === defaultModel)
  const ordered = at > 0 ? [models[at], ...models.slice(0, at), ...models.slice(at + 1)] : models
  return {
    baseUrl: v1BaseUrl(gatewayUrl),
    apiKey: String(token ?? ''),
    protocol: 'openai',
    authType: 'bearer',
    displayName: '公司网关（valimart）',
    ...(ordered.length ? { model: ordered[0].model } : {}),
    models: ordered,
  }
}

/** 登录态里的公司默认模型 / 快速推理模型；不在聊天目录里就退回第一个 / 不设。 */
export function pickModels(state, models) {
  const ids = models.map((m) => m.model)
  const wanted = String(state?.company?.defaultModel ?? state?.defaultModel ?? '').trim()
  const fast = String(state?.company?.quickInferenceModel ?? '').trim()
  return {
    main: ids.includes(wanted) ? wanted : ids[0] ?? '',
    fast: ids.includes(fast) ? fast : '',
  }
}
