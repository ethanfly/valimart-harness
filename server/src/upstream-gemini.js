/** OpenAI chat ↔ Gemini Code Assist subscription transport.
 * Wire protocol: google-gemini/gemini-cli packages/core/src/code_assist/{server,converter,setup}.ts
 * No AI Studio API key or extra paid-credit opt-in is used here.
 */
import crypto from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { HttpError } from './http.js'
import { GEMINI_MIGRATION_NOTICE } from './oauth-providers/gemini.js'

export const usesGeminiCodeAssist = (upstream) => upstream?.api === 'gemini-code-assist'
export const usesAntigravity = (upstream) => upstream?.api === 'antigravity'
export const usesCloudCodePa = (upstream) => usesGeminiCodeAssist(upstream) || usesAntigravity(upstream)
export const GEMINI_BASE_URL = 'https://cloudcode-pa.googleapis.com/v1internal'
const metadata = { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }

export function geminiBaseUrl(baseUrl = GEMINI_BASE_URL) {
  const base = String(baseUrl).replace(/\/+$/, '')
  return base.endsWith('/v1internal') ? base : `${base}/v1internal`
}

function headers(credential, { api, accept } = {}) {
  return {
    authorization: `Bearer ${credential}`,
    'content-type': 'application/json',
    accept: accept || 'application/json',
    ...(api === 'antigravity' ? { 'user-agent': 'antigravity' } : {}),
  }
}

function projectIdOf(value) {
  const id = typeof value === 'string' ? value : value?.id
  return typeof id === 'string' && id.trim() ? id.trim() : undefined
}

export async function setupGeminiProject({ credential, baseUrl, projectId, fetchImpl = fetch, signal, pollMs = 1000 } = {}) {
  if (!String(credential ?? '').trim()) throw new HttpError(400, '请先登录 Google 账号或粘贴访问令牌。', 'gemini_credential_required')
  const timeout = AbortSignal.timeout(60_000)
  signal = signal ? AbortSignal.any([signal, timeout]) : timeout
  const base = geminiBaseUrl(baseUrl)
  const request = async (suffix, body) => {
    const r = await fetchImpl(`${base}${suffix}`, {
      method: body ? 'POST' : 'GET', headers: headers(credential, { api: 'gemini-code-assist' }),
      ...(body ? { body: JSON.stringify(body) } : {}), signal,
    })
    const data = await r.json().catch(() => ({}))
    const reasons = [data.error?.message, ...(Array.isArray(data.ineligibleTiers) ? data.ineligibleTiers.map((t) => t.reasonMessage) : [])].filter((s) => typeof s === 'string').join(' ')
    if (/client is no longer supported|migrate to the Antigravity/i.test(reasons)) throw new HttpError(403, GEMINI_MIGRATION_NOTICE, 'gemini_client_retired')
    if (!r.ok) throw new HttpError(r.status, `Google 订阅初始化失败（HTTP ${r.status}）。个人 AI Pro / Ultra 已停用旧 Gemini CLI 接入；Code Assist 企业账号请检查授权。`, 'gemini_setup_failed')
    if (data.error) throw new HttpError(400, 'Google Code Assist 初始化失败。个人 AI Pro / Ultra 应迁移到 Antigravity；企业账号请检查授权。', 'gemini_setup_failed')
    return data
  }
  const loadBody = {
    ...(projectId ? { cloudaicompanionProject: projectId } : {}),
    metadata: { ...metadata, ...(projectId ? { duetProject: projectId } : {}) },
  }
  const loaded = await request(':loadCodeAssist', loadBody)
  if (loaded.currentTier) {
    const project = projectIdOf(loaded.cloudaicompanionProject) || projectIdOf(projectId)
    if (project) return project
    throw new HttpError(400, 'Google 未返回该账号的项目。个人 AI Pro / Ultra 已停用此接入，应迁移到 Antigravity；Code Assist 企业账号请检查 oauth.gemini.projectId。', 'gemini_project_required')
  }
  if (loaded.ineligibleTiers?.some((t) => t.reasonCode === 'VALIDATION_REQUIRED')) {
    throw new HttpError(400, 'Google 要求验证账号。Code Assist 企业账号请完成官方验证；个人 AI Pro / Ultra 应迁移到 Antigravity。', 'gemini_validation_required')
  }
  const tier = loaded.allowedTiers?.find((t) => t.isDefault)
  if (!tier?.id) throw new HttpError(403, '该账号没有可用的旧 Gemini Code Assist 接入权益。个人 AI Pro / Ultra 应迁移到 Antigravity。', 'gemini_ineligible')
  const requestedProject = tier.id === 'free-tier' ? undefined : projectId
  let op = await request(':onboardUser', {
    tierId: tier.id, cloudaicompanionProject: requestedProject,
    metadata: { ...metadata, ...(requestedProject ? { duetProject: requestedProject } : {}) },
  })
  const operationName = op.name
  if (!op.done && !operationName) throw new HttpError(502, 'Google 开通任务尚未完成，但未返回任务编号，请重新登录重试。', 'gemini_operation_missing')
  if (!op.done) {
    // Operation names are relative API paths; never follow a server-supplied URL.
    if (!/^operations\/[A-Za-z0-9_./-]+$/.test(operationName) || operationName.includes('..')) throw new HttpError(502, 'Google 返回无效初始化任务', 'gemini_setup_failed')
  }
  while (!op.done) {
    await delay(pollMs, undefined, { signal })
    op = await request(`/${operationName}`)
  }
  const project = projectIdOf(op.response?.cloudaicompanionProject) || projectIdOf(projectId)
  if (project) return project
  // Provisioning can finish before loadCodeAssist exposes the managed project.
  // Re-read account state with a bounded retry, without restarting onboarding.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await delay(pollMs, undefined, { signal })
    const refreshed = await request(':loadCodeAssist', loadBody)
    const assigned = projectIdOf(refreshed.cloudaicompanionProject)
    if (assigned) return assigned
  }
  if (tier.userDefinedCloudaicompanionProject) throw new HttpError(400, 'Google 未返回项目；该账号的开通层级要求自有 Google Cloud 项目，请配置 oauth.gemini.projectId 后重新登录。', 'gemini_project_required')
  throw new HttpError(400, 'Google 复查后仍未分配账号项目。个人 AI Pro / Ultra 已停用旧 Gemini CLI 接入，应迁移到 Antigravity；企业账号需检查 Code Assist 开通状态。', 'gemini_project_unassigned')
}

function contentParts(content) {
  if (typeof content === 'string') return content ? [{ text: content }] : []
  return (content ?? []).map((part) => {
    if (part.type === 'text') return { text: part.text }
    if (part.type === 'image_url') {
      const url = part.image_url?.url ?? part.image_url
      const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url)
      if (match) return { inlineData: { mimeType: match[1], data: match[2] } }
      // Do not fetch arbitrary URLs on the gateway's network.
      throw new HttpError(400, 'Gemini 订阅图片需以 base64 data URL 提交。', 'gemini_image_unsupported')
    }
    throw new HttpError(400, 'Gemini 订阅不支持此消息内容类型。', 'gemini_content_unsupported')
  })
}

// Preserve Google's opaque thought signature through clients which retain tool IDs
// but drop provider-specific extra fields. It is response metadata, not a credential.
const SIGNATURE_MARK = '__gts_'
function toolId(signature) {
  return `call_${crypto.randomUUID().replaceAll('-', '')}${signature ? SIGNATURE_MARK + Buffer.from(signature).toString('base64url') : ''}`
}
function toolSignature(call) {
  const signature = call.extra_content?.google?.thought_signature
  if (signature) return signature
  const index = String(call.id).indexOf(SIGNATURE_MARK)
  return index < 0 ? undefined : Buffer.from(call.id.slice(index + SIGNATURE_MARK.length), 'base64url').toString()
}

export function toGeminiBody(body, model, project) {
  if (body.n != null && body.n !== 1) throw new HttpError(400, 'Gemini 订阅每次只支持一个候选回复。', 'gemini_candidate_count')
  const contents = []
  const system = []
  const calls = new Map()
  for (const message of body.messages ?? []) {
    if (message.role === 'system' || message.role === 'developer') {
      system.push(...contentParts(message.content))
      continue
    }
    let parts
    if (message.role === 'tool') {
      const name = calls.get(message.tool_call_id)
      if (!name) throw new HttpError(400, 'Gemini 工具结果缺少对应的工具调用。', 'gemini_tool_mismatch')
      let result = message.content
      if (typeof result === 'string') { try { result = JSON.parse(result) } catch { /* plain text */ } }
      parts = [{ functionResponse: { name, response: { output: result } } }]
    } else {
      parts = contentParts(message.content)
      for (const call of message.tool_calls ?? []) {
        calls.set(call.id, call.function.name)
        let args
        try { args = JSON.parse(call.function.arguments || '{}') } catch { throw new HttpError(400, 'Gemini 工具参数不是有效 JSON。', 'gemini_tool_arguments') }
        const signature = toolSignature(call)
        parts.push({ functionCall: { name: call.function.name, args }, ...(signature ? { thoughtSignature: signature } : {}) })
      }
    }
    if (!parts.length) continue
    const role = message.role === 'assistant' ? 'model' : 'user'
    if (contents.at(-1)?.role === role) contents.at(-1).parts.push(...parts)
    else contents.push({ role, parts })
  }
  const generationConfig = { maxOutputTokens: body.max_completion_tokens ?? body.max_tokens ?? model.maxTokens ?? 8192 }
  if (body.temperature != null) generationConfig.temperature = body.temperature
  if (body.top_p != null) generationConfig.topP = body.top_p
  if (body.stop) generationConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop]
  if (body.response_format?.type === 'json_object' || body.response_format?.type === 'json_schema') {
    generationConfig.responseMimeType = 'application/json'
    if (body.response_format.json_schema?.schema) generationConfig.responseJsonSchema = body.response_format.json_schema.schema
  }
  if (body.reasoning_effort) {
    const effort = body.reasoning_effort
    generationConfig.thinkingConfig = /^gemini-3/.test(model.upstreamModel || body.model)
      ? { thinkingLevel: effort === 'low' || effort === 'minimal' ? 'LOW' : 'HIGH' }
      : { thinkingBudget: ({ none: 0, minimal: 128, low: 1024, medium: 8192, high: 16384 })[effort] ?? -1 }
  }
  const request = { contents, generationConfig }
  if (system.length) request.systemInstruction = { parts: system }
  const functions = (body.tools ?? []).filter((t) => t.type === 'function').map((t) => ({ name: t.function.name, description: t.function.description, parametersJsonSchema: t.function.parameters }))
  if (functions.length) {
    request.tools = [{ functionDeclarations: functions }]
    const choice = body.tool_choice
    request.toolConfig = { functionCallingConfig: {
      mode: choice === 'none' ? 'NONE' : choice === 'required' || choice?.type === 'function' ? 'ANY' : 'AUTO',
      ...(choice?.type === 'function' ? { allowedFunctionNames: [choice.function.name] } : {}),
    } }
  }
  return { model: model.upstreamModel || body.model, project, user_prompt_id: crypto.randomUUID(), request }
}

function usageOf(value = {}) {
  const prompt = value.promptTokenCount ?? 0
  const completion = (value.candidatesTokenCount ?? 0) + (value.thoughtsTokenCount ?? 0)
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: value.totalTokenCount ?? prompt + completion, prompt_tokens_details: { cached_tokens: value.cachedContentTokenCount ?? 0 } }
}
function finishReason(reason, calls) {
  if (reason === 'MAX_TOKENS') return 'length'
  if (reason && reason !== 'STOP') return 'content_filter'
  return calls ? 'tool_calls' : 'stop'
}
function unpack(data) {
  if (data.error) throw new Error('Gemini 返回生成错误')
  const response = data.response ?? data
  if (response.error) throw new Error('Gemini 返回生成错误')
  return response
}
function deltaOf(candidate, nextIndex) {
  const delta = {}
  for (const part of candidate?.content?.parts ?? []) {
    if (part.text) {
      const key = part.thought ? 'reasoning_content' : 'content'
      delta[key] = (delta[key] ?? '') + part.text
    }
    if (part.functionCall) {
      delta.tool_calls ??= []
      delta.tool_calls.push({ index: nextIndex(), id: toolId(part.thoughtSignature), type: 'function', function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) } })
    }
  }
  return delta
}

export function fromGeminiResponse(data, model) {
  const response = unpack(data)
  const candidate = response.candidates?.[0]
  if (!candidate && !response.promptFeedback?.blockReason) throw new Error('Gemini 未返回候选结果')
  let index = 0
  const delta = deltaOf(candidate, () => index++)
  const message = { role: 'assistant', content: delta.content ?? null, ...delta }
  if (message.tool_calls) message.tool_calls = message.tool_calls.map(({ index: _i, ...call }) => call)
  return { id: `chatcmpl-${crypto.randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message, finish_reason: finishReason(response.promptFeedback?.blockReason || candidate?.finishReason, index) }], usage: usageOf(response.usageMetadata) }
}

export function createGeminiSseTranslator({ model }) {
  let pending = '', ended = false, finished = false, calls = 0, started = false, usage
  const id = `chatcmpl-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const chunk = (choices, extra = {}) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices, ...extra })}\n\n`
  const event = (raw) => {
    const payload = raw.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
    if (!payload || payload === '[DONE]') return []
    const response = unpack(JSON.parse(payload))
    if (response.usageMetadata) usage = usageOf(response.usageMetadata)
    const candidate = response.candidates?.[0]
    const out = []
    if (!started) { out.push(chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }])); started = true }
    const delta = deltaOf(candidate, () => calls++)
    if (Object.keys(delta).length) out.push(chunk([{ index: 0, delta, finish_reason: null }]))
    const reason = candidate?.finishReason || response.promptFeedback?.blockReason
    if (reason && !finished) {
      finished = true
      out.push(chunk([{ index: 0, delta: {}, finish_reason: finishReason(reason, calls) }]))
    }
    return out
  }
  return {
    get usage() { return usage },
    push(text) {
      if (ended) return []
      pending += text
      pending = pending.replace(/\r\n/g, '\n')
      const out = []
      let index
      while ((index = pending.indexOf('\n\n')) >= 0) { out.push(...event(pending.slice(0, index))); pending = pending.slice(index + 2) }
      return out
    },
    end() {
      if (ended) return []
      ended = true
      const out = pending.trim() ? event(pending) : []
      pending = ''
      if (!finished) throw new Error('Gemini 流式响应提前结束')
      if (usage) out.push(chunk([], { usage }))
      out.push('data: [DONE]\n\n')
      return out
    },
  }
}

export async function sendGeminiRequest(upstream, body, model, { stream = false, signal, fetchImpl = fetch } = {}) {
  const project = usesAntigravity(upstream)
    ? upstream.googleProjectId
    : (upstream.googleProjectId || await setupGeminiProject({ credential: upstream.resolvedKey, baseUrl: upstream.baseUrl, fetchImpl, signal }))
  const forward = toGeminiBody(body, model, project)
  if (!forward.project) delete forward.project
  const r = await fetchImpl(`${geminiBaseUrl(upstream.baseUrl)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, {
    method: 'POST',
    headers: headers(upstream.resolvedKey, { api: upstream.api, accept: stream ? 'text/event-stream' : 'application/json' }),
    body: JSON.stringify(forward),
    signal,
  })
  if (!r.ok) return r
  if (!stream) return Response.json(fromGeminiResponse(await r.json(), model.id))
  const translator = createGeminiSseTranslator({ model: model.id })
  const decoder = new TextDecoder(), encoder = new TextEncoder()
  const converted = r.body.pipeThrough(new TransformStream({
    transform(value, controller) { for (const piece of translator.push(decoder.decode(value, { stream: true }))) controller.enqueue(encoder.encode(piece)) },
    flush(controller) {
      for (const piece of [...translator.push(decoder.decode()), ...translator.end()]) controller.enqueue(encoder.encode(piece))
    },
  }))
  return new Response(converted, { headers: { 'content-type': 'text/event-stream' } })
}
