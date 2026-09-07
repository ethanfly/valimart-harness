/** 界面展示的客户端版本：优先构建时打的 installerVersion。 */

export function clientVersionLabel(client) {
  if (!client) return 'dev'
  return client.installerVersion || client.version || client.buildId || 'dev'
}

export function clientVersionDetail(client) {
  return client?.buildId || clientVersionLabel(client)
}
