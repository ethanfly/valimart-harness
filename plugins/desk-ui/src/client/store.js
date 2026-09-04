/**
 * 极简可观察 store（React 外部状态）：桌面登录态、任务列表、当前任务、界面模式。
 */
import { useSyncExternalStore } from 'react'

export function createStore(initial) {
  let state = initial
  const listeners = new Set()
  const store = {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : { ...state, ...patch }
      if (next === state) return
      state = next
      for (const l of [...listeners]) l()
    },
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  }
  return store
}

export function useStoreValue(store, selector = (s) => s) {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()), () => selector(store.get()))
}

export const deskStore = createStore({
  phase: 'loading', // loading | ready | offline
  desk: null, // /desk/api/state 的公开视图
  error: null,
  tasks: [],
  tasksError: null,
  tasksLoadedAt: 0,
  selectedTaskId: null,
  taskDetail: null,
  people: [],
  toast: null,
})

let toastTimer
export function toast(message, kind = 'info') {
  deskStore.set({ toast: { message, kind, at: Date.now() } })
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => deskStore.set({ toast: null }), 3200)
}
