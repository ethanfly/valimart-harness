/**
 * 用环境变量里的真实 key 打一枪上游（不会把 key 打进日志）。
 *   OPENAI_API_KEY / CHATGPT_API_KEY      → OpenAI 兼容 /chat/completions
 *   ANTHROPIC_API_KEY                     → Anthropic /messages
 * 可选：OPENAI_BASE_URL、OPENAI_MODEL、ANTHROPIC_BASE_URL、ANTHROPIC_MODEL
 * 没有 key → 退出码 0 并打印 skipped（不让 CI 红）。
 */
import { anthropicHeaders, anthropicMessagesUrl, toAnthropicBody, toOpenAIResponse } from '../server/src/upstream-anthropic.js'

const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? 20000)

function has(name) {
  return Boolean(String(process.env[name] ?? '').trim())
}

async function probeOpenAI() {
  const key = process.env.OPENAI_API_KEY || process.env.CHATGPT_API_KEY
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly: pong' }], max_tokens: 16, stream: false }),
      signal: ac.signal,
    })
    const text = await r.text()
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`)
    const json = JSON.parse(text)
    const content = json.choices?.[0]?.message?.content ?? ''
    if (!content) throw new Error('空回复')
    return { ok: true, model, chars: content.length }
  } finally {
    clearTimeout(t)
  }
}

async function probeAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY
  const base = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1'
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const body = toAnthropicBody({ model, messages: [{ role: 'user', content: 'Reply with exactly: pong' }], max_tokens: 16, stream: false }, { upstreamModel: model })
    const r = await fetch(anthropicMessagesUrl(base), {
      method: 'POST',
      headers: anthropicHeaders(key),
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    const text = await r.text()
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`)
    const converted = toOpenAIResponse(JSON.parse(text), model)
    const content = converted.choices?.[0]?.message?.content ?? ''
    if (!content) throw new Error('空回复')
    return { ok: true, model, chars: content.length }
  } finally {
    clearTimeout(t)
  }
}

const jobs = []
if (has('OPENAI_API_KEY') || has('CHATGPT_API_KEY')) jobs.push(['openai', probeOpenAI])
if (has('ANTHROPIC_API_KEY')) jobs.push(['anthropic', probeAnthropic])

if (jobs.length === 0) {
  console.log('[probe] skipped：未设置 OPENAI_API_KEY / CHATGPT_API_KEY / ANTHROPIC_API_KEY')
  process.exit(0)
}

let failed = 0
for (const [name, fn] of jobs) {
  try {
    const r = await fn()
    console.log(`[probe] ${name} ok model=${r.model} chars=${r.chars}`)
  } catch (err) {
    failed++
    console.error(`[probe] ${name} fail: ${err.message}`)
  }
}
process.exit(failed ? 1 : 0)
