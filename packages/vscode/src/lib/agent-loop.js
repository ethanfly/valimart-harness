/**
 * Agent turn: POST /v1/chat/completions with workspace tools, execute tool calls, repeat.
 * The model HTTP body is the only thing tests should stub — this loop and the tools stay real.
 *
 * Contract that the sidebar relies on: runAgentLoop always resolves with a non-empty `text`
 * when the gateway answered at least once. It must never end a run silently — the "thinking
 * forever, then nothing" bug came from a thrown budget error that the UI could not show.
 */
import { applyChatOptions } from './chat-payload.js'
import { DEFAULT_CHAT_TIMEOUT_MS, isAbortError } from './gateway-client.js'
import { contentToText } from './sse.js'

export const DEFAULT_SYSTEM_PROMPT = `You are valimart harness, a coding agent inside VS Code.
You reach models only through the company-desk gateway (/v1/chat/completions) using a catalog model id.
Use the provided tools to read, write, and patch files in the user's workspace.
Paths are relative to the workspace root. Prefer apply_patch for small edits and write_file for new files.
When the user writes @path, that file's contents are inlined in the same message — read them from there instead of calling read_file again, and answer about that exact file.
Keep tool calls moving: after each batch of tool results, either continue with the next tool or answer the user.
When the work is done, reply in Chinese with what changed, where, and how to verify it.
If you cannot finish, say exactly what is blocked instead of stopping without an answer.
If a persistent /goal condition is set, keep working toward it.`

/**
 * 单轮任务的模型往返上限。0 = 不限制（默认），模型自己停或用户点「停止」。
 * 若设置了正数，到上限不会静默停止，而是发一次不带工具的收尾请求汇报进度。
 */
export const DEFAULT_MAX_TURNS = 0

export function hasTurnLimit(maxTurns) {
  return Number.isFinite(maxTurns) && maxTurns > 0
}
export const TOOL_RESULT_LIMIT = 24_000
export const CHAT_TIMEOUT_MS = DEFAULT_CHAT_TIMEOUT_MS
/** 单轮任务最长墙钟时间；超过就停止再调工具，先给用户一份进度总结。 */
export const DEFAULT_MAX_ELAPSED_MS = 8 * 60_000

export class AgentCancelledError extends Error {
  constructor(message = '已停止生成') {
    super(message)
    this.name = 'AgentCancelledError'
    this.code = 'cancelled'
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new AgentCancelledError()
}

function isCancelled(err) {
  return (
    err?.code === 'cancelled' ||
    err?.name === 'AgentCancelledError' ||
    err instanceof AgentCancelledError ||
    isAbortError(err)
  )
}

/**
 * Only role/content/tool_calls may go back to the gateway. Vendor extras
 * (reasoning_content, annotations, index, finish_reason…) make strict upstreams
 * reject the follow-up request right after the first tool round.
 */
export function normalizeAssistantMessage(msg, turn = 0) {
  const src = msg ?? {}
  const calls = (Array.isArray(src.tool_calls) ? src.tool_calls : []).map((call, i) => {
    const rawArgs = call?.function?.arguments ?? call?.arguments ?? '{}'
    return {
      id: call?.id ?? `call_${turn}_${i}`,
      type: 'function',
      function: {
        name: call?.function?.name ?? call?.name ?? '',
        arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {}),
      },
    }
  }).filter((c) => c.function.name)
  const content =
    typeof src.content === 'string' ? src.content : src.content == null ? (calls.length ? null : '') : contentToText(src.content)
  const out = { role: 'assistant', content }
  if (calls.length) out.tool_calls = calls
  const reasoning = contentToText(src.reasoning_content ?? src.reasoning)
  return { out, calls, reasoning }
}

export function serializeToolResult(result) {
  let text
  try {
    text = typeof result === 'string' ? result : JSON.stringify(result === undefined ? { ok: true } : result)
  } catch {
    text = String(result)
  }
  text = text ?? ''
  if (text.length <= TOOL_RESULT_LIMIT) return text
  const dropped = text.length - TOOL_RESULT_LIMIT
  return `${text.slice(0, TOOL_RESULT_LIMIT)}\n…工具结果过长，已截断 ${dropped} 字符；请缩小读取范围或按行分段再读。`
}

function summarizeWork(applied, toolNames, { maxTurns, elapsedSeconds, noReply, cancelled } = {}) {
  const names = Object.entries(toolNames ?? {})
  const lines = []
  if (cancelled) lines.push('已停止生成。')
  if (noReply) lines.push('模型没有返回文字说明。')
  if (maxTurns) lines.push(`已达到单轮 ${maxTurns} 次模型往返上限，任务可能尚未完成。`)
  if (elapsedSeconds) lines.push(`本轮已用时约 ${Math.round(elapsedSeconds)} 秒，已提前收尾，任务可能尚未完成。`)
  if (applied?.length) {
    lines.push(`已改动 ${applied.length} 个文件：${applied.map((a) => a.path ?? a.abs).join('、')}`)
  }
  if (names.length) lines.push(`本轮调用过的工具：${names.map(([n, c]) => `${n}×${c}`).join('、')}`)
  if (!applied?.length && !names.length) lines.push('没有产生任何文件改动。')
  if (!cancelled) lines.push('可继续发送“接着做”，我会带着已有上下文往下推进。')
  return lines.join('\n')
}

export async function runAgentLoop({
  client,
  tools,
  model,
  userMessage,
  effort,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  extraMessages = [],
  maxTurns = DEFAULT_MAX_TURNS,
  timeoutMs = CHAT_TIMEOUT_MS,
  maxElapsedMs = DEFAULT_MAX_ELAPSED_MS,
  onEvent,
  signal,
} = {}) {
  if (!client?.chatCompletions) throw new Error('runAgentLoop requires a gateway client with chatCompletions')
  if (!tools?.execute) throw new Error('runAgentLoop requires workspace tools')
  if (!model) throw new Error('runAgentLoop requires a catalog model id')

  const messages = [
    { role: 'system', content: systemPrompt },
    ...extraMessages,
    { role: 'user', content: userMessage },
  ]
  const applied = []
  const toolNames = {}
  const startedAt = Date.now()
  let lastReasoning = ''

  async function chat(body, { stream = true } = {}) {
    throwIfAborted(signal)
    return client.chatCompletions(applyChatOptions(body, { model, effort }), {
      timeoutMs,
      signal,
      onDelta: stream
        ? (delta) => {
            if (signal?.aborted) return
            onEvent?.({ type: 'delta', text: delta.text ?? '', reasoning: delta.reasoning ?? '' })
          }
        : undefined,
    })
  }

  /** 收尾：不再给工具，只要模型（或本地兜底）说一句“目前到哪了”。 */
  async function wrapUp(reason, turn) {
    onEvent?.({ type: reason === 'elapsed' ? 'time-limit' : reason === 'cancelled' ? 'cancelled' : 'max-turns', turns: turn, model, effort })
    if (reason === 'cancelled') {
      const text = summarizeWork(applied, toolNames, { cancelled: true })
      onEvent?.({ type: 'assistant', text, turn, reasoning: lastReasoning })
      return { text, messages, applied, turns: turn, model, stopReason: 'cancelled', toolNames, reasoning: lastReasoning }
    }
    let text = ''
    try {
      messages.push({
        role: 'user',
        content:
          reason === 'elapsed'
            ? `本轮已用时超过 ${Math.max(1, Math.round(maxElapsedMs / 60_000))} 分钟。请停止调用工具，用中文说明：已经完成了哪些改动、还差哪些步骤、用户下一步该做什么。`
            : `已达到 ${maxTurns} 次模型往返上限。请停止调用工具，用中文说明：已经完成了哪些改动、还差哪些步骤、用户下一步该做什么。`,
      })
      const res = await chat({ model, messages }, { stream: true })
      text = contentToText(res?.choices?.[0]?.message?.content).trim()
      lastReasoning = contentToText(res?.choices?.[0]?.message?.reasoning_content) || lastReasoning
    } catch (err) {
      if (isCancelled(err)) return wrapUp('cancelled', turn)
      /* the fallback summary below still guarantees an answer */
    }
    if (!text) {
      text =
        reason === 'elapsed'
          ? summarizeWork(applied, toolNames, { elapsedSeconds: (Date.now() - startedAt) / 1000 })
          : summarizeWork(applied, toolNames, { maxTurns })
    }
    if (reason === 'elapsed' && text && !/超过|分钟/.test(text)) text = `本轮用时较长，已提前收尾。\n\n${text}`
    onEvent?.({ type: 'assistant', text, turn, reasoning: lastReasoning })
    return { text, messages, applied, turns: turn, model, stopReason: reason, toolNames, reasoning: lastReasoning }
  }

  const limited = hasTurnLimit(maxTurns)
  for (let turn = 0; !limited || turn < maxTurns; turn++) {
    if (signal?.aborted) return await wrapUp('cancelled', turn)
    if (turn > 0 && Date.now() - startedAt > maxElapsedMs) return await wrapUp('elapsed', turn)
    onEvent?.({
      type: 'request',
      turn,
      turnCount: turn + 1,
      maxTurns: limited ? maxTurns : 0,
      model,
      effort,
    })
    let res
    try {
      res = await chat({
        model,
        messages,
        tools: tools.definitions,
        tool_choice: 'auto',
      })
    } catch (err) {
      if (isCancelled(err)) return await wrapUp('cancelled', turn)
      throw err
    }
    const choice = res?.choices?.[0]
    if (!Array.isArray(res?.choices) || !choice) {
      throw new Error('公司网关没有返回模型内容（choices 为空），请重试或切换模型')
    }
    const { out, calls, reasoning } = normalizeAssistantMessage(choice.message, turn)
    if (reasoning) lastReasoning = reasoning
    messages.push(out)

    if (!calls.length) {
      const text =
        typeof out.content === 'string' && out.content.trim()
          ? out.content
          : summarizeWork(applied, toolNames, { noReply: true })
      onEvent?.({ type: 'assistant', text, turn, reasoning: lastReasoning })
      return { text, messages, applied, turns: turn + 1, model, stopReason: choice.finish_reason ?? 'stop', toolNames, reasoning: lastReasoning }
    }

    for (const call of calls) {
      if (signal?.aborted) return await wrapUp('cancelled', turn)
      const name = call.function.name
      let args = {}
      try {
        args = JSON.parse(call.function.arguments || '{}')
      } catch {
        args = {}
      }
      onEvent?.({ type: 'tool-start', name, args, turn })
      let result
      try {
        result = await tools.execute(name, args)
        if (name === 'write_file' || name === 'apply_patch') {
          applied.push({ name, path: result?.path, abs: result?.abs })
        }
      } catch (err) {
        result = { error: err?.message ?? String(err) }
      }
      toolNames[name] = (toolNames[name] ?? 0) + 1
      onEvent?.({ type: 'tool', name, args, result, turn })
      messages.push({ role: 'tool', tool_call_id: call.id, content: serializeToolResult(result) })
    }
  }

  // Turn budget spent: hand it to wrapUp so the run always ends with visible text.
  return await wrapUp('max_turns', maxTurns)
}
