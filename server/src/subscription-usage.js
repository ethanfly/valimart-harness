/**
 * 向各订阅平台的官方客户端用量接口发起实时查询。
 * 只返回额度字段的稳定子集；令牌和原始响应始终留在服务端。
 */
import { decodeJwtPayload } from './oauth-tokens.js'

const XAI_CLI_PROXY = 'https://cli-chat-proxy.grok.com/v1'
const GOOGLE_CODE_ASSIST = 'https://cloudcode-pa.googleapis.com/v1internal'
const GOOGLE_ANTIGRAVITY = 'https://daily-cloudcode-pa.googleapis.com/v1internal'
const XAI_GROK_BUILD_VERSION = '1.0.45'

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function number(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return undefined
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  const result = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(result) ? result : undefined
}

function resetTime(value) {
  const n = number(value)
  if (n !== undefined && n > 0) {
    const ms = n < 100_000_000_000 ? n * 1000 : n
    const date = new Date(ms)
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
  }
  if (typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value))) return new Date(value).toISOString()
  return undefined
}

function percent(value, { fraction = false } = {}) {
  const n = number(value)
  if (n === undefined) return undefined
  const result = fraction ? n * 100 : n
  return Math.max(0, Math.min(100, result))
}

function safeErrorText(value) {
  return String(value ?? '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 240)
}

async function getJson(fetchImpl, url, { method = 'GET', headers = {}, body, signal } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: { accept: 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ?? AbortSignal.timeout(15_000),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const upstreamMessage = asObject(asObject(data).error).message ?? asObject(data).message
    const suffix = upstreamMessage ? `：${safeErrorText(upstreamMessage)}` : ''
    throw new Error(`官方接口返回 HTTP ${response.status}${suffix}`)
  }
  return asObject(data)
}

function metric(label, remainingPercent, resetAt, detail) {
  return {
    label,
    ...(remainingPercent !== undefined ? { remainingPercent } : {}),
    ...(resetAt ? { resetAt } : {}),
    ...(detail ? { detail } : {}),
  }
}

function remainingFractionMetric(label, value, reset, detail) {
  const remainingPercent = percent(value, { fraction: true })
  return remainingPercent === undefined ? null : metric(label, remainingPercent, resetTime(reset), detail)
}

function chatgptWindowLabel(name, window) {
  const seconds = number(window?.limit_window_seconds ?? window?.limitWindowSeconds)
  if (seconds && seconds < 48 * 60 * 60) return `${Math.round(seconds / 3600)} 小时窗口`
  if (seconds && seconds >= 48 * 60 * 60) return `${Math.round(seconds / 86400)} 天窗口`
  return name === 'primary_window' ? '主要额度窗口' : '次要额度窗口'
}

async function queryChatGPT(account, fetchImpl) {
  const token = String(account.credential ?? '').trim()
  const accountId = account.chatgptAccountId || decodeJwtPayload(token)?.['https://api.openai.com/auth']?.chatgpt_account_id
  if (!token) throw new Error('该账号没有可用的 OAuth 访问令牌')
  if (!accountId) throw new Error('令牌中没有 ChatGPT-Account-Id，无法查询订阅用量')
  const data = await getJson(fetchImpl, 'https://chatgpt.com/backend-api/wham/usage', {
    headers: {
      authorization: `Bearer ${token}`,
      'chatgpt-account-id': String(accountId),
      'openai-beta': 'codex-1',
      originator: 'codex_cli_rs',
    },
  })
  const rateLimit = asObject(data.rate_limit ?? asObject(data.rate_limits).rate_limit ?? data.rateLimits)
  const metrics = []
  for (const key of ['primary_window', 'secondary_window', 'tertiary_window']) {
    const window = asObject(rateLimit[key])
    const used = percent(window.used_percent ?? window.usedPercent)
    if (used !== undefined) metrics.push(metric(chatgptWindowLabel(key, window), 100 - used, resetTime(window.reset_at ?? window.resetAt)))
  }
  for (const item of Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : []) {
    const extra = asObject(asObject(item).rate_limit)
    for (const key of ['primary_window', 'secondary_window']) {
      const window = asObject(extra[key])
      const used = percent(window.used_percent ?? window.usedPercent)
      if (used !== undefined) metrics.push(metric(`${item.limit_name || item.metered_feature || '额外额度'} · ${chatgptWindowLabel(key, window)}`, 100 - used, resetTime(window.reset_at ?? window.resetAt)))
    }
  }
  const individual = asObject(asObject(data.spend_control).individual_limit)
  const spendRemaining = percent(individual.remaining_percent ?? individual.remainingPercent)
  if (spendRemaining !== undefined) {
    const remaining = individual.remaining != null ? `剩余 ${individual.remaining}` : undefined
    metrics.push(metric('消费上限', spendRemaining, resetTime(individual.reset_at ?? individual.resetAt), remaining))
  }
  if (!metrics.length) throw new Error('官方接口已响应，但没有返回可识别的订阅额度窗口')
  return { plan: data.plan_type ?? data.planType, metrics }
}

function claudeLabel(key) {
  if (key === 'five_hour') return '5 小时额度'
  if (key === 'seven_day') return '7 天额度'
  const specific = key.match(/^seven_day_(.+)$/)
  return specific ? `7 天 ${specific[1]} 额度` : key.replaceAll('_', ' ')
}

async function queryClaude(account, fetchImpl) {
  const token = String(account.credential ?? '').trim()
  if (!token) throw new Error('该账号没有可用的 OAuth 访问令牌')
  const data = await getJson(fetchImpl, 'https://api.anthropic.com/api/oauth/usage', {
    headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
  })
  const metrics = []
  for (const [key, value] of Object.entries(data)) {
    if (!/^(five_hour|seven_day(?:_[a-z0-9_-]+)?)$/i.test(key)) continue
    const window = asObject(value)
    const used = percent(window.utilization)
    if (used !== undefined) metrics.push(metric(claudeLabel(key), 100 - used, resetTime(window.resets_at ?? window.resetsAt)))
  }
  for (const entry of Array.isArray(data.limits) ? data.limits : []) {
    const limit = asObject(entry)
    const used = percent(limit.percent ?? limit.used_percentage ?? limit.utilization)
    if (used === undefined) continue
    const model = asObject(asObject(limit.scope).model).display_name
    const label = [limit.name ?? limit.display_name ?? limit.type ?? limit.kind, model].filter(Boolean).join(' · ') || '额外额度'
    metrics.push(metric(String(label), 100 - used, resetTime(limit.resets_at ?? limit.resetsAt)))
  }
  const extra = asObject(data.extra_usage)
  if (extra.enabled === true && extra.remaining != null) metrics.push(metric('额外用量余额', undefined, undefined, String(extra.remaining)))
  if (!metrics.length) throw new Error('官方接口已响应，但没有返回可识别的订阅额度窗口')
  return { metrics }
}

function cents(value) {
  if (value == null) return undefined
  const object = asObject(value)
  const raw = value && typeof value === 'object' ? object.val ?? (Object.keys(object).length ? undefined : 0) : value
  const result = number(raw)
  return result === undefined ? undefined : result
}

async function queryGrok(account, fetchImpl) {
  const token = String(account.credential ?? '').trim()
  if (!token) throw new Error('该账号没有可用的 OAuth 访问令牌')
  const claims = decodeJwtPayload(token) ?? {}
  const userId = account.xaiUserId ?? claims.sub ?? claims.user_id ?? claims.userId ?? claims.uid
  if (!userId) throw new Error('xAI OAuth 令牌没有可用于官方客户端计费接口的用户 ID')
  const data = await getJson(fetchImpl, `${XAI_CLI_PROXY}/billing?format=credits`, {
    headers: {
      authorization: `Bearer ${token}`,
      'x-xai-token-auth': 'xai-grok-cli',
      'x-userid': String(userId),
      'x-grok-client-version': XAI_GROK_BUILD_VERSION,
      'x-grok-client-identifier': 'grok-shell',
      'x-grok-client-mode': 'headless',
    },
  })
  const config = asObject(data.config)
  const metrics = []
  const usedPercent = percent(config.creditUsagePercent ?? config.credit_usage_percent)
  const period = asObject(config.currentPeriod ?? config.current_period)
  const periodType = String(period.type ?? period.periodType ?? '').toLowerCase()
  if (usedPercent !== undefined) {
    const label = periodType.includes('week') ? '每周订阅额度' : periodType.includes('month') ? '每月订阅额度' : '订阅额度'
    metrics.push(metric(label, 100 - usedPercent, resetTime(period.end ?? config.billingPeriodEnd ?? config.billing_period_end), `已用 ${usedPercent.toFixed(1)}%`))
  }
  const prepaid = cents(config.prepaidBalance ?? config.prepaid_balance)
  if (prepaid !== undefined) metrics.push(metric('预付余额', undefined, undefined, `$${(prepaid / 100).toFixed(2)} USD`))
  const onDemandCap = cents(config.onDemandCap ?? config.on_demand_cap)
  const onDemandUsed = cents(config.onDemandUsed ?? config.on_demand_used)
  if (onDemandCap !== undefined && onDemandUsed !== undefined) {
    const remaining = Math.max(0, onDemandCap - onDemandUsed)
    metrics.push(metric('按需额度', undefined, resetTime(period.end), `$${(remaining / 100).toFixed(2)} / $${(onDemandCap / 100).toFixed(2)} USD`))
  }
  if (!metrics.length) throw new Error('官方接口已响应，但没有返回可识别的订阅额度字段')
  return { plan: data.subscriptionTier ?? data.subscription_tier, metrics }
}

function googleHeaders(account, api) {
  const token = String(account.credential ?? '').trim()
  if (!token) throw new Error('该账号没有可用的 OAuth 访问令牌')
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    ...(api === 'antigravity' ? { 'user-agent': 'antigravity' } : {}),
  }
}

function projectIdFrom(value) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  const object = asObject(value)
  const id = object.id ?? object.projectId ?? object.project_id
  return typeof id === 'string' && id.trim() ? id.trim() : undefined
}

async function googleQuota(channelId, account, fetchImpl, cfg) {
  const api = channelId === 'antigravity' ? 'antigravity' : 'gemini-code-assist'
  const headers = googleHeaders(account, api)
  let projectId = account.googleProjectId
    || projectIdFrom(cfg.oauth?.[channelId]?.projectId)
    || projectIdFrom(cfg.oauth?.[channelId]?.project)
  if (channelId === 'antigravity' && !projectId) {
    const metadata = { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }
    const loaded = await getJson(fetchImpl, `${GOOGLE_CODE_ASSIST}:loadCodeAssist`, { method: 'POST', headers, body: { metadata } })
    projectId = projectIdFrom(loaded.cloudaicompanionProject ?? loaded.cloudaicompanion_project)
    if (!projectId) throw new Error('Google 没有为此 Antigravity 账号返回项目 ID，无法查询官方用量')
  }
  if (channelId === 'gemini' && !projectId) throw new Error('该 Gemini Code Assist 账号没有项目 ID，无法查询官方用量')

  if (channelId === 'antigravity') {
    const data = await getJson(fetchImpl, `${GOOGLE_ANTIGRAVITY}:retrieveUserQuotaSummary`, {
      method: 'POST', headers, body: { project: projectId },
    })
    const summary = asObject(data.response ?? data)
    const groups = Array.isArray(summary.groups) ? summary.groups : Array.isArray(summary.quotaGroups) ? summary.quotaGroups : []
    const metrics = groups.flatMap((rawGroup) => {
      const group = asObject(rawGroup)
      const groupName = group.displayName ?? group.name ?? group.id ?? '用量池'
      const buckets = Array.isArray(group.buckets) ? group.buckets : []
      return buckets.map((rawBucket) => {
        const bucket = asObject(rawBucket)
        const label = bucket.displayName ?? bucket.bucketId ?? bucket.id ?? '额度窗口'
        const remaining = asObject(bucket.remaining)
        const cadence = bucket.window ? ` · ${bucket.window}` : ''
        const result = remainingFractionMetric(`${groupName} · ${label}${cadence}`, bucket.remainingFraction ?? bucket.remaining_fraction ?? remaining.remainingFraction ?? remaining.remaining_fraction, bucket.resetTime ?? bucket.reset_time, bucket.description)
        return result
      }).filter(Boolean)
    })
    if (!metrics.length && Array.isArray(summary.buckets)) {
      for (const rawBucket of summary.buckets) {
        const bucket = asObject(rawBucket)
        const remaining = asObject(bucket.remaining)
        const label = bucket.displayName ?? bucket.modelId ?? bucket.model_id ?? bucket.bucketId ?? 'Antigravity 额度'
        const result = remainingFractionMetric(String(label), bucket.remainingFraction ?? bucket.remaining_fraction ?? remaining.remainingFraction ?? remaining.remaining_fraction, bucket.resetTime ?? bucket.reset_time, bucket.description)
        if (result) metrics.push(result)
      }
    }
    if (!metrics.length) throw new Error('官方接口已响应，但没有返回可识别的 Antigravity 额度窗口')
    return { plan: summary.userTier?.name ?? summary.user_tier?.name ?? summary.paidTier?.name ?? data.userTier?.name ?? data.user_tier?.name ?? data.paidTier?.name, metrics }
  }

  const data = await getJson(fetchImpl, `${GOOGLE_CODE_ASSIST}:retrieveUserQuota`, {
    method: 'POST', headers, body: { project: projectId },
  })
  const buckets = Array.isArray(data.buckets) ? data.buckets : []
  const metrics = buckets.map((rawBucket) => {
    const bucket = asObject(rawBucket)
    const model = bucket.modelId ?? bucket.model_id
    const tokenType = bucket.tokenType ?? bucket.token_type
    const label = [model, tokenType].filter(Boolean).join(' · ') || 'Google 额度'
    const detail = bucket.remainingAmount ?? bucket.remaining_amount
    const result = remainingFractionMetric(label, bucket.remainingFraction ?? bucket.remaining_fraction, bucket.resetTime ?? bucket.reset_time, detail != null ? `剩余 ${detail}${tokenType === 'REQUESTS' ? ' 次' : ''}` : undefined)
    if (result) return result
    return detail != null ? metric(label, undefined, resetTime(bucket.resetTime ?? bucket.reset_time), `剩余 ${detail}${tokenType === 'REQUESTS' ? ' 次' : ''}`) : null
  }).filter(Boolean)
  if (!metrics.length) throw new Error('官方接口已响应，但没有返回可识别的 Gemini 额度窗口')
  return { metrics }
}

/** 读取单个订阅账号的官方实时用量；返回的 checkedAt 对应本次网络查询。 */
export async function queryOfficialSubscriptionUsage({ channelId, account, fetchImpl = fetch, cfg = {} } = {}) {
  let usage
  if (channelId === 'chatgpt') usage = await queryChatGPT(account, fetchImpl)
  else if (channelId === 'claude') usage = await queryClaude(account, fetchImpl)
  else if (channelId === 'grok') usage = await queryGrok(account, fetchImpl)
  else if (channelId === 'gemini' || channelId === 'antigravity') usage = await googleQuota(channelId, account, fetchImpl, cfg)
  else throw new Error('该订阅平台暂不支持官方额度查询')
  return { status: 'ok', checkedAt: new Date().toISOString(), ...usage }
}
