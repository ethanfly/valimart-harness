import { grokProvider } from './grok.js'
import { chatgptProvider } from './chatgpt.js'
import { claudeProvider } from './claude.js'

export const OAUTH_PROVIDERS = {
  grok: grokProvider,
  chatgpt: chatgptProvider,
  claude: claudeProvider,
}

export function providerSpec(channelId) {
  return OAUTH_PROVIDERS[channelId] ?? null
}
