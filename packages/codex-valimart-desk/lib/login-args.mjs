export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8790'

export function parseDeskLoginArgs(args, env = process.env) {
  const parts = String(args ?? '').trim().split(/\s+/).filter(Boolean)
  return { url: parts[0] || env.DESK_GATEWAY_URL || '', username: parts[1] || env.DESK_GATEWAY_USER || env.DESK_GATEWAY_USERNAME || '', password: env.DESK_GATEWAY_PASSWORD || '' }
}
