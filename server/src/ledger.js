/**
 * 用量账本与周额度。
 * - 每次模型请求记一条流水（按人、按模型、按上游），费用按本地价目表估算（不是上游账单）。
 * - 周额度：以 quota.anchor 为锚点，每 7 天刷新一次；按角色可覆盖默认额度。
 */

const WEEK_MS = 7 * 86400_000

export function weekWindow(anchorIso, now = Date.now()) {
  const anchor = Date.parse(anchorIso)
  const base = Number.isFinite(anchor) ? anchor : 0
  const elapsed = now - base
  const index = Math.floor(elapsed / WEEK_MS)
  const start = base + index * WEEK_MS
  return { start, end: start + WEEK_MS, refreshAt: new Date(start + WEEK_MS).toISOString() }
}

export function estimateCostCny(model, usage) {
  if (!model || !usage) return 0
  const price = model.priceCnyPerM ?? {}
  const prompt = usage.prompt_tokens ?? 0
  const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0
  const fresh = Math.max(0, prompt - cached)
  const completion = usage.completion_tokens ?? 0
  const cost = (fresh * (price.input ?? 0) + cached * (price.cachedInput ?? price.input ?? 0) + completion * (price.output ?? 0)) / 1_000_000
  return Math.round(cost * 1_000_000) / 1_000_000
}

export class Ledger {
  constructor(db, cfg) {
    this.db = db
    this.cfg = cfg
  }

  record(entry) {
    const item = { ts: new Date().toISOString(), ...entry }
    this.db.usage.append(item)
    return item
  }

  entriesSince(sinceMs, filter = () => true) {
    return this.db.usage.readAll().filter((e) => Date.parse(e.ts) >= sinceMs && filter(e))
  }

  weeklyLimitCny(user) {
    const company = this.db.companySettings()
    const byRole = { ...(this.cfg.quota?.byRole ?? {}), ...(company.quotaByRole ?? {}) }
    const perUser = this.db.userSettings(user.id).weeklyQuotaCny
    if (typeof perUser === 'number') return perUser
    if (typeof byRole[user.role] === 'number') return byRole[user.role]
    return company.weeklyQuotaCny ?? this.cfg.quota?.weeklyCny ?? 200
  }

  quotaAnchor() {
    return this.db.companySettings().quotaAnchor ?? this.cfg.quota?.anchor ?? '2026-01-05T00:00:00+08:00'
  }

  /** 某用户当前周期内按上游分组的用量与额度视图。 */
  quotaView(user, providers) {
    const win = weekWindow(this.quotaAnchor())
    const entries = this.entriesSince(win.start, (e) => e.userId === user.id)
    const limit = this.weeklyLimitCny(user)
    const out = []
    for (const p of providers) {
      const used = entries.filter((e) => e.provider === p.id).reduce((s, e) => s + (e.costCny ?? 0), 0)
      const usedPct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0
      out.push({
        provider: p.id,
        label: p.label ?? p.id,
        usedCny: round4(used),
        limitCny: limit,
        usedPct: round1(usedPct),
        remainingPct: round1(Math.max(0, 100 - usedPct)),
        refreshAt: win.refreshAt,
      })
    }
    return out
  }

  /** 是否超过本周额度（按上游）。 */
  exceeded(user, providerId) {
    const win = weekWindow(this.quotaAnchor())
    const limit = this.weeklyLimitCny(user)
    if (!(limit > 0)) return false
    const used = this.entriesSince(win.start, (e) => e.userId === user.id && e.provider === providerId).reduce((s, e) => s + (e.costCny ?? 0), 0)
    return used >= limit
  }

  /** 近 N 天公司账本（全员）。 */
  companyLedger(days = 7) {
    const since = Date.now() - days * 86400_000
    const entries = this.entriesSince(since)
    const byModel = new Map()
    const byUser = new Map()
    let total = 0
    for (const e of entries) {
      total += e.costCny ?? 0
      const key = `${e.provider}/${e.model}`
      const m = byModel.get(key) ?? { model: e.model, provider: e.provider, requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costCny: 0 }
      m.requests++
      m.promptTokens += e.promptTokens ?? 0
      m.completionTokens += e.completionTokens ?? 0
      m.cachedTokens += e.cachedTokens ?? 0
      m.costCny += e.costCny ?? 0
      byModel.set(key, m)
      byUser.set(e.userId, (byUser.get(e.userId) ?? 0) + (e.costCny ?? 0))
    }
    return {
      days,
      totalCny: round4(total),
      requests: entries.length,
      byModel: [...byModel.values()].map((m) => ({ ...m, costCny: round4(m.costCny) })).sort((a, b) => b.costCny - a.costCny),
      byUser: Object.fromEntries([...byUser.entries()].map(([k, v]) => [k, round4(v)])),
    }
  }
}

export function round2(n) {
  return Math.round(n * 100) / 100
}
export function round4(n) {
  return Math.round(n * 10000) / 10000
}
export function round1(n) {
  return Math.round(n * 10) / 10
}
