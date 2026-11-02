/**
 * 公司盘镜像运行时（单例）。MCP server / CLI 共用这一个实例。
 * 日志默认走 stderr：MCP 与 hook 进程的 stdout 只许协议输出，不打印日志。
 */
import { DriveMirror } from './drive-mirror.mjs'
import { makeApiClient } from './gateway.mjs'
import { defaultDriveDir, loadState, saveState } from './state.mjs'

let mirror

const defaultLogSink = (msg) => console.error(`[valimart-drive] ${msg}`)
let logSink = defaultLogSink

export function setDriveLogSink(sink) {
  logSink = typeof sink === 'function' ? sink : defaultLogSink
}

export function driveLog(msg) {
  logSink(msg)
}

export function deskStateBox() {
  const data = loadState()
  if (!data.driveDir) data.driveDir = defaultDriveDir()
  return {
    data,
    // 只写同步时间：登录态文件几个进程共用，整份回写会把同步期间的登出 / 换绑任务卡盖回去
    save() {
      saveState({ lastSyncAt: this.data.lastSyncAt })
    },
  }
}

export function getMirror() {
  const st = deskStateBox()
  if (!mirror || mirror.root !== st.data.driveDir) {
    mirror = new DriveMirror({
      root: st.data.driveDir,
      gateway: makeApiClient(),
      state: st,
      log: driveLog,
    })
  } else {
    mirror.state = st
    mirror.gateway = makeApiClient()
  }
  return mirror
}

export async function syncDrive() {
  if (!loadState().sessionToken) throw new Error('未登录公司网关，请先 /valimart-desk:desk-login')
  try {
    return await getMirror().sync()
  } catch (err) {
    if (err?.status === 401) saveState({ needsRelogin: true, lastError: `公司网关登录已失效：${err.message}` })
    throw err
  }
}
