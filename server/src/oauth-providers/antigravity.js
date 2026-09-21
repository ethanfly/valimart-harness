/**
 * Google Antigravity（Cloud Code）installed-app OAuth。
 * 凭据与 CLIProxyAPI（CPA）internal/auth/antigravity/constants.go 对齐：
 * client 1071006060591-…、回调端口 51121、cloudcode-pa.googleapis.com/v1internal。
 * 个人 Google AI Pro / Ultra 应走本通道，不要再用旧 Gemini CLI（gemini-code-assist）。
 */
export const ANTIGRAVITY_CALLBACK = 'http://localhost:51121/oauth2callback'

export const antigravityProvider = {
  id: 'antigravity',
  label: 'Antigravity',
  oauth: true,
  flow: 'authorization_code_paste',
  clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
  // 公开客户端 secret 不入库（GitHub push protection）。设 OAUTH_ANTIGRAVITY_CLIENT_SECRET，或 config.local.json → oauth.antigravity.clientSecret。
  clientSecret: process.env.OAUTH_ANTIGRAVITY_CLIENT_SECRET || undefined,
  clientSecretInBody: true,
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  redirectUri: ANTIGRAVITY_CALLBACK,
  scope: [
    'openid',
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
  ].join(' '),
  authorizeParams: { access_type: 'offline', prompt: 'consent' },
  requirePastedState: true,
  upstreamApi: 'antigravity',
  upstreamBaseUrl: 'https://cloudcode-pa.googleapis.com/v1internal',
  authStyle: 'bearer',
  detail: '用 Google Antigravity / Cloud Code 客户端登录个人 AI Pro / Ultra（与 CPA CLIProxyAPI 同一套 OAuth）。不要填 AI Studio API key。',
  pasteHint: '登录后若 localhost:51121 页面无法打开，这是正常的；请复制浏览器地址栏的完整回调网址（含 code 和 state）并粘贴回来。',
}
