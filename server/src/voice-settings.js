/**
 * 语音通道设置（管理页 → 模型 → 语音）。
 *
 * 设备语音代理（/v1/audio/*）的上游通道有两种来源：
 * - 管理页设置：ASR 与 TTS 各有端点 + API Key，外加模型/音色/价目，存在服务端库
 *   （gateway.sqlite 的 voice.json 集合，与通道凭据同一原则：只落服务端、不写进配置下发）。
 *   TTS 端点留空 = 与 ASR 同一个地址和密钥。旧记录只有一个 baseUrl，读取时两边共用。
 * - config.local.json / 环境变量：`voice.provider` 指向一个上游，密钥由 config.js 解析。
 *
 * 生效优先级：管理页设置 > 配置。管理页一旦保存就整体生效（端点和参数一起），清空后回退到配置。
 * 管理页视图只回「是否可用 / 来源 / 端点 / 是否配置了密钥」，绝不回 key 值。
 */
import { createPersistence } from './store.js'
import { HttpError } from './http.js'

export const VOICE_SOURCE_ADMIN = 'admin-page'
export const VOICE_SOURCE_CONFIG = 'config'
/** 管理页语音通道在账本里的 upstream id（配置通道沿用配置里的 provider id）。 */
export const VOICE_ADMIN_PROVIDER = 'voice-admin'

const SOURCE_LABELS = {
  [VOICE_SOURCE_ADMIN]: '管理页设置',
  [VOICE_SOURCE_CONFIG]: '服务端配置 / 环境变量',
}

const DEFAULTS = {
  asrModel: 'whisper-1',
  ttsModel: 'tts-1',
  voice: 'alloy',
  ttsRate: 24000,
  timeoutMs: 30_000,
  maxTtsBytes: 20 * 1024 * 1024,
}

/** 本机语音运行时的端点。不是真实地址，设备请求由 VoiceRuntime 在进程内处理。 */
export function localEndpoint(kind) {
  return kind === 'tts' ? 'local://tts' : 'local://asr'
}

export function isLocalEndpoint(value) {
  return value === 'local://asr' || value === 'local://tts'
}

/** 规范化端点：http(s)，或本机运行时的 local://。不带账号/查询串/锚点；去掉尾部斜杠。 */
export function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (isLocalEndpoint(value)) return value
  if (!value || value.length > 500) return null
  let u
  try {
    u = new URL(value)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password || u.search || u.hash) return null
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
}

/** 超时与上游回包上限始终来自配置文件（运维参数，不在管理页里调）。 */
function limits(cfg) {
  const v = cfg.voice ?? {}
  return {
    timeoutMs: Math.max(1000, Number(v.timeoutMs) || DEFAULTS.timeoutMs),
    maxTtsBytes: Math.max(1024, Number(v.maxTtsBytes) || DEFAULTS.maxTtsBytes),
  }
}

/** 配置里的语音通道；没配、或 provider 指的不是 mock / openai-compatible 时返回 null。 */
export function configVoiceChannel(cfg) {
  const v = cfg.voice ?? {}
  const up = v.provider ? cfg.upstreams?.[v.provider] : undefined
  if (!up || (up.kind !== 'mock' && up.kind !== 'openai-compatible')) return null
  return {
    source: VOICE_SOURCE_CONFIG,
    provider: v.provider,
    kind: up.kind,
    asrBaseUrl: normalizeBaseUrl(up.baseUrl),
    asrApiKey: up.kind === 'mock' ? null : (up.resolvedKey ?? null),
    ttsBaseUrl: normalizeBaseUrl(up.baseUrl),
    ttsApiKey: up.kind === 'mock' ? null : (up.resolvedKey ?? null),
    asrModel: v.asrModel ?? DEFAULTS.asrModel,
    ttsModel: v.ttsModel ?? DEFAULTS.ttsModel,
    voice: v.voice ?? DEFAULTS.voice,
    ttsRate: Number(v.ttsRate) || DEFAULTS.ttsRate,
    asrPriceCnyPerMinute: Number(v.asrPriceCnyPerMinute) || 0,
    ttsPriceCnyPerMinute: Number(v.ttsPriceCnyPerMinute) || 0,
    ...limits(cfg),
  }
}

function cleanOption(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  const s = String(value).trim()
  if (!s) return fallback
  if (s.length > 200) throw new HttpError(400, `${label}不能超过 200 字`, 'bad_field')
  // 这些值会写进上游 multipart 头：换行 / 引号 / 反斜杠 / 控制字符一律拒绝。
  if (/[\u0000-\u001f\u007f"\\]/.test(s)) throw new HttpError(400, `${label}含非法字符（换行、引号或控制字符）`, 'bad_field')
  return s
}

function numberOption(value, { min, max, integer = false, fallback, label }) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new HttpError(400, `${label}必须在 ${min}–${max} 之间${integer ? '（整数）' : ''}`, 'bad_field')
  }
  return n
}

function cleanApiKey(value) {
  if (value === undefined || value === null) return ''
  const s = String(value).trim()
  if (!s) return ''
  if (s.length > 400 || !/^[\x21-\x7e]+$/.test(s)) {
    throw new HttpError(400, 'API Key 只能是可见 ASCII 字符（无空白、无换行），且不超过 400 字', 'bad_key')
  }
  return s
}

export class VoiceSettings {
  constructor(cfg, dataDir) {
    this.cfg = cfg
    this.store = createPersistence(dataDir).file('voice.json', () => ({}))
  }

  /** 管理页保存的通道（含密钥，只在服务端使用）；没有不完整记录时返回 null。 */
  stored() {
    const data = this.store.load()
    const ch = data && typeof data === 'object' ? data.channel : null
    if (!ch || typeof ch !== 'object') return null
    // 旧记录只有 baseUrl/apiKey：两边共用，升级后第一次保存才拆开。
    const asrBaseUrl = normalizeBaseUrl(ch.asrBaseUrl ?? ch.baseUrl)
    if (!asrBaseUrl) return null
    const ttsBaseUrl = normalizeBaseUrl(ch.ttsBaseUrl) || asrBaseUrl
    const asrApiKey = typeof (ch.asrApiKey ?? ch.apiKey) === 'string' ? (ch.asrApiKey ?? ch.apiKey) : ''
    const ttsApiKey = typeof ch.ttsApiKey === 'string' && ch.ttsApiKey ? ch.ttsApiKey : asrApiKey
    return { ...ch, asrBaseUrl, ttsBaseUrl, asrApiKey, ttsApiKey }
  }

  /** 实际生效的通道：管理页优先，否则配置；都没有返回 null。 */
  effective() {
    const admin = this.stored()
    if (admin) {
      // 管理页通道是完整的：参数用保存值（缺省用内置默认），不动配置里那套（可能是 mock 的模型名）。
      return {
        source: VOICE_SOURCE_ADMIN,
        provider: VOICE_ADMIN_PROVIDER,
        kind: 'openai-compatible',
        asrBaseUrl: admin.asrBaseUrl,
        asrApiKey: admin.asrApiKey || null,
        ttsBaseUrl: admin.ttsBaseUrl,
        ttsApiKey: admin.ttsApiKey || null,
        asrModel: admin.asrModel || DEFAULTS.asrModel,
        ttsModel: admin.ttsModel || DEFAULTS.ttsModel,
        voice: admin.voice || DEFAULTS.voice,
        ttsRate: Number(admin.ttsRate) || DEFAULTS.ttsRate,
        asrPriceCnyPerMinute: Number(admin.asrPriceCnyPerMinute) || 0,
        ttsPriceCnyPerMinute: Number(admin.ttsPriceCnyPerMinute) || 0,
        updatedAt: admin.updatedAt ?? null,
        updatedBy: admin.updatedBy ?? null,
        ...limits(this.cfg),
      }
    }
    return configVoiceChannel(this.cfg)
  }

  /** 通道是否真的能用：mock，或 openai-compatible 且 ASR、TTS 两端都有地址和密钥。 */
  static usable(ch) {
    if (!ch) return false
    if (ch.kind === 'mock') return true
    return ch.kind === 'openai-compatible' && !!ch.asrBaseUrl && !!ch.asrApiKey && !!ch.ttsBaseUrl && !!ch.ttsApiKey
  }

  /** 管理页视图：状态 + 来源 + 端点（不含密钥）+ 表单初值。 */
  view() {
    const eff = this.effective()
    const admin = this.stored()
    const config = configVoiceChannel(this.cfg)
    const available = VoiceSettings.usable(eff)
    // 表单初值：已保存的管理页通道 > 配置里的真实通道 > 内置默认（mock 的模型名不要带进表单）。
    const form = admin
      ? {
          asrBaseUrl: admin.asrBaseUrl,
          ttsBaseUrl: admin.ttsBaseUrl === admin.asrBaseUrl ? '' : admin.ttsBaseUrl,
          asrModel: admin.asrModel || DEFAULTS.asrModel,
          ttsModel: admin.ttsModel || DEFAULTS.ttsModel,
          voice: admin.voice || DEFAULTS.voice,
          ttsRate: Number(admin.ttsRate) || DEFAULTS.ttsRate,
          asrPriceCnyPerMinute: Number(admin.asrPriceCnyPerMinute) || 0,
          ttsPriceCnyPerMinute: Number(admin.ttsPriceCnyPerMinute) || 0,
        }
      : config && config.kind === 'openai-compatible'
        ? {
            asrBaseUrl: config.asrBaseUrl ?? '',
            ttsBaseUrl: '',
            asrModel: config.asrModel,
            ttsModel: config.ttsModel,
            voice: config.voice,
            ttsRate: config.ttsRate,
            asrPriceCnyPerMinute: config.asrPriceCnyPerMinute,
            ttsPriceCnyPerMinute: config.ttsPriceCnyPerMinute,
          }
        : {
            asrBaseUrl: '',
            ttsBaseUrl: '',
            asrModel: DEFAULTS.asrModel,
            ttsModel: DEFAULTS.ttsModel,
            voice: DEFAULTS.voice,
            ttsRate: DEFAULTS.ttsRate,
            asrPriceCnyPerMinute: 0,
            ttsPriceCnyPerMinute: 0,
          }
    return {
      voice: {
        available,
        mock: available && eff.kind === 'mock',
        source: eff?.source ?? null,
        sourceLabel: eff ? SOURCE_LABELS[eff.source] : null,
        provider: eff?.provider ?? null,
        asrEndpoint: eff?.asrBaseUrl ?? null,
        ttsEndpoint: eff?.ttsBaseUrl ?? null,
        endpointsSplit: !!eff && eff.asrBaseUrl !== eff.ttsBaseUrl,
        asrKeyConfigured: !!eff?.asrApiKey,
        ttsKeyConfigured: !!eff?.ttsApiKey,
        asrModel: eff?.asrModel ?? DEFAULTS.asrModel,
        ttsModel: eff?.ttsModel ?? DEFAULTS.ttsModel,
        voice: eff?.voice ?? DEFAULTS.voice,
        ttsRate: eff?.ttsRate ?? DEFAULTS.ttsRate,
        asrPriceCnyPerMinute: eff?.asrPriceCnyPerMinute ?? 0,
        ttsPriceCnyPerMinute: eff?.ttsPriceCnyPerMinute ?? 0,
        adminSet: !!admin,
        updatedAt: admin?.updatedAt ?? null,
        updatedBy: admin?.updatedBy ?? null,
        form,
      },
    }
  }

  /**
   * 解析一端的地址和密钥。地址必填（除非 allowEmpty，用于「TTS 留空 = 跟 ASR」）；
   * 密钥留空只在地址与已保存的相同端点一致时沿用，换地址必须重填。
   */
  resolveEndpoint(input, { urlField, keyField, existingUrl, existingKey, label, allowEmpty }) {
    const raw = typeof input[urlField] === 'string' ? input[urlField].trim() : ''
    if (!raw && allowEmpty) return { baseUrl: '', apiKey: '' }
    const baseUrl = normalizeBaseUrl(raw)
    if (!baseUrl) throw new HttpError(400, `${label}端点必须是 http(s) 地址（不能带账号、查询串或锚点）`, 'bad_base_url')
    let apiKey = cleanApiKey(input[keyField])
    if (!apiKey && existingKey && existingUrl === baseUrl) apiKey = existingKey
    if (!apiKey) throw new HttpError(400, `请填写${label} API Key；更换端点地址时必须重新填写`, 'need_api_key')
    return { baseUrl, apiKey }
  }

  /**
   * 保存管理页通道。TTS 端点留空 = 与 ASR 同一地址和密钥。
   * 留空 key = 沿用已保存的 key（仅端点未变时允许，避免把旧密钥发到新地址）。
   */
  update(input = {}) {
    const existing = this.stored()
    const asr = this.resolveEndpoint(input, {
      urlField: 'asrBaseUrl', keyField: 'asrApiKey',
      existingUrl: existing?.asrBaseUrl, existingKey: existing?.asrApiKey, label: 'ASR',
    })
    const ttsOwn = this.resolveEndpoint(input, {
      urlField: 'ttsBaseUrl', keyField: 'ttsApiKey',
      existingUrl: existing?.ttsBaseUrl, existingKey: existing?.ttsApiKey,
      label: 'TTS', allowEmpty: true,
    })
    const tts = ttsOwn.baseUrl ? ttsOwn : { baseUrl: asr.baseUrl, apiKey: asr.apiKey }
    const channel = {
      asrBaseUrl: asr.baseUrl,
      asrApiKey: asr.apiKey,
      ttsBaseUrl: tts.baseUrl,
      ttsApiKey: tts.apiKey,
      asrModel: cleanOption(input.asrModel, existing?.asrModel || DEFAULTS.asrModel, 'ASR 模型'),
      ttsModel: cleanOption(input.ttsModel, existing?.ttsModel || DEFAULTS.ttsModel, 'TTS 模型'),
      voice: cleanOption(input.voice, existing?.voice || DEFAULTS.voice, '音色'),
      ttsRate: numberOption(input.ttsRate, { min: 8000, max: 48000, integer: true, fallback: existing?.ttsRate || DEFAULTS.ttsRate, label: '建议采样率' }),
      asrPriceCnyPerMinute: numberOption(input.asrPriceCnyPerMinute, { min: 0, max: 1000, fallback: existing?.asrPriceCnyPerMinute ?? 0, label: '识别价目' }),
      ttsPriceCnyPerMinute: numberOption(input.ttsPriceCnyPerMinute, { min: 0, max: 1000, fallback: existing?.ttsPriceCnyPerMinute ?? 0, label: '合成价目' }),
      updatedAt: new Date().toISOString(),
      updatedBy: input.user?.username ?? null,
    }
    this.store.update((data) => {
      data.channel = channel
    })
    return this.view()
  }

  /** 清除管理页设置，回退到配置文件。 */
  clear() {
    this.store.update((data) => {
      delete data.channel
    })
    return this.view()
  }

  /**
   * 「测试」用的候选通道：表单里填了哪一端就测哪一端，没填的沿用当前生效通道。
   * 密钥沿用顺序：表单 > 已保存（端点相同）> 配置（端点相同）；换了地址必须重新填。
   */
  testChannel(input = {}) {
    const existing = this.stored()
    const config = configVoiceChannel(this.cfg)
    const eff = this.effective()
    const side = (urlField, keyField, effUrl, effKey) => {
      const raw = typeof input[urlField] === 'string' ? input[urlField].trim() : ''
      if (!raw) return { baseUrl: effUrl ?? '', apiKey: effKey ?? '' }
      const baseUrl = normalizeBaseUrl(raw)
      if (!baseUrl) throw new HttpError(400, '端点必须是 http(s) 地址（不能带账号、查询串或锚点）', 'bad_base_url')
      let apiKey = cleanApiKey(input[keyField])
      if (!apiKey && existing?.[keyField] && existing[urlField] === baseUrl) apiKey = existing[keyField]
      if (!apiKey && config?.[keyField] && config[urlField] === baseUrl) apiKey = config[keyField]
      if (!apiKey) throw new HttpError(400, '请填写 API Key（端点与已保存的不一致时不能沿用旧密钥）', 'need_api_key')
      return { baseUrl, apiKey }
    }
    if (!eff && !(typeof input.asrBaseUrl === 'string' && input.asrBaseUrl.trim())) {
      throw new HttpError(400, '请先填写 ASR 端点（或先在 config 里配置 voice.provider）', 'bad_base_url')
    }
    const asr = side('asrBaseUrl', 'asrApiKey', eff?.asrBaseUrl, eff?.asrApiKey)
    const ttsRaw = typeof input.ttsBaseUrl === 'string' ? input.ttsBaseUrl.trim() : ''
    const tts = ttsRaw
      ? side('ttsBaseUrl', 'ttsApiKey', eff?.ttsBaseUrl, eff?.ttsApiKey)
      : { baseUrl: asr.baseUrl, apiKey: asr.apiKey }
    if (!asr.baseUrl || !asr.apiKey || !tts.baseUrl || !tts.apiKey) {
      throw new HttpError(400, '请先填写端点和 API Key（或先在 config 里配置 voice.provider）', 'need_api_key')
    }
    return {
      source: VOICE_SOURCE_ADMIN,
      provider: VOICE_ADMIN_PROVIDER,
      kind: 'openai-compatible',
      asrBaseUrl: asr.baseUrl,
      asrApiKey: asr.apiKey,
      ttsBaseUrl: tts.baseUrl,
      ttsApiKey: tts.apiKey,
      asrModel: cleanOption(input.asrModel, existing?.asrModel || DEFAULTS.asrModel, 'ASR 模型'),
      ttsModel: cleanOption(input.ttsModel, existing?.ttsModel || DEFAULTS.ttsModel, 'TTS 模型'),
      voice: cleanOption(input.voice, existing?.voice || DEFAULTS.voice, '音色'),
      ttsRate: numberOption(input.ttsRate, { min: 8000, max: 48000, integer: true, fallback: existing?.ttsRate || DEFAULTS.ttsRate, label: '建议采样率' }),
      asrPriceCnyPerMinute: numberOption(input.asrPriceCnyPerMinute, { min: 0, max: 1000, fallback: existing?.asrPriceCnyPerMinute ?? 0, label: '识别价目' }),
      ttsPriceCnyPerMinute: numberOption(input.ttsPriceCnyPerMinute, { min: 0, max: 1000, fallback: existing?.ttsPriceCnyPerMinute ?? 0, label: '合成价目' }),
      ...limits(this.cfg),
    }
  }
}
