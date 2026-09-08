/** 界面展示的客户端版本：优先构建时打的 installerVersion。 */

export function clientVersionLabel(client) {
  if (!client) return 'dev'
  return client.installerVersion || client.version || client.buildId || 'dev'
}

export function clientVersionDetail(client) {
  return client?.buildId || clientVersionLabel(client)
}

/** 实际运行的内核版本：/state 的 kernel.version 优先（内核独立更新后与构建时不同），
 * 退回 payload 记录的 kernelVersion；开发版两条都没有时显示 dev。 */
export function kernelVersionLabel(desk) {
  return desk?.kernel?.version || desk?.client?.kernelVersion || 'dev'
}

/** 搜索密钥状态：true = 公司已配置并下发到本机凭据；false = 匿名额度；null = 还没同步过。 */
export function searchKeyLabel(desk) {
  const configured = desk?.search?.anysearch?.configured
  if (configured === true) return '已由公司配置'
  if (configured === false) return '匿名额度'
  return '未同步'
}
