/**
 * 生视频模型解析：wan / minimax / grok / gpt / qwen / seedance 对到公司目录里的真实 id。
 * 密钥不在本机；这里只选目录里已有的模型。
 */

export const VIDEO_MODEL_RE = /imagine-video|video-generation|text-to-video|image-to-video|t2v|i2v|r2v|seedance|kling|wan2\.\d|hailuo|minimax-h|sora|veo-|cogvideo|vidu|runway|luma|pika/i
export const IMAGE_MODEL_RE = /imagine-image|dall-e|gpt-image|qwen-image|image-generation|text2image|text-to-image/i

/** 常用厂商短名 → 候选模型 id（按优先序）。目录里有哪个用哪个。 */
export const FAMILY_ALIASES = {
  wan: ['wan2.6-r2v', 'wan2.6-i2v', 'wan2.6-t2v', 'wan2.5-i2v-preview', 'wan2.2-i2v-plus', 'wanx2.1-i2v-plus', 'wan2.2-t2v-plus', 'wanx2.1-t2v-plus'],
  qwen: ['wan2.6-t2v', 'wan2.6-i2v', 'wan2.2-t2v-plus', 'wanx2.1-t2v-plus', 'qwen-video'],
  minimax: ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-02', 'MiniMax-H3', 'video-01', 'T2V-01-Director'],
  hailuo: ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-02', 'video-01'],
  grok: ['grok-imagine-video-1.5', 'grok-imagine-video', 'grok-imagine-video-1.0'],
  gpt: ['sora-2', 'sora-2-pro', 'sora'],
  sora: ['sora-2', 'sora-2-pro', 'sora'],
  openai: ['sora-2', 'sora-2-pro'],
  seedance: ['doubao-seedance-1-5-pro', 'doubao-seedance-1-0-pro-250528', 'doubao-seedance-1-0-pro', 'seedance-1-0-pro'],
  seeddance: ['doubao-seedance-1-5-pro', 'doubao-seedance-1-0-pro-250528', 'doubao-seedance-1-0-pro'],
  kling: ['kling-v2-1', 'kling-v1-6', 'kling-v1'],
  veo: ['veo-3.1-generate-preview', 'veo-3.0-generate-preview', 'veo-3', 'veo-2'],
}

export const DEFAULT_ALIASES = {
  wan: 'wan2.6-t2v',
  qwen: 'wan2.6-t2v',
  minimax: 'MiniMax-Hailuo-02',
  grok: 'grok-imagine-video-1.5',
  gpt: 'sora-2',
  seedance: 'doubao-seedance-1-0-pro',
}

export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4']

/** 单次上游调用的时长上限（秒）。超过就分段再拼。 */
export const SEGMENT_CAP = {
  wan: 10,
  qwen: 10,
  minimax: 10,
  hailuo: 10,
  grok: 15,
  gpt: 15,
  sora: 12,
  openai: 12,
  seedance: 12,
  seeddance: 12,
  kling: 10,
  veo: 8,
}
const DEFAULT_SEGMENT = 8
export const MAX_DURATION = 120
export const MAX_IMAGES = 5

export function isVideoModel(id) {
  const s = String(id ?? '')
  if (!s || IMAGE_MODEL_RE.test(s)) return false
  return VIDEO_MODEL_RE.test(s) || (/\bvideo\b/i.test(s) && !/vision/i.test(s))
}

export function listVideoModels(catalog = []) {
  const out = []
  const seen = new Set()
  for (const m of catalog) {
    const id = typeof m === 'string' ? m : m?.id
    if (!id || seen.has(id) || !isVideoModel(id)) continue
    seen.add(id)
    out.push(typeof m === 'string' ? { id, name: id } : { id, name: m.name ?? id, provider: m.provider, providerLabel: m.providerLabel })
  }
  return out
}

export function familyOf(requested) {
  const key = String(requested ?? '').trim().toLowerCase()
  if (!key) return ''
  if (FAMILY_ALIASES[key]) return key
  if (key.includes('seedance') || key.includes('seeddance') || key.includes('即梦')) return 'seedance'
  if (key.includes('hailuo') || key.includes('minimax') || key.includes('海螺')) return 'minimax'
  if (key.includes('sora') || key === 'chatgpt' || key === 'openai' || key.startsWith('gpt')) return 'gpt'
  if (key.includes('kling') || key.includes('可灵')) return 'kling'
  if (key.includes('veo')) return 'veo'
  if (key.includes('grok') || key.includes('imagine')) return 'grok'
  if (key.includes('qwen') || key.includes('通义')) return 'qwen'
  if (key.includes('wan') || key.includes('万相')) return 'wan'
  return key
}

/**
 * 把短名或具体 id 解析成公司目录里的模型。目录里没有就返回 null，不默默落到别的厂商。
 */
export function resolveVideoModel({ requested, defaultModel, aliases = {}, customModels = [], catalog = [] } = {}) {
  const listed = listVideoModels(catalog)
  const ids = new Set([...listed.map((m) => m.id), ...customModels.filter(Boolean)])
  const pick = (id) => {
    if (!id) return null
    const raw = String(id).trim()
    if (!raw) return null
    if (ids.has(raw)) return raw
    const lower = raw.toLowerCase()
    const hit = [...ids].find((x) => x.toLowerCase() === lower)
    if (hit) return hit
    const family = familyOf(raw)
    const override = aliases[family] || aliases[raw] || aliases[lower]
    if (override && ids.has(override)) return override
    const candidates = FAMILY_ALIASES[family] ?? []
    for (const c of candidates) if (ids.has(c)) return c
    const fuzzy = listed.find((m) => {
      const idl = m.id.toLowerCase()
      const name = String(m.name ?? '').toLowerCase()
      return idl.includes(lower) || name.includes(lower) || (family && family.length > 2 && (idl.includes(family) || name.includes(family)))
    })
    return fuzzy?.id ?? null
  }
  if (requested != null && String(requested).trim()) return pick(requested)
  return pick(defaultModel) || pick('grok') || listed[0]?.id || null
}

/** 单段上限。长视频按这个切，最后一段吃掉余数。 */
export function segmentCap(modelId) {
  const family = familyOf(modelId)
  return SEGMENT_CAP[family] ?? DEFAULT_SEGMENT
}

/** 把总时长切成不超过单段上限的秒数数组。 */
export function planSegments(duration, cap) {
  const total = Math.max(1, Math.min(MAX_DURATION, Math.round(Number(duration) || cap)))
  const size = Math.max(1, Math.round(Number(cap) || DEFAULT_SEGMENT))
  if (total <= size) return [total]
  const parts = []
  let left = total
  while (left > 0) {
    parts.push(Math.min(size, left))
    left -= size
  }
  return parts
}

export function defaultVideoConfig() {
  return {
    defaultModel: 'grok',
    aspectRatio: '16:9',
    duration: 6,
    longForm: true,
    aliases: { ...DEFAULT_ALIASES },
    customModels: [],
  }
}

export function normalizeVideoConfig(raw = {}) {
  const base = defaultVideoConfig()
  const aliases = { ...base.aliases }
  if (raw.aliases && typeof raw.aliases === 'object' && !Array.isArray(raw.aliases)) {
    for (const [k, v] of Object.entries(raw.aliases)) {
      if (typeof k === 'string' && typeof v === 'string' && k.trim() && v.trim()) aliases[k.trim().toLowerCase()] = v.trim()
    }
  }
  const customModels = Array.isArray(raw.customModels)
    ? raw.customModels.map((x) => String(x ?? '').trim()).filter(Boolean)
    : typeof raw.customModels === 'string'
      ? raw.customModels.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)
      : []
  const aspectRatio = ASPECT_RATIOS.includes(String(raw.aspectRatio ?? '')) ? String(raw.aspectRatio) : base.aspectRatio
  const defaultModel = String(raw.defaultModel ?? base.defaultModel).trim() || base.defaultModel
  const duration = Math.max(1, Math.min(MAX_DURATION, Math.round(Number(raw.duration) || base.duration)))
  const longForm = raw.longForm === false || raw.longForm === 'false' ? false : base.longForm
  return { defaultModel, aspectRatio, duration, longForm, aliases, customModels }
}
