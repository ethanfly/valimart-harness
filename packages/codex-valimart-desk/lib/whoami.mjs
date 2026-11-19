export function userLine(state) {
  if (!state?.sessionToken || !state?.user) return state?.needsRelogin ? 'valimart 需重新登录' : 'valimart 未登录'
  const user = state.user
  const who = user.displayName || user.username
  const account = user.username && user.username !== who ? ` (${user.username})` : ''
  return `valimart ${who}${account}${user.role ? ` · ${user.role}` : ''}${state.company?.name ? ` @${state.company.name}` : ''}`
}

export function quotaLine(quota) {
  return (Array.isArray(quota) ? quota : []).map((item) => {
    const tokens = item.kind === 'tokens'
    return `${item.label || '总额度'} ${tokens ? item.usedTokens : item.usedCny}/${tokens ? item.limitTokens : item.limitCny} ${tokens ? 'token' : '元'}${item.usedPct != null ? ` ${item.usedPct}%` : ''}`
  }).join(' · ')
}

export function statusText(state) {
  const lines = [userLine(state)]
  if (state?.gatewayUrl) lines.push(`网关 ${state.gatewayUrl}`)
  if (state?.defaultModel) lines.push(`默认模型 ${state.defaultModel}`)
  const quota = quotaLine(state?.quota)
  if (quota) lines.push(quota)
  if (state?.currentTaskId) lines.push(`当前任务 ${state.currentTaskId}`)
  if (state?.needsRelogin && state?.lastError) lines.push(state.lastError)
  return lines.join('\n')
}
