/**
 * 从上游拉取模型目录，并补上下文窗口 / 思考强度默认值。
 * 拉不到列表时回退到通道 hint 或内置目录，让管理员还能手填。
 */
import { HttpError } from './http.js'
import { inferUpstreamApi, usesAnthropicMessages, anthropicHeaders } from './upstream-anthropic.js'
import { usesChatgptCodex } from './upstream-chatgpt.js'

const DEFAULT_EFFORTS = ['low', 'medium', 'high']

/** 按模型 id 推断上下文与思考档位（自动设；不对再手改）。 */
const KNOWN_META = [
  { test: /deepseek-v4|deepseek-reasoner|deepseek-chat/, contextWindow: 1_000_000, maxTokens: 384_000, reasoningEfforts: { off: null, high: 'high', max: 'max' } },
  { test: /gpt-5|gpt-4\.1|o3|o4|codex/, contextWindow: 256_000, maxTokens: 32_768, reasoningEfforts: DEFAULT_EFFORTS },
  { test: /gpt-4o|chatgpt/, contextWindow: 128_000, maxTokens: 16_384, reasoningEfforts: DEFAULT_EFFORTS },
  { test: /claude-opus-4|claude-sonnet-4|claude-haiku-4/, contextWindow: 200_000, maxTokens: 32_000, reasoningEfforts: DEFAULT_EFFORTS },
  { test: /claude/, contextWindow: 200_000, maxTokens: 16_384, reasoningEfforts: DEFAULT_EFFORTS },
  { test: /grok-4|grok-3/, contextWindow: 256_000, maxTokens: 32_000, reasoningEfforts: ['low', 'high'] },
  { test: /grok/, contextWindow: 128_000, maxTokens: 16_384, reasoningEfforts: ['low', 'high'] },
]

export const FALLBACK_CATALOGS = {
  chatgpt: [
    { id: 'gpt-5.5', contextWindow: 256_000, maxTokens: 32_768, reasoningEfforts: DEFAULT_EFFORTS },
    { id: 'gpt-5.4', contextWindow: 256_000, maxTokens: 32_768, reasoningEfforts: DEFAULT_EFFORTS },
    { id: 'gpt-5.5-mini', contextWindow: 256_000, maxTokens: 16_384, reasoningEfforts: DEFAULT_EFFORTS },
  ],
  claude: [
    { id: 'claude-opus-4-6', contextWindow: 200_000, maxTokens: 32_000, reasoningEfforts: DEFAULT_EFFORTS },
    { id: 'claude-sonnet-4-6', contextWindow: 200_000, maxTokens: 32_000, reasoningEfforts: DEFAULT_EFFORTS },
    { id: 'claude-haiku-4-5', contextWindow: 200_000, maxTokens: 16_384, reasoningEfforts: DEFAULT_EFFORTS },
  ],
  grok: [
    { id: 'grok-4.6', contextWindow: 256_000, maxTokens: 32_000, reasoningEfforts: ['low', 'high'] },
    { id: 'grok-4.6-fast', contextWindow: 256_000, maxTokens: 16_384, reasoningEfforts: ['low', 'high'] },
  ],
  openai: [
    { id: 'gpt-5.5', contextWindow: 256_000, maxTokens: 32_768, reasoningEfforts: DEFAULT_EFFORTS },
    { id: 'gpt-5.5-mini', contextWindow: 256_000, maxTokens: 16_384, reasoningEfforts: DEFAULT_EFFORTS },
  ],
  anthropic: [
    { id: 'claude-opus-4-6', contextWindow: 200_000, maxTokens: 32_000, reasoningEfforts: DEFAULT_EFFORTS },
    { id: 'claude-sonnet-4-6', contextWindow: 200_000, maxTokens: 32_000, reasoningEfforts: DEFAULT_EFFORTS },
  ],
  deepseek: [
    { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 384_000, reasoningEfforts: { off: null, high: 'high', max: 'max' } },
    { id: 'deepseek-v4-flash', contextWindow: 1_000_000, maxTokens: 384_000, reasoningEfforts: { off: null, high: 'high', max: 'max' } },
  ],
}

export function inferModelMeta(id) {
  const key = String(id ?? '').toLowerCase()
  if (!key) return {}
  for (const row of KNOWN_META) {
    if (row.test.test(key)) {
      return { contextWindow: row.contextWindow, maxTokens: row.maxTokens, reasoningEfforts: row.reasoningEfforts }
    }
  }
  return {}
}

/** OpenAI 兼容路径：base 已带 /v1 或已是完整 path 则不叠；否则补 /v1。 */
export function openaiCompatUrl(baseUrl, apiPath) {
  const b = String(baseUrl ?? '').replace(/\/+$/, '')
  const p = apiPath.startsWith('/') ? apiPath : `/${apiPath}`
  if (!b) throw new HttpError(400, '缺少 baseUrl')
  if (b.toLowerCase().endsWith(p.toLowerCase())) return b
  if (b.endsWith('/v1')) return `${b}${p}`
  return `${b}/v1${p}`
}

export function modelsListUrl(baseUrl) {
  return openaiCompatUrl(baseUrl, '/models')
}

export function normalizeDiscoveredModel(raw, channel) {
  const id = String(raw?.id ?? raw?.name ?? '').trim()
  if (!id) return null
  const inferred = inferModelMeta(id)
  const contextWindow = Number(raw.context_window ?? raw.contextWindow ?? raw.max_context_tokens ?? inferred.contextWindow ?? channel?.contextWindow)
  const maxTokens = Number(raw.max_tokens ?? raw.maxTokens ?? raw.max_output_tokens ?? inferred.maxTokens ?? channel?.maxTokens)
  const efforts = raw.reasoningEfforts ?? raw.reasoning_efforts ?? inferred.reasoningEfforts ?? channel?.reasoningEfforts
  const entry = { id }
  const named = raw.display_name ?? (raw.name && raw.name !== id ? raw.name : undefined)
  if (named) entry.name = String(named)
  if (Number.isFinite(contextWindow) && contextWindow > 0) entry.contextWindow = contextWindow
  if (Number.isFinite(maxTokens) && maxTokens > 0) entry.maxTokens = maxTokens
  if (efforts !== undefined && efforts !== null && efforts !== false) entry.reasoningEfforts = efforts
  return entry
}

function parseModelPayload(json) {
  if (Array.isArray(json)) return json
  if (Array.isArray(json?.data)) return json.data
  if (Array.isArray(json?.models)) return json.models
  return []
}

export function fallbackModelsFor(channel) {
  const id = String(channel?.id ?? '')
  const rows = FALLBACK_CATALOGS[id]
  if (rows) return rows.map((m) => normalizeDiscoveredModel(m, channel)).filter(Boolean)
  const hint = String(channel?.hint ?? '')
    .split(/[,\n，]/)
    .map((s) => s.trim())
    .filter(Boolean)
  return hint.map((mid) => normalizeDiscoveredModel({ id: mid }, channel)).filter(Boolean)
}

export async function discoverUpstreamModels({
  baseUrl,
  credential,
  api,
  authStyle,
  channel,
  fetchImpl = fetch,
  timeoutMs = 12_000,
} = {}) {
  const upstream = { baseUrl, api: api || inferUpstreamApi(baseUrl), authStyle }
  if (usesChatgptCodex(upstream)) {
    return { models: fallbackModelsFor(channel ?? { id: 'chatgpt' }), source: 'fallback', reason: 'chatgpt-codex 无公开 /models' }
  }
  if (!credential) throw new HttpError(400, '缺少凭据，无法拉取模型列表')
  const url = modelsListUrl(baseUrl)
  const headers = { accept: 'application/json', 'user-agent': 'valimart-harness' }
  if (usesAnthropicMessages(upstream) || api === 'anthropic-messages') {
    Object.assign(headers, anthropicHeaders(credential, { authStyle }))
  } else {
    headers.authorization = `Bearer ${credential}`
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  let res
  try {
    res = await fetchImpl(url, { method: 'GET', headers, signal: ac.signal })
  } catch (err) {
    const fallback = fallbackModelsFor(channel)
    if (fallback.length) return { models: fallback, source: 'fallback', reason: `上游不可达：${err.message}` }
    throw new HttpError(502, `拉取模型列表失败：${err.message}`, 'models_unreachable')
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const fallback = fallbackModelsFor(channel)
    if (fallback.length) return { models: fallback, source: 'fallback', reason: `上游返回 HTTP ${res.status}` }
    throw new HttpError(502, `拉取模型列表失败 HTTP ${res.status}`, 'models_failed')
  }
  const json = await res.json().catch(() => ({}))
  const models = parseModelPayload(json).map((row) => normalizeDiscoveredModel(row, channel)).filter(Boolean)
  if (models.length === 0) {
    const fallback = fallbackModelsFor(channel)
    if (fallback.length) return { models: fallback, source: 'fallback', reason: '上游目录为空' }
    throw new HttpError(502, '上游没有返回任何模型', 'models_empty')
  }
  return { models, source: 'upstream' }
}

export function mergeDiscoveredModels(manual, discovered, input = {}, channel) {
  const byId = new Map((discovered ?? []).map((m) => [m.id, m]))
  return (manual ?? []).map((m) => {
    const extra = byId.get(m.id) ?? inferModelMeta(m.id)
    const contextWindow = m.contextWindow ?? input.contextWindow ?? extra.contextWindow ?? channel?.contextWindow
    const maxTokens = m.maxTokens ?? input.maxTokens ?? extra.maxTokens ?? channel?.maxTokens
    const reasoningEfforts = input.reasoningEfforts ?? m.reasoningEfforts ?? extra.reasoningEfforts ?? channel?.reasoningEfforts
    return {
      ...extra,
      ...m,
      ...(m.name || extra.name ? { name: m.name ?? extra.name } : {}),
      ...(contextWindow != null ? { contextWindow } : {}),
      ...(maxTokens != null ? { maxTokens } : {}),
      ...(reasoningEfforts != null && reasoningEfforts !== '' ? { reasoningEfforts } : {}),
    }
  })
}
