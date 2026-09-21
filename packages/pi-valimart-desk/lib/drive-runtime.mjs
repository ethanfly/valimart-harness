import { DriveMirror } from './drive-mirror.mjs'
import { makeApiClient } from './gateway.mjs'
import { defaultDriveDir, loadState, saveState } from './state.mjs'

let mirror

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
      log: (msg) => console.log(`[valimart-drive] ${msg}`),
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
