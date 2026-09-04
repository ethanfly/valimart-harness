/**
 * OAuth 令牌辅助：读 JWT 声明、判断是否该用 refresh_token 续期。
 */

const SKEW_MS = 120_000

export function decodeJwtPayload(token) {
  const raw = String(token ?? '')
  const parts = raw.split('.')
  if (parts.length < 2) return null
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (parts[1].length % 4)) % 4)
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

export function accountIdFromToken(token) {
  const payload = decodeJwtPayload(token)
  if (!payload || typeof payload !== 'object') return undefined
  const namespaced = payload['https://api.openai.com/auth']
  const id = namespaced?.chatgpt_account_id || payload.chatgpt_account_id
  return id ? String(id) : undefined
}

export function tokenExpiresAtMs(item) {
  if (item?.tokenExpiresAt) {
    const t = Date.parse(item.tokenExpiresAt)
    if (Number.isFinite(t)) return t
  }
  const payload = decodeJwtPayload(item?.credential)
  const exp = Number(payload?.exp)
  if (Number.isFinite(exp) && exp > 0) return exp * 1000
  return undefined
}

export function needsRefresh(item, now = Date.now(), skewMs = SKEW_MS) {
  if (!item?.refreshToken) return false
  const exp = tokenExpiresAtMs(item)
  if (exp == null) return false
  return exp - now <= skewMs
}

export function isOpenAiPublicApi(url) {
  try {
    return new URL(String(url ?? '')).hostname === 'api.openai.com'
  } catch {
    return false
  }
}

/** ChatGPT OAuth 默认打 Codex 后端；只有管理员填了非官方 OpenAI 地址才沿用。 */
export function resolveConnectBaseUrl(inputBase, provider, fallback) {
  const raw = String(inputBase ?? '').trim()
  if (provider?.upstreamApi === 'chatgpt-codex') {
    if (!raw || isOpenAiPublicApi(raw)) return provider.upstreamBaseUrl || 'https://chatgpt.com/backend-api/codex'
  }
  return raw || fallback
}
