/**
 * 模型通道（设置 → 同事 里的「通道 / 种类 / 状态」表）：
 *   - 种类 subscription（订阅：Grok / ChatGPT / Claude 这类按账号订阅的通道）或 key（按 API key 接入）
 *   - 状态 已接 / 未接：config.json 里配好密钥的上游算「已接」；管理员也可以在界面上“加入订阅 / 加入模型”，
 *     凭据只落在服务端（默认 gateway.sqlite 的 channels.json 集合），绝不下发给客户端。
 *   - 同一通道可挂多个账号：额度用尽后 llm-proxy 切下一个。
 * 接入后的通道会合并进 cfg.upstreams，网关 /v1 目录随之更新（客户端下次同步就能选到新模型）。
 */
import crypto from 'node:crypto'
import { createPersistence } from './store.js'
import { inferUpstreamApi } from './upstream-anthropic.js'
import { accountIdFromToken, isOpenAiPublicApi } from './oauth-tokens.js'
import { chatgptProvider } from './oauth-providers/chatgpt.js'
import { ACCOUNT_EXHAUSTED_MINUTES } from './upstream-quota.js'
import { HttpError } from './http.js'

export const CHANNEL_KIND_LABELS = { subscription: '订阅', key: 'key' }

export class Channels {
  constructor(cfg, dataDir) {
    this.cfg = cfg
    this.persist = createPersistence(dataDir)
    this.store = this.persist.file('channels.json', () => ({ items: {}, custom: [] }))
    this.applyAll()
  }

  catalog() {
    const builtin = Array.isArray(this.cfg.channels) ? this.cfg.channels : []
    const custom = this.store.load().custom ?? []
    const seen = new Set(builtin.map((c) => c.id))
    return [...builtin, ...custom.filter((c) => c?.id && !seen.has(c.id))]
  }

  find(id) {
    const c = this.catalog().find((x) => x.id === id)
    if (!c) throw new HttpError(404, `未知通道 ${id}`, 'channel_not_found')
    return c
  }

  upstreamIdOf(channel) {
    return channel.upstream ?? channel.id
  }

  /** 把已接入通道合并进 cfg.upstreams（凭据仅内存 + 服务端库）。 */
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
    const accounts = accountsOf(item)
    const primary = pickPrimary(accounts) ?? item
    let baseUrl = item.baseUrl || existing?.baseUrl || channel.baseUrl
    let api = item.api ?? primary.api ?? channel.api ?? existing?.api ?? inferUpstreamApi(baseUrl)
    if (item.oauthProvider === 'chatgpt' || item.api === 'chatgpt-codex' || primary.api === 'chatgpt-codex') {
      api = 'chatgpt-codex'
      if (!baseUrl || isOpenAiPublicApi(baseUrl)) baseUrl = chatgptProvider.upstreamBaseUrl
    }
    const credential = primary.credential ?? item.credential
    this.cfg.upstreams[upstreamId] = {
      ...(existing ?? {}),
      id: upstreamId,
      kind: 'openai-compatible',
      api,
      label: channel.custom ? channel.label : existing?.label ?? channel.label,
      baseUrl,
      resolvedKey: credential,
      authStyle: primary.authStyle ?? item.authStyle ?? existing?.authStyle,
      chatgptAccountId: primary.chatgptAccountId ?? item.chatgptAccountId ?? accountIdFromToken(credential) ?? existing?.chatgptAccountId,
      channel: channel.id,
      channelKind: channel.kind,
      accounts: accounts.map((a) => ({
        id: a.id,
        credential: a.credential,
        refreshToken: a.refreshToken,
        tokenExpiresAt: a.tokenExpiresAt,
        chatgptAccountId: a.chatgptAccountId,
        authStyle: a.authStyle ?? item.authStyle,
        api: a.api ?? item.api,
        status: a.status,
        exhaustedUntil: a.exhaustedUntil,
      })),
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
      const accounts = runtime ? publicAccounts(accountsOf(runtime)) : []
      return {
        id: c.id,
        label: c.label,
        kind: c.kind,
        kindLabel: CHANNEL_KIND_LABELS[c.kind] ?? c.kind,
        baseUrl: runtime?.baseUrl ?? up?.baseUrl ?? c.baseUrl ?? '',
        hint: c.hint ?? '',
        custom: !!c.custom,
        contextWindow: c.contextWindow ?? null,
        maxTokens: c.maxTokens ?? null,
        reasoningEfforts: c.reasoningEfforts ?? null,
        connected,
        statusLabel: connected ? (accounts.length > 1 ? `已接 · ${accounts.length} 个账号` : '已接') : '未接',
        source: runtime ? 'runtime' : connected ? 'config' : null,
        modelCount: connected ? (up?.models ?? []).length : 0,
        models: connected ? (up?.models ?? []).map((m) => m.id) : [],
        modelDetails: connected ? (up?.models ?? []).map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens, reasoningEfforts: m.reasoningEfforts })) : [],
        connectedAt: runtime?.connectedAt ?? null,
        connectedBy: runtime?.connectedBy ?? null,
        accountCount: accounts.length,
        accounts,
      }
    })
  }

  /**
   * 接入通道：保存凭据（服务端）、模型列表，并立刻合并进上游目录。
   * 同一通道再次接入不同账号时追加，不覆盖。
   */
  connect(id, input, user) {
    const channel = this.find(id)
    const credential = String(input.credential ?? '').trim()
    if (!credential) throw new HttpError(400, channel.kind === 'subscription' ? '请粘贴订阅凭据（订阅账号的访问令牌）' : '请填写 API key')
    const models = normalizeModels(input.models)
    if (models.length === 0) throw new HttpError(400, '至少填写一个模型 id（逗号分隔），或先拉取模型列表')
    const baseUrl = String(input.baseUrl ?? '').trim() || channel.baseUrl
    if (!/^https?:\/\//.test(baseUrl)) throw new HttpError(400, 'baseUrl 必须是 http(s) 地址')
    const existing = this.store.load().items[id]
    const account = makeAccount(input, user)
    const prev = existing ? accountsOf(existing) : []
    const idx = prev.findIndex((a) => a.identity === account.identity || a.credential === account.credential)
    const accounts = [...prev]
    if (idx >= 0) accounts[idx] = { ...accounts[idx], ...account, id: accounts[idx].id, status: 'active', exhaustedUntil: null, lastError: null }
    else accounts.push(account)
    const item = persistItem(
      {
        ...(existing ?? {}),
        baseUrl,
        models,
        oauthProvider: input.oauthProvider ?? existing?.oauthProvider,
        authStyle: input.authStyle ?? existing?.authStyle,
        api: input.api ?? existing?.api,
      },
      accounts,
    )
    this.store.update((d) => {
      d.items[id] = item
    })
    this.applyOne(channel, item)
    return this.view().find((c) => c.id === id)
  }

  createCustom(input, user) {
    const label = String(input.label ?? '').trim()
    if (!label) throw new HttpError(400, '请填写端点名称')
    const baseUrl = String(input.baseUrl ?? '').trim()
    if (!/^https?:\/\//.test(baseUrl)) throw new HttpError(400, 'baseUrl 必须是 http(s) 地址')
    let id = String(input.id ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
    if (!id) {
      const slug = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 24)
      id = `custom-${slug || crypto.randomBytes(3).toString('hex')}`
    }
    if (this.catalog().some((c) => c.id === id)) throw new HttpError(409, `通道 ${id} 已存在`, 'channel_exists')
    const def = {
      id,
      label,
      kind: 'key',
      baseUrl,
      hint: String(input.hint ?? ''),
      api: input.api || inferUpstreamApi(baseUrl),
      reasoningEfforts: input.reasoningEfforts,
      contextWindow: input.contextWindow,
      maxTokens: input.maxTokens,
      custom: true,
    }
    this.store.update((d) => {
      d.custom = [...(d.custom ?? []), def]
    })
    if (String(input.credential ?? '').trim()) return this.connect(id, { ...input, baseUrl }, user)
    return this.view().find((c) => c.id === id)
  }

  removeCustom(id) {
    const channel = this.find(id)
    if (!channel.custom) throw new HttpError(409, '只能删除自定义端点', 'not_custom')
    const items = this.store.load().items
    if (items[id]) this.disconnect(id)
    this.store.update((d) => {
      d.custom = (d.custom ?? []).filter((c) => c.id !== id)
    })
    return { ok: true, id }
  }

  /** 改已接入通道的模型/上下文，不碰凭据。配置文件接入的通道不能在这里改。 */
  update(id, input = {}) {
    const existing = this.store.load().items[id]
    if (!existing) throw new HttpError(409, '该通道尚未接入或由配置文件接入，无法在界面编辑', 'channel_not_runtime')
    const channel = this.find(id)
    const models = input.models !== undefined ? normalizeModels(input.models) : normalizeModels(existing.models)
    if (models.length === 0) throw new HttpError(400, '至少保留一个模型 id')
    const nextBase = input.baseUrl !== undefined ? String(input.baseUrl).trim() || channel.baseUrl : existing.baseUrl || channel.baseUrl
    if (nextBase && !/^https?:\/\//.test(nextBase)) throw new HttpError(400, 'baseUrl 必须是 http(s) 地址')
    if (channel.custom && (input.label !== undefined || input.baseUrl !== undefined)) {
      const label = input.label !== undefined ? String(input.label).trim() : channel.label
      if (!label) throw new HttpError(400, '请填写端点名称')
      this.store.update((d) => {
        d.custom = (d.custom ?? []).map((c) => (c.id === id ? { ...c, label, baseUrl: nextBase || c.baseUrl } : c))
      })
    }
    const item = persistItem({ ...existing, models, baseUrl: nextBase }, accountsOf(existing))
    this.store.update((d) => {
      d.items[id] = item
    })
    this.applyOne(this.find(id), item)
    return this.view().find((c) => c.id === id)
  }

  /** 续期后只改令牌字段，不碰模型列表。 */
  updateTokens(id, patch = {}, accountId) {
    const channel = this.find(id)
    const current = this.store.load().items[id]
    if (!current) throw new HttpError(404, `通道 ${id} 尚未接入`, 'channel_not_connected')
    this.store.update((d) => {
      const item = d.items[id]
      const accounts = accountsOf(item)
      const acc = accountId ? accounts.find((a) => a.id === accountId) : accounts[0]
      const apply = (target) => {
        if (patch.credential) target.credential = String(patch.credential)
        if (patch.refreshToken) target.refreshToken = String(patch.refreshToken)
        if (patch.tokenExpiresAt) target.tokenExpiresAt = String(patch.tokenExpiresAt)
        if (patch.chatgptAccountId) target.chatgptAccountId = String(patch.chatgptAccountId)
      }
      if (acc) {
        apply(acc)
        acc.status = 'active'
        acc.exhaustedUntil = null
        acc.lastError = null
      }
      apply(item)
      const next = persistItem(item, accounts)
      Object.assign(item, next)
    })
    this.applyOne(channel, this.store.load().items[id])
    return this.view().find((c) => c.id === id)
  }

  markAccountExhausted(id, accountId, { error, minutes = ACCOUNT_EXHAUSTED_MINUTES } = {}) {
    const channel = this.catalog().find((x) => x.id === id)
    if (!channel) return null
    const until = new Date(Date.now() + minutes * 60 * 1000).toISOString()
    this.store.update((d) => {
      const item = d.items[id]
      if (!item) return
      const accounts = accountsOf(item)
      const acc = accounts.find((a) => a.id === accountId)
      if (!acc) return
      acc.status = 'exhausted'
      acc.exhaustedUntil = until
      acc.lastError = error ? String(error).slice(0, 240) : acc.lastError
      Object.assign(item, persistItem(item, accounts))
    })
    const item = this.store.load().items[id]
    if (item) this.applyOne(channel, item)
    return this.view().find((c) => c.id === id)
  }

  /** 断开界面上接入的通道（config.json 配的密钥不在此处断开）。accountId 只摘一个账号。 */
  disconnect(id, { accountId } = {}) {
    const channel = this.find(id)
    const items = this.store.load().items
    if (!items[id]) throw new HttpError(409, '该通道由服务端配置文件接入，请在 config.json / 环境变量里移除密钥', 'channel_from_config')
    if (accountId) {
      const accounts = accountsOf(items[id]).filter((a) => a.id !== accountId)
      if (accounts.length) {
        const item = persistItem(items[id], accounts)
        this.store.update((d) => {
          d.items[id] = item
        })
        this.applyOne(channel, item)
        return this.view().find((c) => c.id === id)
      }
    }
    this.store.update((d) => {
      delete d.items[id]
    })
    const upstreamId = this.upstreamIdOf(channel)
    const up = this.cfg.upstreams?.[upstreamId]
    if (up && up.channel === id) {
      up.resolvedKey = undefined
      delete up.channel
      delete up.accounts
    }
    return this.view().find((c) => c.id === id)
  }
}

const BRAND_WORDS = { gpt: 'GPT', deepseek: 'DeepSeek', chatgpt: 'ChatGPT', openai: 'OpenAI', xai: 'xAI' }

/** 把模型 id 变成菜单里的展示名：grok-4.6-fast → Grok 4.6 Fast，claude-opus-4-6 → Claude Opus 4.6。 */
export function prettyModelName(id) {
  const words = []
  for (const p of String(id).split(/[-_]/).filter(Boolean)) {
    if (/^\d+$/.test(p) && words.length && /^\d+(\.\d+)*$/.test(words[words.length - 1])) {
      words[words.length - 1] += `.${p}`
      continue
    }
    words.push(p)
  }
  return words.map((w) => BRAND_WORDS[w.toLowerCase()] ?? (/^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ')
}

export function normalizeModels(input) {
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
    contextWindow: m.contextWindow ?? channel.contextWindow ?? 200000,
    maxTokens: m.maxTokens ?? channel.maxTokens ?? 32000,
    reasoningEfforts: m.reasoningEfforts ?? channel.reasoningEfforts ?? false,
    priceCnyPerM: m.priceCnyPerM ?? { input: 0, output: 0, cachedInput: 0 },
  }
}

export function accountIdentity(input) {
  if (input.chatgptAccountId) return `acct:${input.chatgptAccountId}`
  const cred = String(input.credential ?? '')
  return `cred:${crypto.createHash('sha256').update(cred).digest('hex').slice(0, 16)}`
}

export function accountsOf(item) {
  if (!item) return []
  if (Array.isArray(item.accounts) && item.accounts.length) return item.accounts.map((a) => ({ ...a }))
  if (item.credential) {
    return [
      {
        id: item.accountId || 'primary',
        label: item.accountLabel || '账号 1',
        identity: accountIdentity(item),
        credential: item.credential,
        refreshToken: item.refreshToken,
        tokenExpiresAt: item.tokenExpiresAt,
        chatgptAccountId: item.chatgptAccountId,
        oauthProvider: item.oauthProvider,
        authStyle: item.authStyle,
        api: item.api,
        status: item.status || 'active',
        exhaustedUntil: item.exhaustedUntil ?? null,
        lastError: item.lastError ?? null,
        connectedAt: item.connectedAt,
        connectedBy: item.connectedBy,
      },
    ]
  }
  return []
}

export function pickPrimary(accounts, now = Date.now()) {
  if (!accounts?.length) return null
  return (
    accounts.find((a) => a.status !== 'exhausted' || (a.exhaustedUntil && Date.parse(a.exhaustedUntil) <= now)) ?? accounts[0]
  )
}

function makeAccount(input, user) {
  const chatgptAccountId = input.chatgptAccountId || accountIdFromToken(input.credential)
  return {
    id: String(input.accountId ?? '').trim() || crypto.randomBytes(6).toString('hex'),
    label: String(input.accountLabel ?? '').trim() || `账号 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    identity: accountIdentity({ ...input, chatgptAccountId }),
    credential: String(input.credential).trim(),
    refreshToken: input.refreshToken ? String(input.refreshToken) : undefined,
    tokenExpiresAt: input.tokenExpiresAt,
    chatgptAccountId,
    oauthProvider: input.oauthProvider,
    authStyle: input.authStyle,
    api: input.api,
    status: 'active',
    exhaustedUntil: null,
    lastError: null,
    connectedAt: new Date().toISOString(),
    connectedBy: user?.username ?? null,
  }
}

function persistItem(shared, accounts) {
  const primary = pickPrimary(accounts)
  return {
    ...shared,
    accounts,
    credential: primary?.credential,
    refreshToken: primary?.refreshToken,
    tokenExpiresAt: primary?.tokenExpiresAt,
    chatgptAccountId: primary?.chatgptAccountId,
    connectedAt: primary?.connectedAt ?? shared.connectedAt,
    connectedBy: primary?.connectedBy ?? shared.connectedBy,
  }
}

function publicAccounts(accounts) {
  return accounts.map((a) => ({
    id: a.id,
    label: a.label,
    status: a.status || 'active',
    exhaustedUntil: a.exhaustedUntil ?? null,
    connectedAt: a.connectedAt ?? null,
    connectedBy: a.connectedBy ?? null,
    chatgptAccountId: a.chatgptAccountId ?? null,
  }))
}
