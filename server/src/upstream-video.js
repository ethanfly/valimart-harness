/**
 * 视频生成：OpenAI 形态的 /videos/generations ↔ 各家异步任务。
 *
 * 只覆盖公司网关会碰到、且不说 OpenAI /videos 的三家：
 *   - 阿里云百炼万相：POST {origin}/api/v1/services/aigc/video-generation/video-synthesis（异步）
 *   - MiniMax 海螺：POST {origin}/v1/video_generation → GET /v1/query/video_generation → GET /v1/files/retrieve
 *   - 火山方舟 Seedance：POST {origin}/api/v3/contents/generations/tasks → GET 同路径/{id}
 * 轮询到完成，统一回 { data: [{ url }] }。Grok / Sora 走 OpenAI 兼容，不进这里。
 */
import { HttpError } from './http.js'

const HOST = {
  dashscope: /(^|\.)dashscope(-intl)?\.aliyuncs\.com$/i,
  minimax: /(^|\.)minimax\.chat$|(^|\.)minimaxi\.com$|(^|\.)minimax\.io$/i,
  volcengine: /(^|\.)volces\.com$|(^|\.)volcengine\.com$/i,
}

export function videoVendor(upstream) {
  if (!upstream) return ''
  const api = String(upstream.api ?? '')
  if (api === 'dashscope-video' || api === 'dashscope-images') return 'dashscope'
  if (api === 'minimax-video') return 'minimax'
  if (api === 'seedance-video' || api === 'volcengine-video') return 'volcengine'
  if (api && api !== 'openai-compatible') return ''
  let host = ''
  try {
    host = new URL(String(upstream.baseUrl ?? '')).hostname
  } catch {
    return ''
  }
  for (const [name, re] of Object.entries(HOST)) if (re.test(host)) return name
  return ''
}

function originOf(baseUrl) {
  try {
    return new URL(String(baseUrl)).origin
  } catch {
    throw new HttpError(400, '视频通道的 baseUrl 不是合法 URL', 'bad_base_url')
  }
}

function imageUrl(ref) {
  const s = String(ref ?? '')
  if (!s) return ''
  if (/^(data:|https?:)/i.test(s)) return s
  return `data:image/png;base64,${s}`
}

function refsOf(body) {
  const list = []
  if (Array.isArray(body.images)) list.push(...body.images)
  if (body.image != null) list.unshift(body.image)
  if (body.image_url != null) list.push(body.image_url)
  return [...new Set(list.map(imageUrl).filter(Boolean))].slice(0, 5)
}

const SIZE = { '16:9': '1280*720', '9:16': '720*1280', '1:1': '960*960', '4:3': '1104*832', '3:4': '832*1104' }
const RATIO_TO_SEEDANCE = { '16:9': '16:9', '9:16': '9:16', '1:1': '1:1', '4:3': '4:3', '3:4': '3:4' }

export function toVendorBody(vendor, body, modelId) {
  const prompt = String(body.prompt ?? '')
  const refs = refsOf(body)
  const duration = Math.max(1, Math.round(Number(body.duration) || 6))
  const ratio = String(body.aspect_ratio ?? '16:9')
  if (vendor === 'dashscope') {
    const input = { prompt }
    if (refs.length === 1) input.img_url = refs[0]
    if (refs.length > 1) input.reference_urls = refs
    return {
      model: modelId,
      input,
      parameters: { size: SIZE[ratio] ?? SIZE['16:9'], duration, prompt_extend: true },
    }
  }
  if (vendor === 'minimax') {
    const out = { model: modelId, prompt, duration }
    if (refs[0]) out.first_frame_image = refs[0]
    return out
  }
  const content = [{ type: 'text', text: prompt }]
  for (const url of refs) content.push({ type: 'image_url', image_url: { url }, role: content.length === 1 ? 'first_frame' : 'reference_image' })
  return { model: modelId, content, duration, ratio: RATIO_TO_SEEDANCE[ratio] ?? '16:9' }
}

/** 创建任务的响应 → { id, url, status, error }。 */
export function parseCreate(vendor, json) {
  const out = json?.output ?? json?.data ?? json ?? {}
  const id = String(out.task_id ?? json?.task_id ?? out.id ?? json?.id ?? '')
  const url = String(out.video_url ?? out.url ?? json?.video_url ?? '')
  const status = String(out.task_status ?? json?.status ?? out.status ?? (id ? 'pending' : ''))
  const error = String(json?.base_resp?.status_msg ?? json?.message ?? json?.error?.message ?? '')
  if (vendor === 'minimax' && json?.base_resp && json.base_resp.status_code && json.base_resp.status_code !== 0 && !id) {
    return { id: '', url: '', status: 'failed', error: error || `MiniMax ${json.base_resp.status_code}` }
  }
  return { id, url, status, error }
}

/** 轮询响应 → { url, status, error, fileId }。status 归一成 pending | succeeded | failed。 */
export function parsePoll(vendor, json) {
  if (vendor === 'minimax') {
    const status = String(json?.status ?? '').toLowerCase()
    const failed = status === 'fail' || status === 'failed'
    return {
      url: '',
      fileId: String(json?.file_id ?? ''),
      status: failed ? 'failed' : status === 'success' ? 'succeeded' : 'pending',
      error: String(json?.base_resp?.status_msg ?? ''),
    }
  }
  if (vendor === 'volcengine') {
    const status = String(json?.status ?? json?.data?.status ?? '').toLowerCase()
    const url = String(json?.content?.video_url ?? json?.data?.content?.video_url ?? '')
    const failed = status === 'failed' || status === 'cancelled' || status === 'expired'
    return { url, fileId: '', status: url || status === 'succeeded' ? 'succeeded' : failed ? 'failed' : 'pending', error: String(json?.error?.message ?? '') }
  }
  const out = json?.output ?? {}
  const status = String(out.task_status ?? '').toUpperCase()
  const url = String(out.video_url ?? out.results?.[0]?.url ?? '')
  const failed = status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN'
  return { url, fileId: '', status: url || status === 'SUCCEEDED' ? 'succeeded' : failed ? 'failed' : 'pending', error: String(json?.message ?? out.message ?? '') }
}

/**
 * 提交 + 轮询，返回 OpenAI 形态的 Response。
 * ponytail: 轮询间隔固定 3s、总超时 10 分钟；上游排队更久时再把 DESK_VIDEO_POLL_MS 调大。
 */
export async function runVendorVideo(upstream, body, model, { fetchImpl = globalThis.fetch, signal, sleep, now = Date.now } = {}) {
  const vendor = videoVendor(upstream)
  if (!vendor) return null
  const origin = originOf(upstream.baseUrl)
  const modelId = model.upstreamModel ?? model.id
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${upstream.resolvedKey}` }
  const post = async (url, payload, extra = {}) => {
    const res = await fetchImpl(url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(payload), signal })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON 留原文 */ }
    return { res, text, json }
  }
  const get = async (url) => {
    const res = await fetchImpl(url, { headers, signal })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* ignore */ }
    return { res, text, json }
  }

  const createUrl = {
    dashscope: `${origin}/api/v1/services/aigc/video-generation/video-synthesis`,
    minimax: `${origin}/v1/video_generation`,
    volcengine: `${origin}/api/v3/contents/generations/tasks`,
  }[vendor]
  const extra = vendor === 'dashscope' ? { 'x-dashscope-async': 'enable' } : {}
  const created = await post(createUrl, toVendorBody(vendor, body, modelId), extra)
  if (!created.res.ok) {
    return new Response(created.text || JSON.stringify({ error: { message: `${vendor} HTTP ${created.res.status}` } }), {
      status: created.res.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  const task = parseCreate(vendor, created.json)
  if (task.url) return done(task.url)
  if (!task.id) throw new HttpError(502, task.error || `${vendor} 没有返回任务 id`, 'empty')

  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const pollMs = Number(process.env.DESK_VIDEO_POLL_MS || 3000)
  const timeoutMs = Number(process.env.DESK_VIDEO_TIMEOUT_MS || 600_000)
  // now 可注入：测试里每调一次往前走 pollMs，真实路径就是 Date.now。
  const clock = typeof now === 'function' ? (() => { let t = now(); return () => (t += pollMs) - pollMs })() : () => Date.now()
  const deadline = clock() + timeoutMs
  while (clock() < deadline) {
    await wait(pollMs)
    const pollUrl = {
      dashscope: `${origin}/api/v1/tasks/${encodeURIComponent(task.id)}`,
      minimax: `${origin}/v1/query/video_generation?task_id=${encodeURIComponent(task.id)}`,
      volcengine: `${origin}/api/v3/contents/generations/tasks/${encodeURIComponent(task.id)}`,
    }[vendor]
    const polled = await get(pollUrl)
    if (!polled.res.ok) throw new HttpError(502, polled.text?.slice(0, 240) || `${vendor} 轮询 HTTP ${polled.res.status}`, 'upstream_error')
    const state = parsePoll(vendor, polled.json)
    if (state.status === 'failed') throw new HttpError(502, state.error || `${vendor} 任务失败`, 'upstream_failed')
    if (state.status !== 'succeeded') continue
    if (state.url) return done(state.url)
    if (vendor === 'minimax' && state.fileId) {
      const file = await get(`${origin}/v1/files/retrieve?file_id=${encodeURIComponent(state.fileId)}`)
      const url = String(file.json?.file?.download_url ?? '')
      if (!url) throw new HttpError(502, 'MiniMax 没有返回下载地址', 'empty')
      return done(url)
    }
    throw new HttpError(502, `${vendor} 任务完成但没有视频地址`, 'empty')
  }
  throw new HttpError(504, `${vendor} 视频生成超时`, 'timeout')
}

function done(url) {
  return new Response(JSON.stringify({ created: Math.floor(Date.now() / 1000), data: [{ url }] }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
