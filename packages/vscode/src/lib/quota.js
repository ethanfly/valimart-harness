/**
 * Normalize login / GET /api/auth/me quota rows into used / limit / remaining.
 */
export function summarizeQuota(quota) {
  const list = Array.isArray(quota) ? quota : []
  return list.map((e) => {
    const kind = e.kind ?? (e.limitTokens ? 'tokens' : 'cny')
    const used = kind === 'tokens' ? Number(e.usedTokens ?? 0) : Number(e.usedCny ?? e.used ?? 0)
    const limit = kind === 'tokens' ? Number(e.limitTokens ?? 0) : Number(e.limitCny ?? e.limit ?? 0)
    const remaining = Math.max(0, limit - used)
    const usedPct = e.usedPct != null ? Number(e.usedPct) : limit > 0 ? Math.min(100, (used / limit) * 100) : 0
    const remainingPct = e.remainingPct != null ? Number(e.remainingPct) : Math.max(0, 100 - usedPct)
    return {
      provider: e.provider,
      label: e.label ?? e.provider,
      kind,
      used,
      limit,
      remaining,
      usedPct,
      remainingPct,
      refreshAt: e.refreshAt ?? null,
    }
  })
}
