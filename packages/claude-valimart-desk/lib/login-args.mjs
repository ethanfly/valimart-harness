/**
 * /desk-login 参数。密码不进 slash 历史：只用环境变量 DESK_GATEWAY_PASSWORD。
 */
export function parseDeskLoginArgs(args, env = process.env) {
  const parts = String(args ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return {
    url: parts[0] || env.DESK_GATEWAY_URL || '',
    username: parts[1] || env.DESK_GATEWAY_USER || env.DESK_GATEWAY_USERNAME || '',
    password: env.DESK_GATEWAY_PASSWORD || '',
  }
}

export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8790'
