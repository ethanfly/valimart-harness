/**
 * DeepSeek Harness 插件列表兼容层：与 dsh-host-plugin-inventory 的
 * PluginInventorySnapshot `{ entries: [{ entryId, moduleName, enabled, fiberPhase }] }` 同形。
 */

export function toPluginInventorySnapshot(entries = []) {
  return {
    entries: entries.map((e) => ({
      entryId: String(e.entryId ?? e.id ?? ''),
      moduleName: String(e.moduleName ?? e.name ?? e.entryId ?? e.id ?? ''),
      enabled: e.disabled === true || e.enabled === false ? false : true,
      fiberPhase: e.fiberPhase ?? (e.disabled === true || e.enabled === false ? null : 'active'),
    })).filter((e) => e.entryId),
  }
}

/** 解析 profile/cordis.patch.yml：禁用项 + insert 的公司插件。 */
export function pluginsFromCordisPatch(text) {
  const entries = []
  const lines = String(text ?? '').split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const idm = /^-\s+id:\s+(\S+)/.exec(line)
    if (idm) {
      const entry = { id: idm[1], name: idm[1], disabled: false }
      i += 1
      while (i < lines.length && /^\s+/.test(lines[i]) && !/^-\s+/.test(lines[i])) {
        if (/^\s+disabled:\s+true/.test(lines[i])) entry.disabled = true
        const nm = /^\s+name:\s+(.+)$/.exec(lines[i])
        if (nm) entry.name = nm[1].trim().replace(/^['"]|['"]$/g, '')
        i += 1
      }
      entries.push(entry)
      continue
    }
    if (/^-\s+insert:/.test(line)) {
      i += 1
      while (i < lines.length && /^\s+/.test(lines[i])) {
        const im = /^\s+-\s+id:\s+(\S+)/.exec(lines[i])
        if (im) {
          const entry = { id: im[1], name: im[1], disabled: false, inserted: true }
          i += 1
          while (i < lines.length && /^\s{6,}/.test(lines[i])) {
            const nm = /^\s+name:\s+(.+)$/.exec(lines[i])
            if (nm) entry.name = nm[1].trim().replace(/^['"]|['"]$/g, '')
            i += 1
          }
          entries.push(entry)
          continue
        }
        i += 1
      }
      continue
    }
    i += 1
  }
  return entries
}

/** DSH 内核常见插件（与官方 plugin inventory 对齐的只读目录）。 */
export const DSH_CORE_PLUGINS = [
  { id: 'plugin-inventory', name: '@deepseek-ai/dsh-host-plugin-inventory' },
  { id: 'ui-settings-plugins', name: '@deepseek-ai/dsh-client-ui-settings-plugins' },
  { id: 'ui-settings-plugin-inventory', name: '@deepseek-ai/dsh-client-ui-settings-plugin-inventory' },
  { id: 'ui-settings-models', name: '@deepseek-ai/dsh-client-ui-settings-models' },
  { id: 'ui-layout', name: '@deepseek-ai/dsh-client-ui-layout' },
  { id: 'ui-sidebar', name: '@deepseek-ai/dsh-client-ui-sidebar' },
  { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek' },
  { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model' },
  { id: 'permission', name: '@deepseek-ai/dsh-permission' },
  { id: 'session-title-llm', name: '@deepseek-ai/dsh-session-title-llm' },
]

export function mergePluginSnapshots(...snaps) {
  const byId = new Map()
  for (const snap of snaps) {
    for (const e of snap?.entries ?? []) {
      if (!e.entryId) continue
      byId.set(e.entryId, e)
    }
  }
  return { entries: [...byId.values()] }
}

export function workspacePluginCatalog(patchText, extras = []) {
  const fromPatch = toPluginInventorySnapshot(pluginsFromCordisPatch(patchText))
  const core = toPluginInventorySnapshot(DSH_CORE_PLUGINS.map((p) => ({ ...p, enabled: true })))
  const extra = toPluginInventorySnapshot(extras)
  return mergePluginSnapshots(core, fromPatch, extra)
}
