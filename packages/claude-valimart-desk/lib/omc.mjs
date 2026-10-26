/**
 * 只读检查：本插件会不会踩到 oh-my-claudecode。
 * 不写 settings.json。OMC 在就说明状态栏应让给它，当前用户走 HUD 拼接。
 */
import fs from 'node:fs'
import path from 'node:path'

const OMC_NAMES = new Set(['oh-my-claudecode', 'oh-my-claude-sisyphus'])

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function findOmc(claudeDir) {
  const hits = []
  const installed = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'))
  const plugins = installed?.plugins && typeof installed.plugins === 'object' ? installed.plugins : installed
  if (plugins && typeof plugins === 'object' && !Array.isArray(plugins)) {
    for (const key of Object.keys(plugins)) {
      const name = key.split('@')[0]
      if (OMC_NAMES.has(name)) hits.push({ where: 'installed_plugins.json', id: key })
    }
  }
  const known = path.join(claudeDir, 'plugins', 'cache')
  if (fs.existsSync(known)) {
    for (const entry of fs.readdirSync(known, { withFileTypes: true })) {
      if (entry.isDirectory() && OMC_NAMES.has(entry.name)) hits.push({ where: 'plugins/cache', id: entry.name })
    }
  }
  return hits
}

export function settingsStatusLine(claudeDir) {
  const settings = readJson(path.join(claudeDir, 'settings.json'))
  const command = settings?.statusLine?.command
  return typeof command === 'string' ? command : ''
}

/**
 * OMC 已装，或状态栏命令已经指向别人：不要覆盖。
 * 命令里带本插件 statusline.mjs 视为「已经是我们的」，允许用户自己再用。
 */
export function statuslineOwner(claudeDir) {
  const omc = findOmc(claudeDir)
  const command = settingsStatusLine(claudeDir)
  const ours = /claude-valimart-desk|valimart-desk[\\/]+scripts[\\/]+statusline/.test(command)
  if (omc.length) return { owner: 'omc', command, ours, omc }
  if (command && !ours) return { owner: 'other', command, ours, omc }
  return { owner: command ? 'valimart' : 'none', command, ours, omc }
}
