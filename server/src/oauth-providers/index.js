import { grokProvider } from './grok.js'
import { chatgptProvider } from './chatgpt.js'
import { claudeProvider } from './claude.js'
import { geminiProvider } from './gemini.js'

export const OAUTH_PROVIDERS = {
  grok: grokProvider,
  chatgpt: chatgptProvider,
  claude: claudeProvider,
  gemini: geminiProvider,
}

export function providerSpec(channelId) {
  return OAUTH_PROVIDERS[channelId] ?? null
}
