/**
 * 搜索供应商设置（管理页 → 搜索密钥）。
 *
 * AnySearch 的 key 默认存服务端库（gateway.sqlite 的 search.json 集合），与通道凭据同一原则：
 * 只落服务端、不写进配置下发；员工登录后由 desk-host 经 /api/search/anysearch 取回，
 * 写进本机 DSH 凭据供 @anysearch/anysearch-dsh 逐次解析。
 *
 * 生效优先级：管理页设置 > config.local.json / 环境变量（config.js 解析出的 resolvedKey）。
 * 管理页状态视图只回「是否配置 / 来源」，绝不回 key 值。
 */
import { createPersistence } from './store.js'

export const SEARCH_SOURCE_ADMIN = 'admin-page'
export const SEARCH_SOURCE_CONFIG = 'config'

const SOURCE_LABELS = {
  [SEARCH_SOURCE_ADMIN]: '管理页设置',
  [SEARCH_SOURCE_CONFIG]: '服务端配置 / 环境变量',
}

export class SearchSettings {
  constructor(cfg, dataDir) {
    this.cfg = cfg
    this.store = createPersistence(dataDir).file('search.json', () => ({}))
  }

  read() {
    const data = this.store.load()
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  }

  /** 管理页里设置的 AnySearch key；未设置返回 null。 */
  adminAnysearchKey() {
    const value = this.read().anysearch?.apiKey
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }

  /** 实际生效的 key：管理页优先，其次服务端配置 / 环境变量；都没有返回 null（匿名额度）。 */
  anysearchKey() {
    return this.adminAnysearchKey() ?? (this.cfg.search?.anysearch?.resolvedKey || null)
  }

  /** 生效 key 的来源：admin-page / config / null。 */
  anysearchSource() {
    if (this.adminAnysearchKey()) return SEARCH_SOURCE_ADMIN
    if (this.cfg.search?.anysearch?.resolvedKey) return SEARCH_SOURCE_CONFIG
    return null
  }

  /** 管理页视图：只有状态与来源，没有 key 值。 */
  view() {
    const source = this.anysearchSource()
    return {
      anysearch: {
        configured: this.anysearchKey() !== null,
        source,
        sourceLabel: source ? SOURCE_LABELS[source] : null,
      },
    }
  }

  /** 写入或清除管理页 key（空白字符串 / null 清除）；返回新的状态视图。 */
  setAnysearchKey(apiKey) {
    const value = typeof apiKey === 'string' ? apiKey.trim() : ''
    this.store.update((data) => {
      if (value) data.anysearch = { ...(data.anysearch ?? {}), apiKey: value }
      else delete data.anysearch
    })
    return this.view()
  }
}
