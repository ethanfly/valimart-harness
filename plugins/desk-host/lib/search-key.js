/**
 * 把公司统一配置的搜索供应商密钥（AnySearch）从网关同步到本机 DSH 凭据。
 *
 * - 网关侧 key 只在服务端解析（server/config.local.json 的 search.anysearch.apiKey 或环境变量
 *   ANYSEARCH_API_KEY），员工登录后经 GET /api/search/anysearch 取回；
 * - 写入用 ctx.credentials.set(ANYSEARCH_API_KEY)：@anysearch/anysearch-dsh 逐次解析凭据，
 *   写入后下一次搜索即生效（无需重启内核）；
 * - 网关没配 → unset，明确回到匿名额度；
 * - 本机有只读来源（环境变量）遮蔽该引用时 set 会拒绝：只记日志，不影响登录。
 */
export const ANYSEARCH_KEY_REF = 'ANYSEARCH_API_KEY'

/**
 * @param {{ gateway: { get: Function }, credentials: { resolve: Function, set: Function, unset: Function }, credentialRef: Function, log?: Function }} opts
 * @returns {Promise<{ action: 'set'|'unset'|'skip'|'error', detail: string, configured?: boolean }>}
 *   configured：调用后本机是否处于「已配置」状态；网关读取失败时不给该字段（保持未知，别把状态改坏）。
 */
export async function syncSearchCredentials({ gateway, credentials, credentialRef, log = () => {} } = {}) {
  const ref = credentialRef(ANYSEARCH_KEY_REF)
  let remote
  try {
    const r = await gateway.get('/api/search/anysearch')
    remote = r?.anysearch?.apiKey ?? null
  } catch (err) {
    // 网关旧版本没有这个端点 / 网络不通：保持本机现状，等下一次登录或心跳再试
    log(`读取网关搜索密钥失败：${err.message ?? String(err)}`)
    return { action: 'error', detail: 'gateway' }
  }

  let current = null
  try {
    current = (await credentials.resolve(ref))?.value ?? null
  } catch {
    current = null
  }

  if (remote) {
    if (current === remote) return { action: 'skip', detail: 'unchanged', configured: true }
    try {
      await credentials.set(ref, remote)
      log('搜索密钥已由公司配置下发（下次搜索即生效）')
      return { action: 'set', detail: 'company', configured: true }
    } catch (err) {
      log(`搜索密钥写入被拒绝（可能有只读来源遮蔽）：${err.message ?? String(err)}`)
      return { action: 'error', detail: 'shadowed', configured: current !== null }
    }
  }

  if (current !== null) {
    try {
      await credentials.unset(ref)
      log('网关未配置搜索密钥，本机回到匿名额度')
      return { action: 'unset', detail: 'anonymous', configured: false }
    } catch (err) {
      log(`搜索密钥移除失败：${err.message ?? String(err)}`)
      return { action: 'error', detail: 'unset', configured: true }
    }
  }
  return { action: 'skip', detail: 'anonymous', configured: false }
}
