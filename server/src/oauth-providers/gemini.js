/** Gemini CLI installed-app OAuth (public client credentials, not account secrets).
 * Reference: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/oauth2.ts
 * The loopback callback is pasted back, so login also works with a remote gateway.
 */
export const GEMINI_MIGRATION_NOTICE = 'Google 已于 2026-06-18 停用 Gemini CLI 的个人 Google AI Pro / Ultra 接入。请在「加入订阅」里选 Antigravity 通道（与 CPA / CLIProxyAPI 同一套 Cloud Code 客户端）。不要重试本通道或配置项目 ID。Gemini Code Assist Standard / Enterprise 可继续用本通道。'

export const geminiProvider = {
  id: 'gemini',
  label: 'Google One / Gemini',
  oauth: true,
  flow: 'authorization_code_paste',
  clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
  clientSecret: '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',
  clientSecretInBody: true,
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  redirectUri: 'http://localhost:45289/oauth2callback',
  scope: 'openid https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
  authorizeParams: { access_type: 'offline', prompt: 'consent' },
  requirePastedState: true,
  upstreamApi: 'gemini-code-assist',
  authStyle: 'bearer',
  detail: GEMINI_MIGRATION_NOTICE,
  pasteHint: '登录后若 localhost 页面无法打开，这是正常的；请复制浏览器地址栏的完整回调网址（含 code 和 state）并粘贴回来。',
}
