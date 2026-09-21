/**
 * 上游订阅额度用尽：应切到同通道下一个账号，而不是把普通 429 限流当额度耗尽。
 */
export function isUpstreamQuotaExhausted(status, text) {
  const code = Number(status)
  if (code === 402) return true
  const t = String(text ?? '').toLowerCase()
  if (/resource_exhausted|resource has been exhausted/.test(t)) return true
  if (/insufficient_quota|quota_exceeded|billing_not_active|credit.?balance|exceeded.?your.?quota|usage.?limit.?reached|out of credits|no remaining credits/.test(t)) {
    return true
  }
  if (code === 429 && /quota|billing|credit|usage.?limit/.test(t)) return true
  return false
}

export function quotaExhaustedMessage(upstream) {
  const api = String(upstream?.api ?? '')
  const channel = String(upstream?.channel ?? '')
  if (api === 'antigravity' || channel === 'antigravity') {
    return 'Google Antigravity 额度已用尽。可在同一通道再接入一个 Google 账号，或等配额重置后再试。'
  }
  if (api === 'gemini-code-assist' || channel === 'gemini') {
    return 'Google Cloud Code / Gemini 订阅额度已用尽。可再接入一个账号，或等待配额重置。'
  }
  return '该订阅账号额度已用尽。可在同一通道接入下一个账号，或等待额度恢复。'
}

export const ACCOUNT_EXHAUSTED_MINUTES = 30
