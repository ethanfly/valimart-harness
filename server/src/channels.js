/**
 * 模型通道（设置 → 同事 里的「通道 / 种类 / 状态」表）：
 *   - 种类 subscription（订阅：Grok / ChatGPT / Claude 这类按账号订阅的通道）或 key（按 API key 接入）
 *   - 状态 已接 / 未接：config.json 里配好密钥的上游算「已接」；管理员也可以在界面上“加入订阅 / 加入模型”，
 *     凭据只落在服务端 data/channels.json，绝不下发给客户端。
 * 接入后的通道会合并进 cfg.upstreams，网关 /v1 目录随之更新（客户端下次同步就能选到新模型）。
 */
import path from 'node:path'
import { JsonFile } from './store.js'
import { HttpError } from './http.js'

export const CHANNEL_KIND_LABELS = { subscription: '订阅', key: 'key' }

export class Channels {
  constructor(cfg, dataDir) {
    this.cfg = cfg
    this.store = new JsonFile(path.join(dataDir, 'channels.json'), () => ({ items: {} }))
    this.applyAll()
  }

  catalog() {
    return Array.isArray(this.cfg.channels) ? this.cfg.channels : []
  }

  find(id) {
    const c = this.catalog().find((x) => x.id === id)
    if (!c) throw new HttpError(404, `未知通道 ${id}`, 'channel_not_found')
    return c
  }

  upstreamIdOf(channel) {
    return channel.upstream ?? channel.id
  }

  /** 把 data/channels.json 里接入的通道合并进 cfg.upstreams（凭据仅内存 + 服务端文件）。 */
  applyAll() {
    for (const [id, item] of Object.entries(this.store.load().items)) {
      const channel = this.catalog().find((x) => x.id === id)
      if (channel) this.applyOne(channel, item)
    }
  }

  applyOne(channel, item) {
    const upstreamId = this.upstreamIdOf(channel)
    this.cfg.upstreams ??= {}
    const existing = this.cfg.upstreams[upstreamId]
    this.cfg.upstreams[upstreamId] = {
      ...(existing ?? {}),
      id: upstreamId,
      kind: 'openai-compatible',
      label: existing?.label ?? channel.label,
      baseUrl: item.baseUrl || existing?.baseUrl || channel.baseUrl,
      resolvedKey: item.credential,
      channel: channel.id,
      channelKind: channel.kind,
      // 展示名/推理档位等默认值在加载时补齐（grok-4.6-fast → Grok 4.6 Fast），不固化进 data/channels.json
      models: (item.models?.length ? item.models : existing?.models ?? []).map((m) => withModelDefaults(m, channel)),
    }
  }

  /** 对外视图（不含凭据）。 */
  view() {
    const items = this.store.load().items
    return this.catalog().map((c) => {
      const up = this.cfg.upstreams?.[this.upstreamIdOf(c)]
      const connected = !!(up && (up.kind === 'mock' || up.resolvedKey))
      const runtime = items[c.id]
      return {
        id: c.id,
        label: c.label,
        kind: c.kind,
        kindLabel: CHANNEL_KIND_LABELS[c.kind] ?? c.kind,
        baseUrl: runtime?.baseUrl ?? up?.baseUrl ?? c.baseUrl ?? '',
        hint: c.hint ?? '',
        connected,
        statusLabel: connected ? '已接' : '未接',
        source: runtime ? 'runtime' : connected ? 'config' : null,
        modelCount: connected ? (up?.models ?? []).length : 0,
        models: connected ? (up?.models ?? []).map((m) => m.id) : [],
        connectedAt: runtime?.connectedAt ?? null,
        connectedBy: runtime?.connectedBy ?? null,
      }
    })
  }

  /**
   * 接入通道：保存凭据（服务端）、模型列表，并立刻合并进上游目录。
   * @param {string} id 通道 id
   * @param {{ credential: string, baseUrl?: string, models?: string | Array<string | {id: string, name?: string}> }} input
   */
  connect(id, input, user) {
    const channel = this.find(id)
    const credential = String(input.credential ?? '').trim()
    if (!credential) throw new HttpError(400, channel.kind === 'subscription' ? '请粘贴订阅凭据（订阅账号的访问令牌）' : '请填写 API key')
    const models = normalizeModels(input.models)
    if (models.length === 0) throw new HttpError(400, '至少填写一个模型 id（逗号分隔）')
    const baseUrl = String(input.baseUrl ?? '').trim() || channel.baseUrl
    if (!/^https?:\/\//.test(baseUrl)) throw new HttpError(400, 'baseUrl 必须是 http(s) 地址')
    const item = { baseUrl, credential, models, connectedAt: new Date().toISOString(), connectedBy: user?.username ?? null }
    this.store.update((d) => {
      d.items[id] = item
    })
    this.applyOne(channel, item)
    return this.view().find((c) => c.id === id)
  }

  /** 断开界面上接入的通道（config.json 配的密钥不在此处断开）。 */
  disconnect(id) {
    const channel = this.find(id)
    const items = this.store.load().items
    if (!items[id]) throw new HttpError(409, '该通道由服务端配置文件接入，请在 config.json / 环境变量里移除密钥', 'channel_from_config')
    this.store.update((d) => {
      delete d.items[id]
    })
    const upstreamId = this.upstreamIdOf(channel)
    const up = this.cfg.upstreams?.[upstreamId]
    if (up && up.channel === id) {
      // 恢复成“未接”：保留上游定义但清掉凭据，目录会自动把它的模型隐藏
      up.resolvedKey = undefined
      delete up.channel
    }
    return this.view().find((c) => c.id === id)
  }
}

const BRAND_WORDS = { gpt: 'GPT', deepseek: 'DeepSeek', chatgpt: 'ChatGPT', openai: 'OpenAI', xai: 'xAI' }

/** 把模型 id 变成菜单里的展示名：grok-4.6-fast → Grok 4.6 Fast，claude-opus-4-6 → Claude Opus 4.6。 */
export function prettyModelName(id) {
  const words = []
  for (const p of String(id).split(/[-_]/).filter(Boolean)) {
    // 连续的纯数字段合成版本号：4-6 → 4.6
    if (/^\d+$/.test(p) && words.length && /^\d+(\.\d+)*$/.test(words[words.length - 1])) {
      words[words.length - 1] += `.${p}`
      continue
    }
    words.push(p)
  }
  return words.map((w) => BRAND_WORDS[w.toLowerCase()] ?? (/^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ')
}

/** 只保留用户明确给出的字段；默认值由 withModelDefaults 在加载时补齐。 */
function normalizeModels(input) {
  let list = []
  if (Array.isArray(input)) list = input
  else if (typeof input === 'string') list = input.split(/[,\n，]/)
  const out = []
  const seen = new Set()
  for (const raw of list) {
    const m = typeof raw === 'string' ? { id: raw.trim() } : { ...raw, id: String(raw?.id ?? '').trim() }
    if (!m.id || seen.has(m.id)) continue
    seen.add(m.id)
    const entry = { id: m.id }
    for (const k of ['name', 'contextWindow', 'maxTokens', 'reasoningEfforts', 'priceCnyPerM']) if (m[k] !== undefined && m[k] !== null && m[k] !== '') entry[k] = m[k]
    out.push(entry)
  }
  return out
}

function withModelDefaults(m, channel) {
  return {
    ...m,
    name: m.name ?? prettyModelName(m.id),
    contextWindow: m.contextWindow ?? 200000,
    maxTokens: m.maxTokens ?? 32000,
    reasoningEfforts: m.reasoningEfforts ?? channel.reasoningEfforts ?? false,
    priceCnyPerM: m.priceCnyPerM ?? { input: 0, output: 0, cachedInput: 0 },
  }
}
