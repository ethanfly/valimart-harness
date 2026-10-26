/**
 * 界面上那一行「当前登录用户」。
 * 状态栏脚本、SessionStart 附加上下文、/desk-status 都走这里，文案只有一份。
 */

export function userLine(state) {
  if (!state?.sessionToken || !state?.user) {
    return state?.needsRelogin ? 'valimart 需重新登录' : 'valimart 未登录'
  }
  const user = state.user
  const who = user.displayName || user.name || user.username || '已登录'
  const account = user.username && user.username !== who ? ` (${user.username})` : ''
  const role = user.role ? ` · ${user.role}` : ''
  const company = state.company?.name ? ` @${state.company.name}` : ''
  return `valimart ${who}${account}${role}${company}`
}

export function quotaLine(quota) {
  if (!Array.isArray(quota) || quota.length === 0) return ''
  return quota
    .map((q) => {
      const name = q.label || '总额度'
      const used = q.kind === 'tokens' ? q.usedTokens : q.usedCny
      const limit = q.kind === 'tokens' ? q.limitTokens : q.limitCny
      const unit = q.kind === 'tokens' ? 'token' : '元'
      const pct = q.usedPct != null ? ` ${q.usedPct}%` : ''
      return `${name} ${used}/${limit} ${unit}${pct}`
    })
    .join(' · ')
}

/** 一行，给状态栏或 OMC HUD 拼接。未登录也返回一行，方便看出「没接上」。 */
export function hudLine(state) {
  const who = userLine(state)
  const quota = quotaLine(state?.quota)
  return quota && state?.sessionToken ? `${who} · ${quota}` : who
}

/** 多行，给 /desk-status 和 SessionStart。不含令牌。 */
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
