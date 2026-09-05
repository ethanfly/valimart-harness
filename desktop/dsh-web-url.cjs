/**
 * CJS 副本，供 Electron 主进程使用（打包后不 import ESM bootstrap）。
 * 逻辑与 scripts/lib/dsh-web-url.mjs 保持一致。
 */
'use strict'

function parseDshWebUrl(text) {
  const m = String(text ?? '').match(/dsh web:\s+(https?:\/\/[^\s]+)/i)
  if (!m) return null
  try {
    const href = m[1].replace(/[),.;]+$/, '')
    const u = new URL(href)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.href
  } catch {
    return null
  }
}

function sameWebOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

function hasLaunchToken(url) {
  try {
    return Boolean(new URL(url).searchParams.get('token'))
  } catch {
    return false
  }
}

function createDshWebUrlWatcher() {
  let printed = null
  let buf = ''
  const waiters = []
  return {
    feed(chunk) {
      buf += String(chunk ?? '')
      if (buf.length > 8192) buf = buf.slice(-4096)
      const u = parseDshWebUrl(buf)
      if (!u) return printed
      const upgrade = printed && hasLaunchToken(u) && !hasLaunchToken(printed)
      if (printed && !upgrade) return printed
      printed = u
      if (!upgrade) {
        for (const w of waiters) w(u)
        waiters.length = 0
      }
      return printed
    },
    get() {
      return printed
    },
    wait(timeoutMs = 15000) {
      return new Promise((resolve) => {
        if (printed) return resolve(printed)
        const t = setTimeout(() => resolve(null), timeoutMs)
        waiters.push((u) => {
          clearTimeout(t)
          resolve(u)
        })
      })
    },
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function resolveDshWebUrl({ port, getPrinted, fetchImpl = fetch, timeoutMs = 60000, intervalMs = 300 } = {}) {
  const bare = `http://127.0.0.1:${Number(port)}/`
  const readPrinted = () => (typeof getPrinted === 'function' ? getPrinted() : getPrinted)
  const started = Date.now()
  let sawAuth = false
  let sawHttp = false
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetchImpl(bare, { redirect: 'manual' })
      if (r.status === 401) sawAuth = true
      if (r.status < 500) sawHttp = true
    } catch {
      /* 还没起来 */
    }
    const printed = readPrinted()
    if (printed && hasLaunchToken(printed)) return printed
    if (printed && sawHttp && !sawAuth) {
      await sleep(intervalMs)
      const again = readPrinted()
      if (again && hasLaunchToken(again)) return again
      return again || printed
    }
    await sleep(intervalMs)
  }
  const printed = readPrinted()
  if (printed && hasLaunchToken(printed)) return printed
  if (printed && !sawAuth) return printed
  if (sawAuth) throw new Error(`内核要求 Web 登录令牌，但 ${timeoutMs / 1000} 秒内没有打出 dsh web 地址（端口 ${port}）`)
  throw new Error(`内核 ${timeoutMs / 1000} 秒内没有就绪（${bare}）`)
}

module.exports = { parseDshWebUrl, sameWebOrigin, hasLaunchToken, createDshWebUrlWatcher, resolveDshWebUrl }
