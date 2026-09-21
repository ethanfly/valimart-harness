/**
 * 诊断日志：网关请求、Agent 轮次、停止原因。不写令牌、不写密钥。
 */
export function redact(value) {
  if (value == null) return value
  if (typeof value === 'string') {
    if (value.length > 24 && /^(sk-|sess_|dgw_|Bearer )/i.test(value)) return `${value.slice(0, 4)}…`
    return value
  }
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (/token|password|api[_-]?key|authorization|secret/i.test(k)) out[k] = '***'
      else out[k] = redact(v)
    }
    return out
  }
  return value
}

export class HarnessLog {
  constructor(channel) {
    this.channel = channel
  }

  line(level, message, extra) {
    const ts = new Date().toISOString().slice(11, 23)
    const tail = extra !== undefined ? ` ${JSON.stringify(redact(extra))}` : ''
    const text = `[${ts}] ${message}${tail}`
    try {
      this.channel?.appendLine(text)
    } catch {
      /* channel may be absent in unit tests */
    }
    return text
  }

  info(message, extra) {
    return this.line('info', message, extra)
  }

  error(message, extra) {
    return this.line('error', `ERROR ${message}`, extra)
  }

  show() {
    this.channel?.show?.(true)
  }
}
