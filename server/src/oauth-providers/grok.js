/**
 * xAI / Grok：对齐 Grok CLI / OpenCode 的公开客户端 + RFC 8628 设备码。
 * 不要求公司自建 xAI OAuth 应用（公开 client 不会登记网关 callback）。
 * 成功后 access_token 作 Bearer 调 api.x.ai/v1。
 */
export const grokProvider = {
  id: 'grok',
  label: 'xAI / Grok',
  oauth: true,
  flow: 'device_code',
  deviceStyle: 'rfc8628',
  clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
  authorizeUrl: 'https://auth.x.ai/oauth2/authorize',
  tokenUrl: 'https://auth.x.ai/oauth2/token',
  deviceUserCodeUrl: 'https://auth.x.ai/oauth2/device/code',
  verificationUri: 'https://auth.x.ai/activate',
  scope: 'openid profile email offline_access grok-cli:access api:access',
  authStyle: 'bearer',
}
