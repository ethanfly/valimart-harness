/**
 * Claude 订阅：与 Claude Code 相同的官方浏览器 OAuth（授权码 + PKCE）。
 * redirect 必须是 Anthropic 已登记的 console 回调页；登录后把页上的授权码贴回网关换票。
 * 令牌走 Authorization: Bearer + anthropic-beta: oauth-2025-04-20，不用 x-api-key。
 * 不抓 claude.ai cookie。
 */
export const claudeProvider = {
  id: 'claude',
  label: 'Claude',
  oauth: true,
  flow: 'authorization_code_paste',
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  scope: 'org:create_api_key user:profile user:inference user:sessions:claude_code',
  tokenBody: 'json',
  authStyle: 'anthropic-oauth',
}
