/**
 * 阿里云百炼 / DashScope：OpenAI /images/* ↔ 原生出图接口。
 *
 * DashScope 的 OpenAI 兼容模式只做对话，没有 /images/*（实测 404），出图要走原生接口：
 *   - qwen-image 系列：POST {origin}/api/v1/services/aigc/multimodal-generation/generation（同步）
 *     响应 output.choices[0].message.content[].image（图片 URL）
 *   - wanx 系列：POST {origin}/api/v1/services/aigc/text2image/image-synthesis
 *     （X-DashScope-Async: enable）→ output.task_id → GET {origin}/api/v1/tasks/{id}
 */
import { HttpError } from './http.js'

export function usesDashscopeImages(upstream) {
  if (!upstream) return false
  if (upstream.api === 'dashscope-images') return true
  if (upstream.api && upstream.api !== 'openai-compatible') return false
  try {
    const u = new URL(String(upstream.baseUrl ?? ''))
    return /(^|\.)dashscope(-intl)?\.aliyuncs\.com$/i.test(u.hostname)
  } catch {
    return false
  }
}

export function dashscopeOrigin(baseUrl) {
  try {
    return new URL(String(baseUrl)).origin
  } catch {
    throw new HttpError(400, 'DashScope 通道的 baseUrl 不是合法 URL', 'bad_base_url')
  }
}

/** aspect_ratio / size → DashScope 尺寸写法（"1328*1328"）。 */
export function dashscopeImageSize(body = {}) {
  const explicit = String(body.size ?? '').trim()
  if (/^\d{3,4}[x*]\d{3,4}$/i.test(explicit)) return explicit.replace(/x/i, '*')
  const ratio = String(body.aspect_ratio ?? '').trim()
  const map = { '1:1': '1328*1328', '16:9': '1664*928', '9:16': '928*1664', '4:3': '1472*1104', '3:4': '1104*1472' }
  return map[ratio] ?? '1328*1328'
}

function imageRefToUrl(ref) {
  const s = String(ref ?? '')
  if (!s) return ''
  if (/^(data:|https?:)/i.test(s)) return s
  return `data:image/png;base64,${s}`
}

/** OpenAI /images/generations|edits 的 body → DashScope 原生请求体。 */
export function toDashscopeImageBody(openaiBody, model, { async = false } = {}) {
  const prompt = String(openaiBody.prompt ?? '')
  const ref = openaiBody.image ?? openaiBody.image_url ?? (Array.isArray(openaiBody.images) ? openaiBody.images[0] : null)
  if (async) {
    const input = { prompt }
    if (ref) input.base_image_url = imageRefToUrl(ref)
    return { model, input, parameters: { size: dashscopeImageSize(openaiBody), n: 1 } }
  }
  const content = []
  const url = imageRefToUrl(ref)
  if (url) content.push({ image: url })
  content.push({ text: prompt })
  return {
    model,
    input: { messages: [{ role: 'user', content }] },
    parameters: { prompt_extend: true, watermark: false, size: dashscopeImageSize(openaiBody) },
  }
}

/** 同步响应 / 任务轮询响应 → { url, b64, taskId, status, revisedPrompt, usage, error } */
export function parseDashscopeImage(json) {
  const out = json?.output ?? {}
  const parts = out.choices?.[0]?.message?.content
  const pick = (key) => (Array.isArray(parts) ? parts.find((p) => p?.[key])?.[key] : undefined)
  const results = Array.isArray(out.results) ? out.results : []
  const usage = json?.usage
  return {
    url: String(pick('image') ?? pick('image_url') ?? results[0]?.url ?? ''),
    b64: String(pick('b64_json') ?? results[0]?.b64_json ?? ''),
    revisedPrompt: String(pick('revised_prompt') ?? ''),
    taskId: String(out.task_id ?? ''),
    status: String(out.task_status ?? ''),
    usage: usage
      ? {
          prompt_tokens: usage.input_tokens ?? 0,
          completion_tokens: usage.output_tokens ?? (usage.image_count ?? 0) * 1000,
          total_tokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        }
      : null,
    error: String(json?.message ?? json?.error?.message ?? ''),
    code: String(json?.code ?? json?.error?.code ?? ''),
  }
}
