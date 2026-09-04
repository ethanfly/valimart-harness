/**
 * ChatGPT 订阅：与 Codex CLI / VS Code 相同的官方设备码登录。
 * 浏览器打开 auth.openai.com/codex/device，输入一次性代码，换到 access_token。
 * 不抓 chatgpt.com cookie。
 */
export const chatgptProvider = {
  id: 'chatgpt',
  label: 'ChatGPT',
  oauth: true,
  flow: 'device_code',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  deviceUserCodeUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
  devicePollUrl: 'https://auth.openai.com/api/accounts/deviceauth/token',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  verificationUri: 'https://auth.openai.com/codex/device',
  deviceRedirectUri: 'https://auth.openai.com/deviceauth/callback',
  scope: 'openid profile email offline_access',
  authStyle: 'bearer',
  upstreamApi: 'chatgpt-codex',
  upstreamBaseUrl: 'https://chatgpt.com/backend-api/codex',
}
