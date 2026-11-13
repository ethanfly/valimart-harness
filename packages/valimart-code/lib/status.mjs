/**
 * 「当前登录的是谁」的几种写法：状态栏一行、横幅副标题、valimart status 与 /desk-status 的多行。
 * 都只读登录态，不含令牌。
 */
import { publicView } from './state.mjs'

export function userLine(state) {
  if (!state?.sessionToken || !state?.user) return state?.needsRelogin ? 'valimart 需重新登录' : 'valimart 未登录'
  const user = state.user
  const who = user.displayName || user.name || user.username || '已登录'
  const account = user.username && user.username !== who ? ` (${user.username})` : ''
  const company = state.company?.name ? ` @${state.company.name}` : ''
  return `valimart ${who}${account}${company}`
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

/** 横幅副标题：公司产品名 + 登录身份。 */
export function bannerSubtitle(state) {
  if (!state?.sessionToken || !state?.user) return `惠利玛工作交付平台 · ${state?.needsRelogin ? '公司网关登录已失效，/quit 后运行 valimart login' : '未登录公司网关'}`
  return `惠利玛工作交付平台 · ${userLine(state).replace(/^valimart /, '')}`
}

/** 多行，给 valimart status 与 /desk-status。 */
export function statusText(state) {
  const view = publicView(state)
  const lines = [userLine(state), `网关 ${view.gatewayUrl}`]
  if (view.loggedIn) {
    if (state.user?.roleLabel || state.user?.role) lines.push(`角色 ${state.user.roleLabel ?? state.user.role}${state.user.department ? ` · ${state.user.department}` : ''}`)
    if (view.defaultModel) lines.push(`公司默认模型 ${view.defaultModel}`)
    if (view.models.length) lines.push(`模型目录 ${view.models.join(', ')}`)
    const quota = quotaLine(state.quota)
    if (quota) lines.push(`本周额度 ${quota}`)
    lines.push(`公司盘镜像 ${view.driveDir}（${view.lastSyncAt ? `上次同步 ${view.lastSyncAt}` : '尚未同步'}）`)
    lines.push(view.currentTaskId ? `绑定任务卡 ${view.currentTaskId}` : '未绑定任务卡（不强制）')
  }
  if (view.lastError) lines.push(`上次错误：${view.lastError}`)
  return lines.join('\n')
}
