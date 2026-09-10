/**
 * Mixed P0 探测用脚本化 OpenAI 兼容模型服务器。
 *
 * 三个「模型」按请求 body.model 路由，行为完全脚本化（不打真实上游）：
 *   mock-planner   有 structured_output 工具 → 回一个 JSON 规划（工具调用）；否则回规划文本
 *   mock-executor  第一回合调用 write 工具落一个文件；第二回合（有 tool 结果后）
 *                  有 structured_output 就回结构化交接，否则回交接文本
 *   mock-reviewer  有 structured_output 工具 → 回结构化审核结论；否则回文本
 *   mock-slow      慢速流式（每 250ms 一个小 chunk，最多 60s），用于取消/中断测试
 *   mock-error     一律 500
 *
 * 每个请求记入内存日志（ts、model、method、path、auth、headers、body 摘要），
 * 连接在响应完成前断开记 aborted=true —— 这是取消证据的来源。
 * GET /_log?since=<index> 取增量日志；POST /_reset 清空。
 *
 * 注意：这里返回的 usage 是伪造的稳定值（每个模型固定 token 数），
 * 供网关账本与 session usage 断言用，不代表真实 token 计量。
 */
import http from 'node:http'

const FIXED_USAGE = {
  'mock-planner': { prompt_tokens: 101, completion_tokens: 201, total_tokens: 302 },
  'mock-executor': { prompt_tokens: 102, completion_tokens: 202, total_tokens: 304 },
  'mock-reviewer': { prompt_tokens: 103, completion_tokens: 203, total_tokens: 306 },
  'mock-slow': { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  'mock-error': { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

/** 该请求的 messages 里最后一条 role=tool？（= 工具结果后的第二回合） */
function sawToolResult(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  return messages.some((m) => m && m.role === 'tool')
}

/** 工具清单里是否有指定工具（OpenAI tools 形状）。 */
function offersTool(body, name) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  return tools.some((t) => t?.function?.name === name || t?.name === name)
}

function toolCall(name, args) {
  return {
    id: `call_mock_${Math.random().toString(36).slice(2, 10)}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

/** 按模型名产出「助手消息」核心（非流式形状）；stream 时由 sse 拆包。 */
function scriptFor(model, body) {
  switch (model) {
    case 'mock-planner': {
      if (offersTool(body, 'structured_output')) {
        return {
          tool_calls: [toolCall('structured_output', {
            goal: 'build the probe deliverable',
            tasks: [
              { taskId: 't1', objective: 'write hello.txt', acceptance: 'hello.txt exists with expected content' },
              { taskId: 't2', dependsOn: ['t1'], objective: 'verify content', acceptance: 'content matches' },
            ],
          })],
          finish_reason: 'tool_calls',
        }
      }
      return { content: 'PLAN: two tasks — t1 write hello.txt, t2 verify content.', finish_reason: 'stop' }
    }
    case 'mock-executor': {
      // 第二回合：工具结果已回来（或已经尝试过一次工具调用）→ 交回结构化/文本。
      // 防御：write 被 deny 时内核未必回 tool 消息，用「已出现过 assistant tool_call」兜底，避免无限重试。
      const assistantToolCalls = (body.messages ?? []).filter(
        (m) => m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
      ).length
      if (sawToolResult(body) || assistantToolCalls >= 1) {
        if (offersTool(body, 'structured_output')) {
          return {
            tool_calls: [toolCall('structured_output', {
              taskId: 't1',
              handoff: 'hello.txt written with the probe payload',
              files: ['hello.txt'],
              verification: 'file exists, content matches',
            })],
            finish_reason: 'tool_calls',
          }
        }
        return { content: 'HANDOFF: hello.txt written with the probe payload.', finish_reason: 'stop' }
      }
      // 第一回合：先落文件（write 被 deny 时内核会把这个调用当错误退回，脚本不变）
      return {
        tool_calls: [toolCall('write', {
          file_path: 'hello.txt',
          content: 'mixed probe payload\n',
        })],
        finish_reason: 'tool_calls',
      }
    }
    case 'mock-reviewer': {
      if (offersTool(body, 'structured_output')) {
        return {
          tool_calls: [toolCall('structured_output', {
            verdict: 'pass',
            issues: [],
            evidence: 'artifact present; verification recorded',
          })],
          finish_reason: 'tool_calls',
        }
      }
      return { content: 'REVIEW PASS: artifact present; verification recorded.', finish_reason: 'stop' }
    }
    default:
      return { content: `mock ${model}: pong`, finish_reason: 'stop' }
  }
}

function chatCompletionJson(model, script) {
  const usage = FIXED_USAGE[model] ?? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  const message = { role: 'assistant' }
  if (script.content !== undefined) message.content = script.content
  if (script.tool_calls) message.tool_calls = script.tool_calls
  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: script.finish_reason ?? 'stop' }],
    usage,
  }
}

/** 流式：完整的 OpenAI chat.completion.chunk（id/object/created/model 每块都带），末块带 usage。 */
async function* sseChunks(model, script) {
  const usage = FIXED_USAGE[model] ?? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  const id = `chatcmpl-mock-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  const chunk = (choices) => ({ id, object: 'chat.completion.chunk', created, model, choices })
  if (script.content !== undefined) {
    yield chunk([{ index: 0, delta: { role: 'assistant', content: script.content }, finish_reason: null }])
  }
  if (script.tool_calls) {
    for (const [i, tc] of script.tool_calls.entries()) {
      // 标准两段式：先 id/type/name，再 arguments（pi-ai 按 OpenAI 流式协议拼装）
      yield chunk([{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name } }] }, finish_reason: null }])
      yield chunk([{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] }, finish_reason: null }])
    }
  }
  yield chunk([{ index: 0, delta: {}, finish_reason: script.finish_reason ?? 'stop' }])
  yield { id, object: 'chat.completion.chunk', created, model, choices: [], usage }
}

function sseLine(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`
}

export function startMockLlm({ port = 0, log = () => {} } = {}) {
  const logLines = []
  let seq = 0

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/_log') {
      const since = Number(url.searchParams.get('since') ?? 0)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ entries: logLines.slice(since), next: logLines.length }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/_reset') {
      logLines.length = 0
      seq = 0
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        object: 'list',
        data: Object.keys(FIXED_USAGE).map((id) => ({ id, object: 'model', created: 0, owned_by: 'mock' })),
      }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const entry = {
        i: seq++,
        ts: new Date().toISOString(),
        method: req.method,
        path: url.pathname,
        model: null,
        stream: null,
        auth: req.headers.authorization ?? null,
        headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.toLowerCase().startsWith('x-'))),
        aborted: false,
        finished: false,
        body: null,
      }
      logLines.push(entry)
      const body = await readBody(req)
      entry.body = body
      entry.model = body?.model ?? null
      entry.stream = body?.stream === true
      // 上游实际「看到」的 user 消息文本（脱敏证据：证明领取消费的消息没有漏进模型）
      entry.userTexts = Array.isArray(body?.messages)
        ? body.messages
          .filter((m) => m && m.role === 'user')
          .map((m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((b) => b?.text ?? '').join('') : ''))
          .map((t) => t.slice(0, 200))
        : []
      if (!body || typeof body !== 'object' || typeof body.model !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'missing model' } }))
        entry.finished = true
        return
      }
      const onEarlyClose = () => {
        if (!entry.finished) entry.aborted = true
      }
      res.on('close', onEarlyClose)

      if (body.model === 'mock-error') {
        entry.finished = true
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'scripted upstream failure' } }))
        return
      }
      if (body.model === 'mock-slow') {
        // 慢速流：每 120ms 一个 chunk（低于 pi-ai 流空闲/重试阈值），最多 500 个；客户端断开即停
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const id = `chatcmpl-mock-slow-${Date.now()}`
        const created = Math.floor(Date.now() / 1000)
        const mk = (choices) => ({ id, object: 'chat.completion.chunk', created, model: 'mock-slow', choices })
        let n = 0
        const timer = setInterval(async () => {
          if (res.writableEnded || entry.aborted || n >= 500) {
            clearInterval(timer)
            if (!res.writableEnded) {
              try {
                res.write(sseLine(mk([{ index: 0, delta: {}, finish_reason: 'stop' }])))
                res.write(sseLine({ id, object: 'chat.completion.chunk', created, model: 'mock-slow', choices: [], usage: FIXED_USAGE['mock-slow'] }))
                res.write('data: [DONE]\n\n')
                res.end()
              } catch { /* 已断开 */ }
            }
            entry.finished = true
            return
          }
          n++
          try {
            res.write(sseLine(mk([{ index: 0, delta: { content: `s${n} ` }, finish_reason: null }])))
          } catch {
            entry.aborted = true
          }
        }, 120)
        return
      }

      const script = scriptFor(body.model, body)
      const model = body.model
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        try {
          for await (const chunk of sseChunks(model, script)) {
            res.write(sseLine(chunk))
          }
          res.write('data: [DONE]\n\n')
          res.end()
          entry.finished = true
        } catch (err) {
          entry.aborted = true
          try { res.end() } catch { /* 已断开 */ }
        }
        return
      }
      const payload = JSON.stringify(chatCompletionJson(model, script))
      entry.finished = true
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(payload)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `no route ${req.method} ${url.pathname}` } }))
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      log(`mock-llm listening on 127.0.0.1:${actual}`)
      resolve({
        port: actual,
        baseUrl: `http://127.0.0.1:${actual}`,
        close: () => new Promise((r) => server.close(r)),
        log: () => logLines.slice(),
        reset: () => { logLines.length = 0; seq = 0 },
      })
    })
  })
}
