/**
 * @company-desk/mixed-probe-host —— Mixed P0 契约探测宿主插件（仅探测用，不随产品分发）。
 *
 * 职责：
 *   1. 从 providerFile 读模型路由配置，写成 llm-pi-ai 的一条 provider（与 desk-host 登录后同机制），
 *      并可经 POST /probe/api/provider 在运行中切换（直连 mock ↔ 经公司网关）。
 *   2. 暴露 /probe/api 本机接口：health / provider / scenario。
 *   3. 场景引擎：用真实内核跑 subagents 契约与 pre-step 桥接契约，收集 session 事件断言。
 *
 * 场景（name → 说明）：
 *   s1-spawn-route          spawn 子代理显式 agentOptions 路由 + maxDepth
 *   s2-output-schema        outputSchema 结构化捕获成功
 *   s2b-structured-failure  带 outputSchema 但模型从不调 structured_output → 必须 error
 *   s3a-toolfilter-deny     toolFilter deny write：文件不得产生，任务仍按脚本收敛
 *   s3b-toolfilter-allow    toolFilter allow：write 真实落盘
 *   s4-cancel               慢模型跑到一半 abort → aborted，不再继续
 *   s5-dispose              运行中 dispose → run 结算、句柄释放
 *   s6-claim-empty          pre-step 领取消息后 enter+[] → turn 完成、无模型请求、消息不落 session
 *   s7-reject               pre-step reject → turn blocked
 *   s8-route-override       pre-step 放行 + agent/request 改路由 → 最终 assistant 记在审核模型
 *   s9-inflight-pipeline    pre-step 内跑 1.2s「流水线」（信号感知）→ 期间 running、请求在流水线后
 *   s9b-cancel-inflight     流水线中途 Stop（agent.cancel）→ turn aborted、流水线被取消
 *   s10-queue               运行中再发消息 → 进队列、下一 turn 按序处理
 */
import fs from 'node:fs'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MixedStore } from '../../../../plugins/desk-host/lib/mixed/store.js'
import { MixedDriver } from '../../../../plugins/desk-host/lib/mixed/dsh-driver.js'
import { MixedRunController } from '../../../../plugins/desk-host/lib/mixed/service.js'
import { createMixedBridge } from '../../../../plugins/desk-host/lib/mixed/session-bridge.js'

export const name = 'mixed-probe-host'
export const inject = ['webServer', 'settings', 'credentials', 'agentDefaultModel', 'agents', 'subagents', 'sessions']

export const Config = z.object({
  providerFile: z.string().default(''),
})

const CRED_NAME = 'MIXED_PROBE_KEY'
const SETTINGS_SCOPE = 'llm-pi-ai'

export function apply(ctx, config) {
  let currentProvider = null
  let providerError = null

  // ---------- 模型路由 ----------
  async function applyProviderConfig(spec) {
    if (!spec || typeof spec !== 'object' || !spec.providers || typeof spec.providers !== 'object') {
      throw new Error('provider spec 缺少 providers')
    }
    const credential = typeof spec.credential === 'string' && spec.credential.length > 0 ? spec.credential : 'probe-key-not-real'
    await ctx.credentials.set(credentialRef(CRED_NAME), credential)
    await ctx.settings.update(SETTINGS_SCOPE, { providers: spec.providers })
    if (spec.defaultModel && spec.defaultModel.provider && spec.defaultModel.model) {
      try {
        await ctx.agentDefaultModel.saveSelection({ provider: spec.defaultModel.provider, model: spec.defaultModel.model })
      } catch (err) {
        throw new Error(`defaultModel 选择失败: ${err.message}`)
      }
    }
    currentProvider = spec
  }

  if (config.providerFile && fs.existsSync(config.providerFile)) {
    try {
      applyProviderConfig(JSON.parse(fs.readFileSync(config.providerFile, 'utf8'))).catch((err) => {
        providerError = err.message
        console.error(`[mixed-probe-host] 初始 provider 配置失败: ${err.message}`)
      })
    } catch (err) {
      providerError = `providerFile 解析失败: ${err.message}`
      console.error(`[mixed-probe-host] providerFile 解析失败: ${err.message}`)
    }
  }

  // ---------- 观测 ----------
  const statusLog = new Map() // agentId -> [{ts, status}]
  const subagentEnds = [] // {ts, provider, id, stopReason}
  ctx.on('agent/status', ({ agent, status }) => {
    const list = statusLog.get(agent.id) ?? []
    list.push({ ts: Date.now(), status })
    statusLog.set(agent.id, list)
  })
  ctx.on('subagent/end', (info) => {
    subagentEnds.push({ ts: new Date().toISOString(), provider: info.provider, id: String(info.id), stopReason: info.stopReason })
  })

  // 场景 hook 全部走 agent 作用域注册（agent.ctx.on）：
  //   agent/pre-step  —— payload 带 agent，作用域注册只命中本 agent，next() 继续向外层
  //   agent/request   —— payload 只有 {turn,step,signal}，只能作用域注册
  // 不在根 ctx 再挂同名监听，避免同一 hook 被链路双份命中（领取语义会错乱）。

  // ---------- 小工具 ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  async function abortableSleep(ms, signal) {
    if (!signal) return sleep(ms)
    if (signal.aborted) throw new Error('aborted')
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(t)
        reject(new Error('aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  function makeChecks() {
    const checks = []
    return {
      checks,
      check(name, ok, detail) {
        checks.push({ name, ok: !!ok, detail: detail === undefined ? null : String(detail).slice(0, 400) })
      },
      pass() {
        return checks.every((c) => c.ok)
      },
    }
  }
  function outputText(output) {
    return (output ?? [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  }
  function sessionEvents(sessionId) {
    const rec = ctx.sessions.get?.(sessionId)
    return rec?.events ?? []
  }
  function compactEvents(sessionId, keep = ['turn/start', 'turn/end', 'user/message', 'assistant/message', 'assistant/attempt', 'request/header']) {
    return sessionEvents(sessionId)
      .filter((e) => keep.includes(e.type))
      .map((e) => {
        if (e.type === 'turn/start') return { type: e.type, turn: e.data?.turn }
        if (e.type === 'turn/end') return { type: e.type, turn: e.data?.turn, reason: e.data?.reason }
        if (e.type === 'user/message') {
          const m = e.data
          return { type: e.type, id: m?.id ?? null, sourceKind: m?.source?.kind ?? null, text: textOf(m?.content) }
        }
        if (e.type === 'assistant/message') {
          const m = e.data?.message
          return {
            type: e.type,
            source: m?.source ?? null,
            usage: e.data?.usage ?? null,
            interrupted: e.data?.interrupted === true ? true : null,
            text: textOf(m?.content).slice(0, 500),
          }
        }
        if (e.type === 'assistant/attempt') return { type: e.type, interrupted: e.data?.interrupted === true ? true : null }
        if (e.type === 'request/header') return { type: e.type, reason: e.data?.reason, config: e.data?.header?.config ?? null }
        return { type: e.type }
      })
  }
  function textOf(content) {
    if (!Array.isArray(content)) return ''
    return content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n')
  }
  const userMsg = (text) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

  /** 建一个探测会话（agent），注册可选 hook，跑 fn，最后清理。 */
  async function withSessionAgent({ cwd, route, hooks = {}, presetId }, fn) {
    const sessionId = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    fs.mkdirSync(cwd, { recursive: true })
    // web 形态下工具面在 agent preset 之后：不加入 preset 的 agent 工具表为空（restrict 会报 "known global tools: (none)"）。
    // 与官方会话创建同一机制：setup 回调里挂上 preset（默认 standard），子代理经 composeFrom 自动继承。
    const presets = ctx.get?.('agentPresets')
    const setup = presets
      ? async (agentCtx) => {
          const resolved = await presets.resolve(presetId)
          await presets.mount(agentCtx, resolved.id)
        }
      : undefined
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd },
      agentOptions: { provider: route.provider, model: route.model },
      ...(setup ? { setup } : {}),
    })
    const agent = handle.agent
    const disposers = []
    if (hooks.preStep) disposers.push(agent.ctx.on('agent/pre-step', hooks.preStep))
    if (hooks.onRequest) disposers.push(agent.ctx.on('agent/request', hooks.onRequest))
    try {
      return await fn({ sessionId, handle, agent })
    } finally {
      for (const d of disposers) {
        try { d() } catch { /* 已随 agent 销毁 */ }
      }
      try { await handle.dispose() } catch { /* 已被 turn 取消 */ }
    }
  }

  // ---------- 场景 ----------
  const scenarios = {}

  scenarios['s1-spawn-route'] = async (env) => {
    const c = makeChecks()
    let childId = null
    const out = await withSessionAgent({ cwd: env.cwd, route: env.parentRoute }, async ({ agent }) => {
      const ac = new AbortController()
      const run = await ctx.subagents.start('spawn', {
        label: 'probe-s1-executor',
        prompt: [{ type: 'text', text: 'Implement probe task t1: write hello.txt.' }],
        parent: agent,
        signal: ac.signal,
        agentOptions: { provider: env.provider, model: env.models.executor },
        maxDepth: 1,
      })
      childId = run.id
      const result = await run.result
      // 先取子会话事件（含 request/header），再 dispose（dispose 会把子会话从 store 移除）
      const childEvents = compactEvents(run.id)
      const headers = sessionEvents(run.id).filter((e) => e.type === 'request/header')
      await run.dispose()
      c.check('stopReason=completed', result.stopReason === 'completed', result.stopReason)
      const text = outputText(result.output)
      c.check('有交接产物', /hello\.txt/.test(text) || (result.structured && /hello\.txt/.test(JSON.stringify(result.structured))), `${text.slice(0, 120)} | structured=${JSON.stringify(result.structured)}`)
      const cfg = headers[0]?.data?.header?.config
      c.check('子代理请求走显式路由(Executor)', cfg?.model === env.models.executor, `header 事件数=${headers.length} cfg=${JSON.stringify(cfg)}`)
      return { result, childId, childEvents }
    })
    c.check('subagent/end 事件已记录', subagentEnds.some((e) => e.id === String(childId) && e.stopReason === 'completed'), JSON.stringify(subagentEnds.slice(-3)))
    return { pass: c.pass(), checks: c.checks, artifacts: { childId, events: out.childEvents } }
  }

  scenarios['s2-output-schema'] = async (env) => {
    const c = makeChecks()
    const schema = {
      type: 'object',
      properties: {
        verdict: { type: 'string' },
        issues: { type: 'array', items: { type: 'string' } },
        evidence: { type: 'string' },
      },
      required: ['verdict'],
      additionalProperties: false,
    }
    const out = await withSessionAgent({ cwd: env.cwd, route: env.parentRoute }, async ({ agent }) => {
      const ac = new AbortController()
      const run = await ctx.subagents.start('spawn', {
        label: 'probe-s2-reviewer',
        prompt: [{ type: 'text', text: 'Review the probe deliverable.' }],
        parent: agent,
        signal: ac.signal,
        agentOptions: { provider: env.provider, model: env.models.reviewer },
        outputSchema: schema,
        maxDepth: 1,
      })
      const result = await run.result
      await run.dispose()
      c.check('stopReason=completed', result.stopReason === 'completed', result.stopReason)
      c.check('structured 捕获', result.structured?.verdict === 'pass', JSON.stringify(result.structured))
      return result
    })
    void out
    return { pass: c.pass(), checks: c.checks }
  }

  scenarios['s2b-structured-failure'] = async (env) => {
    const c = makeChecks()
    const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false }
    const out = await withSessionAgent({ cwd: env.cwd, route: env.parentRoute }, async ({ agent }) => {
      const ac = new AbortController()
      const run = await ctx.subagents.start('spawn', {
        label: 'probe-s2b-plain',
        prompt: [{ type: 'text', text: 'Say anything.' }],
        parent: agent,
        signal: ac.signal,
        agentOptions: { provider: env.provider, model: env.models.plain },
        outputSchema: schema,
        maxDepth: 1,
      })
      const result = await run.result
      await run.dispose()
      c.check('completed 未调 structured_output → error（不得蒙混为完成）', result.stopReason === 'error', result.stopReason)
      return result
    })
    void out
    return { pass: c.pass(), checks: c.checks }
  }

  scenarios['s3a-toolfilter-deny'] = async (env) => {
    const c = makeChecks()
    const out = await withSessionAgent({ cwd: env.cwd, route: env.parentRoute }, async ({ agent }) => {
      const ac = new AbortController()
      const run = await ctx.subagents.start('spawn', {
        label: 'probe-s3a-executor-deny',
        prompt: [{ type: 'text', text: 'Write hello.txt.' }],
        parent: agent,
        signal: ac.signal,
        agentOptions: { provider: env.provider, model: env.models.executor },
        toolFilter: { deny: ['write'] },
        maxDepth: 1,
      })
      const result = await run.result
      await run.dispose()
      c.check('stopReason=completed', result.stopReason === 'completed', result.stopReason)
      return result
    })
    c.check('被 deny 的 write 没有落盘', !fs.existsSync(path.join(env.cwd, 'hello.txt')), fs.readdirSync(env.cwd).join(','))
    return { pass: c.pass(), checks: c.checks }
  }

  scenarios['s3b-toolfilter-allow'] = async (env) => {
    const c = makeChecks()
    const out = await withSessionAgent({ cwd: env.cwd, route: env.parentRoute }, async ({ agent }) => {
      const ac = new AbortController()
      const run = await ctx.subagents.start('spawn', {
        label: 'probe-s3b-executor-allow',
        prompt: [{ type: 'text', text: 'Write hello.txt.' }],
        parent: agent,
        signal: ac.signal,
        agentOptions: { provider: env.provider, model: env.models.executor },
        // 白名单只能列全局工具；structured_output 是 driver 按 outputSchema 作用域注册的，不在此列
        toolFilter: { allow: ['write', 'read'] },
        maxDepth: 1,
      })
      const result = await run.result
      await run.dispose()
      c.check('stopReason=completed', result.stopReason === 'completed', result.stopReason)
      return result
    })
    const f = path.join(env.cwd, 'hello.txt')
    const entries = fs.readdirSync(env.cwd)
    const diag = entries.map((name) => {
      try {
        const st = fs.statSync(path.join(env.cwd, name))
        return `${name}(file=${st.isFile()},size=${st.size})`
      } catch (err) {
        return `${name}(stat-failed:${err.code})`
      }
    })
    c.check('allow 时 write 真实落盘', fs.existsSync(f), `f=${f} entries=[${diag.join(', ')}]`)
    if (fs.existsSync(f)) c.check('文件内容正确', fs.readFileSync(f, 'utf8').includes('mixed probe payload'), '')
    return { pass: c.pass(), checks: c.checks }
  }

  scenarios['s4-cancel'] = async (env) => {
    const c = makeChecks()
    const out = await withSessionAgent({ cwd: env.cwd, route: env.parentRoute }, async ({ agent }) => {
      const ac = new AbortController()
      const run = await ctx.subagents.start('spawn', {
        label: 'probe-s4-slow',
        prompt: [{ type: 'text', text: 'Take your time.' }],
        parent: agent,
        signal: ac.signal,
        agentOptions: { provider: env.provider, model: env.models.slow },
        maxDepth: 1,
      })
      await sleep(1500)
      const t0 = Date.now()
      ac.abort()
      const result = await run.result
      // 先取子会话事件，再 dispose（dispose 会把子会话从 store 移除）
      const childEnds = sessionEvents(run.id).filter((e) => e.type === 'turn/end')
      const childEvents = compactEvents(run.id)
      await run.dispose()
      const settledMs = Date.now() - t0
      c.check('abort 后 stopReason=aborted', result.stopReason === 'aborted', result.stopReason)
      c.check('结算及时（<10s，不等慢流跑完）', settledMs < 10_000, `${settledMs}ms`)
      c.check('子 turn 结束原因 aborted', childEnds.some((e) => e.data?.reason?.kind === 'aborted'), JSON.stringify(childEnds.map((e) => e.data?.reason)))
      return { result, childId: run.id, childEvents }
    })
    return { pass: c.pass(), checks: c.checks, artifacts: { childId: out.childId, events: out.childEvents } }
  }

  scenarios['s5-dispose'] = async (env) => {
    const c = makeChecks()
    const out = await withSessionAgent({ cwd: env.cwd, route: env.parentRoute }, async ({ agent }) => {
      const ac = new AbortController()
      void ac
      const run = await ctx.subagents.start('spawn', {
        label: 'probe-s5-slow',
        prompt: [{ type: 'text', text: 'Take your time.' }],
        parent: agent,
        signal: new AbortController().signal,
        agentOptions: { provider: env.provider, model: env.models.slow },
        maxDepth: 1,
      })
      const resultP = run.result
      let disposeErr = null
      try {
        await run.dispose()
      } catch (err) {
        disposeErr = err.message
      }
      c.check('dispose 正常结算（不挂死）', disposeErr === null, disposeErr ?? 'ok')
      const result = await resultP
      c.check('run 已结算', !!result && typeof result.stopReason === 'string', result?.stopReason)
      return { result }
    })
    return { pass: c.pass(), checks: c.checks }
  }

  scenarios['s6-claim-empty'] = async (env) => {
    const c = makeChecks()
    const state = { claimed: null, calls: [] }
    const out = await withSessionAgent(
      {
        cwd: env.cwd,
        route: env.parentRoute,
        hooks: {
          preStep: async (payload, next) => {
            const decision = await next()
            state.calls.push({
              turn: payload.turn, step: payload.step, target: payload.target ?? null,
              nextKind: decision.kind, nextMsgs: (decision.messages ?? []).map((m) => ({ k: m?.source?.kind, p: m?.source?.plugin ?? null, t: textOf(m?.content).slice(0, 40) })),
            })
            if (decision.kind === 'reject') return decision
            if (!state.claimed && Array.isArray(decision.messages)) state.claimed = decision.messages
            return { kind: 'enter', messages: [] }
          },
        },
      },
      async ({ agent, sessionId }) => {
        agent.followup(userMsg('mixed probe: claim me'))
        await agent.whenIdle()
        const events = sessionEvents(sessionId)
        const userMsgs = events.filter((e) => e.type === 'user/message')
        // 内核语义（实测）：pre-step 领取并消费（enter+[]）后，消费方之外更外层的插件
        // （如 dsh-tool-skill 首 turn 注入技能目录、dsh-agent-instructions re-queue context）
        // 仍可能附加自己的消息 → 该 turn 会跑模型步。所以 claim 的断言是：
        // 被领取的用户消息本身不落地、不进模型（进模型与否由 driver 侧用上游日志断言）。
        const firstEndIdx = events.findIndex((e) => e.type === 'turn/end')
        const turns = events.filter((e) => e.type === 'turn/start').length
        const claimedText = 'mixed probe: claim me'
        const appendedNonUser = userMsgs.map((m) => ({ k: m.data?.source?.kind, p: m.data?.source?.plugin ?? null, t: textOf(m.data?.content).slice(0, 40) }))
        c.check('pre-step 拿到了被领取的消息', (state.claimed?.length ?? 0) >= 1, JSON.stringify(state.claimed?.length))
        c.check('被领取的用户消息未落 session（被消费）', !userMsgs.some((m) => textOf(m.data?.content).includes(claimedText)), JSON.stringify(appendedNonUser))
        c.check('runtime-context 快照同样被消费（未落 session）', !userMsgs.some((m) => /Current runtime context/.test(textOf(m.data?.content))), JSON.stringify(appendedNonUser))
        c.check('turn 1 以 completed 结束', events[firstEndIdx]?.data?.reason?.kind === 'completed', JSON.stringify(events[firstEndIdx]?.data?.reason))
        c.check('agent 回到 idle', agent.status === 'idle', agent.status)
        c.check('（信息）插件注入消息导致的模型步（内核行为记录）', true, JSON.stringify({ turns, appendedNonUser }))
        return { sessionId, callTrace: state.calls, userMsgs: userMsgs.map((m) => ({ source: m.data?.source ?? null, text: textOf(m.data?.content).slice(0, 120) })), events: compactEvents(sessionId) }
      },
    )
    return { pass: c.pass(), checks: c.checks, artifacts: { sessionId: out.sessionId, events: out.events, diagnostics: { callTrace: out.callTrace, userMsgs: out.userMsgs } } }
  }

  scenarios['s7-reject'] = async (env) => {
    const c = makeChecks()
    const out = await withSessionAgent(
      {
        cwd: env.cwd,
        route: env.parentRoute,
        hooks: {
          preStep: async () => {
            return { kind: 'reject', reason: 'mixed probe gate' }
          },
        },
      },
      async ({ agent, sessionId }) => {
        agent.followup(userMsg('mixed probe: block me'))
        await agent.whenIdle()
        const events = sessionEvents(sessionId)
        const userMsgs = events.filter((e) => e.type === 'user/message')
        const headers = events.filter((e) => e.type === 'request/header')
        const ends = events.filter((e) => e.type === 'turn/end')
        c.check('turn 以 blocked 结束', ends.some((e) => e.data?.reason?.kind === 'blocked'), JSON.stringify(ends.map((e) => e.data?.reason)))
        c.check('消息未落 session', userMsgs.filter((m) => m.data?.source?.kind === 'user').length === 0, JSON.stringify(userMsgs.map((m) => ({ k: m.data?.source?.kind, t: textOf(m.data?.content).slice(0, 30) }))))
        c.check('没有发起任何模型请求', headers.length === 0, `${headers.length}`)
        return { sessionId, events: compactEvents(sessionId) }
      },
    )
    return { pass: c.pass(), checks: c.checks, artifacts: { sessionId: out.sessionId, events: out.events } }
  }

  scenarios['s8-route-override'] = async (env) => {
    const c = makeChecks()
    const out = await withSessionAgent(
      {
        cwd: env.cwd,
        route: env.parentRoute,
        hooks: {
          // 放行原始消息（模拟：流水线已在 pre-step 内跑完，交付体以插件消息附加）
          preStep: async (payload, next) => {
            const decision = await next()
            if (decision.kind === 'reject') return decision
            return {
              kind: 'enter',
              messages: [
                ...decision.messages,
                createUserMessage({
                  content: [{ type: 'text', text: 'REVIEW DELIVERY: verdict=pass; artifact hello.txt present; verification recorded. (probe 交付体)' }],
                  source: { kind: 'plugin', plugin: 'mixed-probe', form: 'notice', summary: 'mixed delivery' },
                }),
              ],
            }
          },
          // 该会话每一步模型请求都改道到审核模型（P0 验证 per-step 路由原语）
          onRequest: async (_payload, next) => {
            const seed = await next()
            return { ...seed, provider: env.provider, model: env.models.reviewer }
          },
        },
      },
      async ({ agent, sessionId }) => {
        agent.followup(userMsg('mixed probe: summarize for me'))
        await agent.whenIdle()
        const events = sessionEvents(sessionId)
        const headers = events.filter((e) => e.type === 'request/header')
        const assistants = events.filter((e) => e.type === 'assistant/message')
        const last = assistants[assistants.length - 1]
        const cfg = headers[headers.length - 1]?.data?.header?.config
        c.check('请求被改道到审核模型', cfg?.model === env.models.reviewer, JSON.stringify(cfg))
        c.check('最终 assistant 的 source 是审核模型', last?.data?.message?.source?.model === env.models.reviewer, JSON.stringify(last?.data?.message?.source))
        const usage = last?.data?.usage ?? {}
        const usedTokens = usage.totalTokens ?? usage.total_tokens ?? (usage.outputTokens ?? usage.completion_tokens) ?? 0
        c.check('最终 assistant 带 usage（可进网关账本）', usedTokens > 0, JSON.stringify(usage))
        c.check('summary 步收到交付体（插件消息落 session）', sessionEvents(sessionId).some((e) => e.type === 'user/message' && /REVIEW DELIVERY/.test(textOf(e.data?.content))), '')
        const ends = events.filter((e) => e.type === 'turn/end')
        c.check('turn 以 completed 结束', ends.some((e) => e.data?.reason?.kind === 'completed'), JSON.stringify(ends.map((e) => e.data?.reason)))
        return { sessionId, events: compactEvents(sessionId) }
      },
    )
    return { pass: c.pass(), checks: c.checks, artifacts: { sessionId: out.sessionId, events: out.events } }
  }

  scenarios['s9-inflight-pipeline'] = async (env) => {
    const c = makeChecks()
    const state = { startedAt: null, finishedAt: null }
    const out = await withSessionAgent(
      {
        cwd: env.cwd,
        route: env.parentRoute,
        hooks: {
          preStep: async (payload, next) => {
            const decision = await next()
            if (decision.kind === 'reject') return decision
            state.startedAt = Date.now()
            await abortableSleep(1200, payload.signal)
            state.finishedAt = Date.now()
            return decision
          },
        },
      },
      async ({ agent, sessionId }) => {
        agent.followup(userMsg('mixed probe: run the pipeline'))
        // 流水线期间采样状态
        let sawRunning = false
        for (let i = 0; i < 15; i++) {
          await sleep(100)
          if (agent.status === 'running') sawRunning = true
          if (agent.status === 'idle' && i > 3) break
        }
        await agent.whenIdle()
        c.check('流水线期间 agent=running', sawRunning, '')
        c.check('流水线确实执行了 ~1.2s', (state.finishedAt ?? 0) - (state.startedAt ?? 0) >= 1100, `${state.finishedAt - state.startedAt}ms`)
        const events = sessionEvents(sessionId)
        const userIdx = events.findIndex((e) => e.type === 'user/message')
        const headerIdx = events.findIndex((e) => e.type === 'request/header')
        c.check('用户消息先落、模型请求在流水线后', userIdx >= 0 && headerIdx > userIdx, `user@${userIdx} header@${headerIdx}`)
        return { sessionId, events: compactEvents(sessionId) }
      },
    )
    return { pass: c.pass(), checks: c.checks, artifacts: { sessionId: out.sessionId, events: out.events } }
  }

  scenarios['s9b-cancel-inflight'] = async (env) => {
    const c = makeChecks()
    const state = { cancelled: false, finished: false }
    const out = await withSessionAgent(
      {
        cwd: env.cwd,
        route: env.parentRoute,
        hooks: {
          preStep: async (payload, next) => {
            const decision = await next()
            if (decision.kind === 'reject') return decision
            try {
              await abortableSleep(2000, payload.signal)
              state.finished = true
              return decision
            } catch {
              state.cancelled = true
              throw new Error('pipeline aborted by stop')
            }
          },
        },
      },
      async ({ agent, sessionId }) => {
        agent.followup(userMsg('mixed probe: run then stop me'))
        await sleep(600)
        // cancel 的 cause 必须 JSON 可序列化：它会被嵌进 turn/end 的 reason，
        // 而 session.append 对非 JSON 数据直接抛错（Error 对象会吞掉 turn/end 事件）—— 内核契约，兼容性报告要记。
        agent.cancel({ kind: 'probe-stop', by: 'user' })
        await agent.whenIdle()
        // turn/end 的落盘可能略晚于 whenIdle 结算，轮询等待（上限 5s）
        let events = sessionEvents(sessionId)
        for (let i = 0; i < 50 && !events.some((e) => e.type === 'turn/end'); i++) {
          await sleep(100)
          events = sessionEvents(sessionId)
        }
        const ends = events.filter((e) => e.type === 'turn/end')
        const headers = events.filter((e) => e.type === 'request/header')
        const allTypes = events.map((e) => e.type).join(',')
        c.check('turn 以 aborted 结束', ends.some((e) => e.data?.reason?.kind === 'aborted'), `status=${agent.status} ends=${JSON.stringify(ends.map((e) => e.data?.reason))} allTypes=[${allTypes}]`)
        c.check('流水线收到取消（信号传播）', state.cancelled === true && state.finished === false, `cancelled=${state.cancelled} finished=${state.finished}`)
        c.check('取消后没有发起模型请求', headers.length === 0, `${headers.length}`)
        return { sessionId, events: compactEvents(sessionId), allTypes }
      },
    )
    return { pass: c.pass(), checks: c.checks, artifacts: { sessionId: out.sessionId, events: out.events } }
  }

  scenarios['s10-queue'] = async (env) => {
    const c = makeChecks()
    const out = await withSessionAgent({ cwd: env.cwd, route: env.parentRoute }, async ({ agent, sessionId }) => {
      agent.followup(userMsg('first message'))
      await sleep(300)
      agent.followup(userMsg('second message queued'))
      await agent.whenIdle()
      const events = sessionEvents(sessionId)
      // 只数 user 源消息（内核/插件的 runtime-context 快照是 plugin 源，不算用户消息）
      const userMsgs = events.filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'user')
      const starts = events.filter((e) => e.type === 'turn/start')
      const assistants = events.filter((e) => e.type === 'assistant/message')
      c.check('两条用户消息都落了 session', userMsgs.length === 2, JSON.stringify(userMsgs.map((e) => textOf(e.data?.content).slice(0, 30))))
      c.check('两条回复', assistants.length === 2, `${assistants.length}`)
      const texts = userMsgs.map((e) => textOf(e.data?.content))
      c.check('顺序正确（first 在 second 前）', /first/.test(texts[0] ?? '') && /second/.test(texts[1] ?? ''), texts.join(' | ').slice(0, 200))
      // turn 数：两条排队消息至少 2 个 turn；若插件把 context 快照排进后续 turn，允许更多
      c.check('排队期间 turn 数 >= 2', starts.length >= 2, `${starts.length}`)
      return { sessionId, events: compactEvents(sessionId) }
    })
    return { pass: c.pass(), checks: c.checks, artifacts: { sessionId: out.sessionId, events: out.events } }
  }

  // ---------- s11：T04 真内核桥接闭环 ----------
  // 真实 MixedStore（内核 storage 服务）+ 真实桥接（pre-step 领取/交付/reject）+ 脚本化阶段
  // 结果（假 subagents，不打模型）。验收：原消息只处理一次、阶段齐全落 run、交付步改道 reviewer、
  // 交付体落会话、turn 正常结束。
  const PROBE_PLAN = {
    goal: 'build the probe deliverable',
    interpretation: 'single task',
    acceptance: [{ id: 'a1', description: 'hello.txt exists with the probe payload', checkable: true }],
    verificationMethods: ['file check'],
    tasks: [
      {
        taskId: 't1', dependsOnTaskIds: [], title: 'write hello.txt', goal: 'write hello.txt',
        inputRefs: [], expectedOutputs: ['hello.txt'], pathScope: ['hello.txt'], acceptanceIds: ['a1'],
        verificationHints: ['file exists, content matches'], role: 'executor', status: 'pending', attemptIds: [], evidenceIds: [],
      },
    ],
  }
  const PROBE_REVIEW = {
    verdict: 'pass',
    criteria: [{ acceptanceId: 'a1', status: 'pass', evidenceIds: ['e1'], explanation: 'artifact present; verification recorded' }],
    findings: [],
    summary: 'all acceptance items passed',
  }

  scenarios['s11-real-bridge'] = async (env) => {
    const c = makeChecks()
    const facility = ctx.get?.('storageDomain')
    if (!facility) throw new Error('storageDomain 不可用（base profile 未提供 storage-domain backend）')
    const stateDir = path.join(env.cwd, 'state')
    const storageRoot = path.join(env.cwd, 'storages')
    const store = new MixedStore({ stateDir, storageRoot, hostId: 'probe-host', logger: console })
    await store.open(facility)
    const OWNER_KEY = 'probe-owner'
    const modeOf = (modelId, caps) => ({
      catalogProvider: 'mock', modelId, runtimeModelId: modelId, capabilities: caps, capabilitiesRevision: 'probe',
    })
    const MODELS = {
      planner: modeOf(env.models.planner, { planner: true, executor: true, reviewer: true }),
      executor: modeOf(env.models.executor, { planner: false, executor: true, reviewer: true }),
      reviewer: modeOf(env.models.reviewer, { planner: false, executor: false, reviewer: true }),
    }
    await store.savePreferences(OWNER_KEY, { planner: MODELS.planner, executor: MODELS.executor, reviewer: MODELS.reviewer, ownerEpoch: 0 })

    // 假 subagents：阶段结果脚本化（规划/审核结构化，执行交接）；记录派发参数供断言
    const spawnCalls = []
    const fakeSub = {
      start: async (kind, opts) => {
        spawnCalls.push({ kind, label: opts.label, agentOptions: opts.agentOptions, maxDepth: opts.maxDepth, hasOutputSchema: !!opts.outputSchema })
        const structured =
          opts.label === 'mixed:planning' ? structuredClone(PROBE_PLAN)
          : opts.label === 'mixed:review' ? structuredClone(PROBE_REVIEW)
          : undefined
        return {
          id: `fake-${spawnCalls.length}-${opts.label}`,
          result: Promise.resolve({ output: `${opts.label} done`, stopReason: 'completed', structured }),
          dispose: async () => {},
        }
      },
    }
    const controllers = new Map()
    const captureError = (name, e) => {
      try { fs.writeFileSync(path.join(env.cwd, `${name}.txt`), String(e?.stack ?? e)) } catch { /* 忽略 */ }
    }
    const runControllerFactory = ({ agent, run }) => {
      let controller
      try {
        const driver = new MixedDriver({
          ctx: { subagents: fakeSub },
          store,
          parentAgent: agent,
          run,
          providerIdOf: () => env.provider,
          stageTimeoutMs: 90_000,
          logger: console,
        })
        const raw = new MixedRunController({
          store, driver, run, agent,
          planPrompt: (r) => `plan: ${r.goal}`,
          taskPrompt: (r, t) => `task ${t.taskId}: ${t.title}`,
          reviewPrompt: () => 'review the run outputs',
          planSchema: { type: 'object' },
          reviewSchema: { type: 'object' },
          logger: console,
        })
        // 探测用：execute 抛错落盘（真实环境由 API/诊断承接）
        controller = {
          ...raw,
          execute: async (sig) => {
            try {
              return await raw.execute(sig)
            } catch (e) {
              captureError('mixed-execute-error', e)
              throw e
            }
          },
        }
      } catch (e) {
        captureError('mixed-factory-error', e)
        throw e
      }
      controllers.set(run.runId, controller)
      return controller
    }
    const bridge = createMixedBridge({
      store,
      profileId: 'mixed-probe',
      getOwner: () => ({ ownerKey: OWNER_KEY, ownerEpoch: 0 }),
      workspacePath: () => env.cwd,
      deps: { runControllerFactory, controllers },
      findSession: () => null,
      providerIdOf: () => env.provider,
      logger: console,
    })

    const MSG_TEXT = 'mixed bridge: build the probe deliverable'
    // 外层决策日志：桥接（内层）的最终决策落盘（含 reject reason）——探测诊断用
    const decisionLogger = async (_payload, next) => {
      const d = await next()
      try {
        fs.writeFileSync(
          path.join(env.cwd, 'prestep-decision.txt'),
          JSON.stringify({ kind: d?.kind, reason: d?.reason ?? null, messageCount: Array.isArray(d?.messages) ? d.messages.length : null }, null, 2),
        )
      } catch { /* 忽略 */ }
      return d
    }
    const out = await withSessionAgent({ cwd: env.cwd, route: env.parentRoute, hooks: { preStep: decisionLogger } }, async ({ agent, sessionId }) => {
      await store.setSessionMode({ sessionId, ownerKey: OWNER_KEY, ownerEpoch: 0, enabled: true })
      bridge.install(agent, sessionId)
      agent.followup(userMsg(MSG_TEXT))
      await agent.whenIdle()
      const events = sessionEvents(sessionId)
      const userMsgs = events.filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'user')
      const pluginMsgs = events.filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'plugin' && e.data?.source?.plugin === 'mixed')
      const headers = events.filter((e) => e.type === 'request/header')
      const assistants = events.filter((e) => e.type === 'assistant/message')
      const ends = events.filter((e) => e.type === 'turn/end')
      const last = assistants[assistants.length - 1]
      const cfg = headers[headers.length - 1]?.data?.header?.config
      const runs = store.listRuns({ sessionId }).items
      const run = runs[0]
      const record = run ? store.getRun(run.runId) : null
      c.check('恰好 1 个 run（原消息只处理一次）', runs.length === 1, `runs=${runs.length}`)
      c.check('run 状态 succeeded', record?.status === 'succeeded', record?.status)
      const stageOrder = record?.attempts.map((a) => `${a.stage}:${a.route?.modelId}:${a.stopReason}`) ?? []
      c.check(
        '三个阶段按角色路由完成（planning=planner, execution=executor, review=reviewer）',
        stageOrder.length === 3 &&
          stageOrder[0] === `planning:${env.models.planner}:completed` &&
          stageOrder[1] === `execution:${env.models.executor}:completed` &&
          stageOrder[2] === `review:${env.models.reviewer}:completed`,
        JSON.stringify(stageOrder),
      )
      c.check('planVersion 已存（任务 executed）', record?.planVersions?.[0]?.version === 1 && record?.tasks?.[0]?.status === 'executed', JSON.stringify({ pv: record?.planVersions?.length, task: record?.tasks?.[0]?.status }))
      c.check('审核轮 pass 且回填宿主字段', record?.reviewRounds?.[0]?.result?.verdict === 'pass' && record?.reviewRounds?.[0]?.result?.planVersion === 1, JSON.stringify(record?.reviewRounds?.[0]?.result))
      // 原消息经交付步决策 re-inject 落 session 恰好一次（s8 语义；用户可见自己的请求，且无重复追加）
      c.check(
        '原用户消息在 session 恰好一次（交付步 re-inject，未重复追加）',
        userMsgs.length === 1 && userMsgs.every((m) => textOf(m.data?.content).includes(MSG_TEXT)),
        JSON.stringify(userMsgs.map((m) => textOf(m.data?.content).slice(0, 40))),
      )
      c.check('交付插件消息落 session', pluginMsgs.length === 1 && /Mixed 交付/.test(textOf(pluginMsgs[0]?.data?.content)), JSON.stringify(pluginMsgs.map((m) => textOf(m.data?.content).slice(0, 60))))
      c.check('交付步模型请求改道 reviewer', cfg?.model === env.models.reviewer, JSON.stringify(cfg))
      c.check('最终 assistant source 是 reviewer 且带 usage', last?.data?.message?.source?.model === env.models.reviewer && (last?.data?.usage?.totalTokens ?? last?.data?.usage?.total_tokens ?? 0) > 0, JSON.stringify({ src: last?.data?.message?.source, usage: last?.data?.usage }))
      c.check('turn 以 completed 结束', ends.some((e) => e.data?.reason?.kind === 'completed'), JSON.stringify(ends.map((e) => e.data?.reason)))
      const expectByStage = { 'mixed:planning': env.models.planner, 'mixed:execution:t1': env.models.executor, 'mixed:review': env.models.reviewer }
      c.check(
        '每次派发 maxDepth=1 + 显式 provider/角色模型（不切全局默认）',
        spawnCalls.length === 3 &&
          spawnCalls.every((s) => s.maxDepth === 1 && s.agentOptions?.provider === env.provider && s.agentOptions?.model === expectByStage[s.label]),
        JSON.stringify(spawnCalls.map((s) => ({ l: s.label, p: s.agentOptions?.provider, m: s.agentOptions?.model, d: s.maxDepth }))),
      )
      const capture = (n) => { try { return fs.readFileSync(path.join(env.cwd, n), 'utf8') } catch { return null } }
      return {
        sessionId,
        events: compactEvents(sessionId),
        run: record ? { runId: record.runId, status: record.status, attempts: stageOrder, queuedInputs: record.queuedInputs, events: record.events, error: record.error } : null,
        spawnCalls,
        executeError: capture('mixed-execute-error.txt'),
        factoryError: capture('mixed-factory-error.txt'),
      }
    })

    // 幂等复验：同一条消息（同 messageId 语义）的 run 只有一份；重复领取不得产生第二个 run
    const before = store.listRuns({ sessionId: out.sessionId }).items.length
    const c2 = makeChecks()
    c2.check('run 数量稳定（无重复领取）', before === 1, `${before}`)
    await store.close()
    return { pass: c.pass() && c2.pass(), checks: [...c.checks, ...c2.checks], artifacts: { sessionId: out.sessionId, events: out.events, run: out.run, spawnCalls: out.spawnCalls } }
  }

  const scenarioNames = Object.keys(scenarios)

  // ---------- HTTP ----------
  function json(res, code, obj) {
    const buf = Buffer.from(JSON.stringify(obj))
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length })
    res.end(buf)
  }
  async function readJson(req) {
    let raw = ''
    for await (const chunk of req) raw += chunk
    return raw ? JSON.parse(raw) : {}
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/probe/api',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const rel = url.pathname.replace(/^\/probe\/api/, '') || '/'
          const method = req.method ?? 'GET'
          try {
            if (method === 'GET' && rel === '/health') {
              return json(res, 200, {
                ok: true,
                provider: currentProvider ? Object.keys(currentProvider.providers) : null,
                providerError,
                scenarios: scenarioNames,
              })
            }
            if (method === 'POST' && rel === '/provider') {
              await applyProviderConfig(await readJson(req))
              return json(res, 200, { ok: true })
            }
            if (method === 'POST' && rel === '/scenario') {
              const body = await readJson(req)
              const name = String(body.name ?? '')
              const fn = scenarios[name]
              if (!fn) return json(res, 400, { error: { message: `未知场景 ${name}`, available: scenarioNames } })
              const env = {
                provider: currentProvider?.defaultModel?.provider ?? 'mock',
                parentRoute: { provider: currentProvider?.defaultModel?.provider ?? 'mock', model: currentProvider?.defaultModel?.model ?? 'mock-planner' },
                models: body.models ?? { planner: 'mock-planner', executor: 'mock-executor', reviewer: 'mock-reviewer', slow: 'mock-slow', plain: 'mock-plain' },
                cwd: body.cwd,
              }
              if (!env.cwd) throw new Error('场景需要 cwd（工作区目录）')
              const started = Date.now()
              const result = await Promise.race([
                fn(env),
                sleep(120_000).then(() => {
                  throw new Error('scenario timeout 120s')
                }),
              ])
              return json(res, 200, { name, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, ...result })
            }
            return json(res, 404, { error: { message: `no route ${method} ${rel}` } })
          } catch (err) {
            return json(res, 500, { error: { message: err.message, stack: String(err.stack ?? '').slice(0, 1200) } })
          }
        },
      }),
    'mixed-probe-host: web api',
  )

  console.log('[mixed-probe-host] ready')
}
