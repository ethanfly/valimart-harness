/** 公司盘运行时单例；stdout 只给 MCP 协议，日志走 stderr。 */
import { DriveMirror } from './drive-mirror.mjs'
import { makeApiClient } from './gateway.mjs'
import { defaultDriveDir, loadState, saveState } from './state.mjs'

let mirror
export const driveLog = (msg) => console.error(`[valimart-drive] ${msg}`)

export function deskStateBox() {
  const data = loadState()
  if (!data.driveDir) data.driveDir = defaultDriveDir()
  return { data, save() { saveState({ lastSyncAt: this.data.lastSyncAt }) } }
}

export function getMirror() {
  const state = deskStateBox()
  if (!mirror || mirror.root !== state.data.driveDir) {
    mirror = new DriveMirror({ root: state.data.driveDir, gateway: makeApiClient(), state, log: driveLog })
  } else {
    mirror.state = state
    mirror.gateway = makeApiClient()
  }
  return mirror
}

export async function syncDrive() {
  if (!loadState().sessionToken) throw new Error('未登录公司网关，请先运行 codex-valimart login')
  try { return await getMirror().sync() } catch (err) {
    if (err?.status === 401) saveState({ needsRelogin: true, lastError: `公司网关登录已失效：${err.message}` })
    throw err
  }
}
