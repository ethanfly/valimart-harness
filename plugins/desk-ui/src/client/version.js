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
