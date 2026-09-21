/**
 * 网关可选项的纯函数：把 discoverGateways() 的结果翻成列表，再反解回地址。
 * 交互（notify/select/input）留在扩展里，这里只管列表与映射，好单测。
 */

/** 选择列表里的手填兜底行：网关在云上 / 广播被防火墙挡时不会卡住登录。 */
export const MANUAL_GATEWAY_LABEL = '手动输入其他地址…'

function label(gw, url, withSource) {
  const name = String(gw?.name ?? '').trim()
  const setup = gw?.needsSetup ? '（待初始设置）' : ''
  const source = withSource && gw?.source ? `  [${gw.source}]` : ''
  return `${name}${setup}  ${url}${source}`.trim()
}

/**
 * @param {Array<{name?: string, needsSetup?: boolean, urls?: string[], source?: string}>} found discoverGateways() 的结果
 * @param {{manual?: string, withSource?: boolean}} [opts] manual 传 '' 表示不加手填兜底行
 * @returns {Array<{label: string, url: string}>} url 为空串表示「手填兜底行」
 */
export function gatewayOptions(found, { manual = MANUAL_GATEWAY_LABEL, withSource = false } = {}) {
  const seen = new Set()
  const options = []
  for (const gw of Array.isArray(found) ? found : []) {
    for (const url of Array.isArray(gw?.urls) ? gw.urls : []) {
      if (!url || seen.has(url)) continue
      seen.add(url)
      options.push({ label: label(gw, url, withSource), url })
    }
  }
  if (manual) options.push({ label: manual, url: '' })
  return options
}

/** 选中项 → 网关地址；返回空串表示用户选了手填兜底行或没有选中。 */
export function gatewayUrlFromChoice(choice, options) {
  if (!choice) return ''
  return (Array.isArray(options) ? options : []).find((o) => o.label === choice)?.url ?? ''
}

/**
 * OAuth 那条路没法弹列表：发现到当前已记的地址就用它；只发现一台就用那台；否则回退 fallback。
 */
export function suggestedGatewayUrl(found, fallback) {
  const list = Array.isArray(found) ? found : []
  if (fallback && list.some((g) => Array.isArray(g?.urls) && g.urls.includes(fallback))) return fallback
  const only = list.length === 1 ? list[0].urls?.[0] : ''
  return only || fallback || ''
}
