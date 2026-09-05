/**
 * 上游订阅额度用尽：应切到同通道下一个账号，而不是把普通 429 限流当额度耗尽。
 */
export function isUpstreamQuotaExhausted(status, text) {
  const code = Number(status)
  if (code === 402) return true
  const t = String(text ?? '').toLowerCase()
  if (/insufficient_quota|quota_exceeded|billing_not_active|credit.?balance|exceeded.?your.?quota|usage.?limit.?reached|out of credits|no remaining credits/.test(t)) {
    return true
  }
  if (code === 429 && /quota|billing|credit|usage.?limit/.test(t)) return true
  return false
}

export const ACCOUNT_EXHAUSTED_MINUTES = 30
