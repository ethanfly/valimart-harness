import { grokProvider } from './grok.js'
import { chatgptProvider } from './chatgpt.js'
import { claudeProvider } from './claude.js'
import { geminiProvider } from './gemini.js'
import { antigravityProvider } from './antigravity.js'

export const OAUTH_PROVIDERS = {
  grok: grokProvider,
  chatgpt: chatgptProvider,
  claude: claudeProvider,
  gemini: geminiProvider,
  antigravity: antigravityProvider,
}

export function providerSpec(channelId) {
  return OAUTH_PROVIDERS[channelId] ?? null
}
