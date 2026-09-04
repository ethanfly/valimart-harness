/**
 * 产品品牌：用公司原 logo（白图抠透明）做 currentColor 蒙版，形状不改画。
 * 软件名 valimart harness；字标图里已有 VALIMART，下面补 harness。
 */
import wordmarkUrl from './assets/valimart-wordmark.png'
import markUrl from './assets/valimart-mark.png'

export const PRODUCT_NAME = 'valimart harness'
export const PRODUCT_TAG = '企业交付工作台'

const mask = (url) => ({ WebkitMaskImage: `url(${url})`, maskImage: `url(${url})` })
export const wordmarkMask = mask(wordmarkUrl)
export const markMask = mask(markUrl)

/** 花标（侧栏收起、标题栏、favicon）。 */
export function BrandMark({ size = 16, className = '' }) {
  return <i className={`dk-logo-mark ${className}`.trim()} style={{ ...markMask, width: size, height: size }} aria-hidden />
}

/** 完整字标：原 VALIMART 图 + harness。size 是字标图高度（px）。 */
export function Logotype({ size, tagline, compact = false }) {
  const h = size ?? (compact ? 16 : 18)
  return (
    <span className={`dk-logotype${compact ? ' compact' : ''}`} style={{ '--dk-logo-h': `${h}px` }} title={PRODUCT_NAME}>
      <span className="dk-logo-img" style={wordmarkMask} role="img" aria-label="VALIMART" />
      <small className="dk-logo-product">harness</small>
      {tagline ? <small className="dk-logo-tag">{tagline}</small> : null}
    </span>
  )
}
