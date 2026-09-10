/**
 * Mixed T10 用量归属上报器（宿主 → 公司网关）。
 *
 * 时序约束：
 * - open 必须在子代理 spawn 之前 AWAIT 完成——否则 attempt 的前几次 LLM 请求可能先于
 *   归属登记到达网关（时间窗起点之前）→ 漏关联。网关不可达时 open 失败不阻塞派发
 *   （归属丢失可见：账本该窗口无 mixed 字段，UI 显示未知——不悄悄归错、不卡管道）。
 * - close 是收尾动作，fire-and-forget（3s 超时 + catch 记 warn）：宿主被强杀时 close
 *   本来就不会来，网关侧 TTL 兜底。
 *
 * 安全约束：只上报 run/task/stage/attempt id 与用户自己的会话令牌（GatewayClient 自带）；
 * 内部元数据只进网关账本 extra，绝不进上游请求体（网关 llm-proxy 保证）。
 */
export class MixedAttributionReporter {
  /**
   * @param {object} deps
   * @param {import('./gateway-client.js').GatewayClient} deps.gateway
   * @param {{info?: Function, warn?: Function, error?: Function}} [deps.logger]
   */
  constructor({ gateway, logger = console }) {
    if (!gateway || typeof gateway.post !== 'function') throw new Error('MixedAttributionReporter 需要 GatewayClient')
    this.gateway = gateway
    this.logger = logger
  }

  /**
   * 登记活跃 attempt（派发前调用）。
   * @returns {Promise<boolean>} true = 网关已接受；false = 失败（归属丢失，可见）
   */
  async open({ runId, taskId, stage, attemptId }) {
    try {
      await this.gateway.post('/api/mixed/attribution', { runId, taskId, stage, attemptId }, { timeoutMs: 3_000 })
      return true
    } catch (error) {
      this.logger.warn?.(`mixed 归属登记失败（attempt=${attemptId} stage=${stage}）：${String(error?.message ?? error)}——该窗口用量将显示为未关联`)
      return false
    }
  }

  /** 结束 attempt（fire-and-forget）。 */
  close({ runId, taskId, stage, attemptId }) {
    this.gateway
      .post('/api/mixed/attribution/close', { runId, taskId, stage, attemptId }, { timeoutMs: 3_000 })
      .catch((error) => {
        this.logger.warn?.(`mixed 归属关闭失败（attempt=${attemptId}）：${String(error?.message ?? error)}——网关 TTL 兜底`)
      })
  }

  /**
   * 读 run 级用量聚合（面板展示用）。
   * @returns {Promise<object|null>} usage 聚合；失败返回 null（面板不显示用量块）
   */
  async fetchRunUsage(runId) {
    try {
      return await this.gateway.get(`/api/mixed/usage?runId=${encodeURIComponent(runId)}`, { timeoutMs: 5_000 })
    } catch (error) {
      this.logger.warn?.(`mixed 用量读取失败（run=${runId}）：${String(error?.message ?? error)}`)
      return null
    }
  }
}
