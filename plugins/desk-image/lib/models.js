/**
 * 生图模型解析：把 gpt / qwen / grok 等常用名对到公司目录里的真实 id。
 * 密钥不在本机；这里只选目录里已有的模型。
 */

export const IMAGE_MODEL_RE = /imagine-image|dall-e|gpt-image|flux|qwen-image|wanx|image-generation|imagen|stable-diffusion|sdxl/i
export const VIDEO_MODEL_RE = /imagine-video|video-generation|text-to-video|image-to-video/i

/** 常用厂商短名 → 候选模型 id（按优先序）。目录里有哪个用哪个。 */
export const FAMILY_ALIASES = {
  grok: ['grok-imagine-image-2.0', 'grok-imagine-image', 'grok-2-image', 'grok-image'],
  gpt: ['gpt-image-1.5', 'gpt-image-1', 'gpt-image', 'dall-e-3', 'dall-e-2', 'dall-e-3-hd'],
  openai: ['gpt-image-1.5', 'gpt-image-1', 'dall-e-3', 'dall-e-2'],
  qwen: ['qwen-image-plus', 'qwen-image', 'qwen2-vl-image', 'wanx2.1-t2i-plus', 'wanx-v1'],
  wanxiang: ['wanx2.1-t2i-plus', 'wanx-v1', 'qwen-image'],
  flux: ['flux-1-pro', 'flux-pro', 'flux-1-schnell', 'flux-schnell'],
  'dall-e': ['dall-e-3', 'dall-e-2', 'gpt-image-1'],
  dalle: ['dall-e-3', 'dall-e-2', 'gpt-image-1'],
}

export const DEFAULT_ALIASES = {
  gpt: 'gpt-image-1',
  qwen: 'qwen-image',
  grok: 'grok-imagine-image-2.0',
}

export const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4']

export function isImageModel(id) {
  const s = String(id ?? '')
  if (!s || VIDEO_MODEL_RE.test(s)) return false
  return IMAGE_MODEL_RE.test(s) || (/\bimage\b/i.test(s) && !/vision/i.test(s))
}

export function listImageModels(catalog = []) {
  const out = []
  const seen = new Set()
  for (const m of catalog) {
    const id = typeof m === 'string' ? m : m?.id
    if (!id || seen.has(id) || !isImageModel(id)) continue
    seen.add(id)
    out.push(typeof m === 'string' ? { id, name: id } : { id, name: m.name ?? id, provider: m.provider, providerLabel: m.providerLabel })
  }
  return out
}

function familyOf(requested) {
  const key = String(requested ?? '').trim().toLowerCase()
  if (!key) return ''
  if (FAMILY_ALIASES[key]) return key
  if (key === 'chatgpt' || key === 'openai' || key.startsWith('gpt') || key.startsWith('dall')) return key.startsWith('dall') || key === 'dalle' ? 'dall-e' : 'gpt'
  if (key.includes('qwen') || key.includes('wanx') || key.includes('通义') || key.includes('万相')) return 'qwen'
  if (key.includes('grok') || key.includes('imagine')) return 'grok'
  if (key.includes('flux')) return 'flux'
  return key
}

/**
 * 把用户写的 gpt / qwen / grok / 具体 id 解析成公司目录里的模型。
 * @param {object} opts
 * @param {string} [opts.requested] 工具参数或设置里的值
 * @param {string} [opts.defaultModel] 插件默认（可以是短名或 id）
 * @param {Record<string,string>} [opts.aliases] 用户覆盖的短名 → id
 * @param {string[]} [opts.customModels] 额外允许的 id
 * @param {Array} [opts.catalog] 公司模型目录
 */
export function resolveImageModel({ requested, defaultModel, aliases = {}, customModels = [], catalog = [] } = {}) {
  const listed = listImageModels(catalog)
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
      return idl.includes(lower) || name.includes(lower) || (family && (idl.includes(family) || name.includes(family)))
    })
    return fuzzy?.id ?? null
  }

  if (requested != null && String(requested).trim()) return pick(requested)
  return pick(defaultModel) || pick('grok') || listed[0]?.id || null
}

export function defaultImageConfig() {
  return {
    defaultModel: 'grok',
    aspectRatio: '1:1',
    aliases: { ...DEFAULT_ALIASES },
    customModels: [],
  }
}

export function normalizeImageConfig(raw = {}) {
  const base = defaultImageConfig()
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
  return { defaultModel, aspectRatio, aliases, customModels }
}
