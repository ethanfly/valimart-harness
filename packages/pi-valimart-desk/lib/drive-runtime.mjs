import { DriveMirror } from './drive-mirror.mjs'
import { makeApiClient } from './gateway.mjs'
import { defaultDriveDir, loadState, saveState } from './state.mjs'

let mirror

/** 默认走 console；TUI 下由扩展改道（console.log 是裸 stdout 写，会把字写进输入框、画花屏幕）。 */
const defaultLogSink = (msg) => console.log(`[valimart-drive] ${msg}`)
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
    save() {
      saveState(this.data)
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
  if (!loadState().sessionToken) throw new Error('未登录公司网关')
  return getMirror().sync()
}
