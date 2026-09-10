#!/usr/bin/env node
/**
 * Mixed P0 契约探测驱动（T01 门槛）。
 *
 * 用法：
 *   node scripts/probe-mixed-contracts.mjs [--layer 1|2|both] [--scenario s1-spawn-route ...] [--keep]
 *
 * 流程：
 *   L1 直连：临时 DSH_HOME + 最小 profile（dsh-base + dsh-web-app + 探测宿主插件），
 *           llm-pi-ai 的 mock provider 直连脚本化模型服务器，跑全部契约场景。
 *   L2 网关：同宿主把 provider 换成公司网关（createGateway 进程内实例，临时 dataDir，
 *           openai-compatible 上游 → 脚本化模型服务器），跑归属关键场景，再拉网关账本。
 *
 * 产物（docs/evidence/mixed/）：
 *   probe-results-<ts>.json     全量结构化结果
 *   invocation-log-<ts>.jsonl   脱敏后的模型调用记录（两层）
 *   compatibility.md            T01 兼容性结论（驱动决策 + 网关补丁面）
 *
 * 安全：绝不触碰 C:\Users\ethan\.dsh / server/data / 运行中内核；所有家目录在 OS 临时区。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startMockLlm } from './lib/mixed-probe/mock-llm.mjs'
import { setupProbeProfile } from './lib/mixed-probe/profile.mjs'
import { createDshWebUrlWatcher, resolveDshWebUrl } from './lib/dsh-web-url.mjs'
import { defaultPrefix, locateKernel } from './kernel/locate.mjs'
import { killTree } from './lib/bootstrap.mjs'
import { createGateway } from '../server/src/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const evidenceDir = path.join(root, 'docs', 'evidence', 'mixed')

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const LAYER = arg('--layer') ?? 'both'
const KEEP = argv.includes('--keep')
const scenarioFilter = argv.flatMap((a, i) => (a === '--scenario' ? [argv[i + 1]] : []))
const MOCK_MODELS = [
  { id: 'mock-planner', name: 'Mock Planner', contextWindow: 128000, maxTokens: 4096, reasoningEfforts: false, input: ['text'] },
  { id: 'mock-executor', name: 'Mock Executor', contextWindow: 128000, maxTokens: 4096, reasoningEfforts: false, input: ['text'] },
  { id: 'mock-reviewer', name: 'Mock Reviewer', contextWindow: 128000, maxTokens: 4096, reasoningEfforts: false, input: ['text'] },
  { id: 'mock-slow', name: 'Mock Slow', contextWindow: 128000, maxTokens: 4096, reasoningEfforts: false, input: ['text'] },
  { id: 'mock-plain', name: 'Mock Plain', contextWindow: 128000, maxTokens: 4096, reasoningEfforts: false, input: ['text'] },
  { id: 'mock-error', name: 'Mock Error', contextWindow: 128000, maxTokens: 4096, reasoningEfforts: false, input: ['text'] },
]
const L1_SCENARIOS = [
  's1-spawn-route',
  's2-output-schema',
  's2b-structured-failure',
  's3a-toolfilter-deny',
  's3b-toolfilter-allow',
  's4-cancel',
  's5-dispose',
  's6-claim-empty',
  's7-reject',
  's8-route-override',
  's9-inflight-pipeline',
  's9b-cancel-inflight',
  's10-queue',
  's11-real-bridge',
]
const L2_SCENARIOS = ['s1-spawn-route', 's8-route-override']

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const log = (...a) => console.log(`[probe ${new Date().toISOString().slice(11, 19)}]`, ...a)

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
    srv.on('error', reject)
  })
}

function sha256(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

function httpJson(url, { method = 'GET', body, token, timeoutMs = 150_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = body === undefined ? null : JSON.stringify(body)
    const req = http.request(
      u,
      {
        method,
        headers: {
          ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          let parsed = null
          try {
            parsed = raw ? JSON.parse(raw) : null
          } catch {
            parsed = raw
          }
          if (res.statusCode >= 400) {
            return reject(new Error(`${method} ${u.pathname} -> ${res.statusCode}: ${typeof parsed === 'string' ? parsed.slice(0, 400) : JSON.stringify(parsed).slice(0, 400)}`))
          }
          resolve(parsed)
        })
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs}ms ${method} ${u.pathname}`)))
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

/** 脱敏：去掉 Authorization 原文（保留前缀形态）、去掉消息正文，保留路由/工具/元数据字段结构。 */
function redact(entry) {
  const body = entry.body ?? {}
  const messages = Array.isArray(body.messages) ? body.messages : []
  return {
    i: entry.i,
    ts: entry.ts,
    method: entry.method,
    path: entry.path,
    model: entry.model,
    stream: entry.stream,
    aborted: entry.aborted,
    auth: entry.auth ? `Bearer ${entry.auth.slice(7, 10)}...<redacted>` : null,
    xHeaders: entry.headers ?? {},
    bodyKeys: body ? Object.keys(body).sort() : null,
    metadataFields: body && typeof body === 'object' && 'metadata' in body ? body.metadata : undefined,
    tools: (Array.isArray(body.tools) ? body.tools : []).map((t) => t?.function?.name ?? t?.name ?? null),
    messageCount: messages.length,
    messageRoles: messages.map((m) => m?.role).join(','),
    // 探测专用：模型实际看到的 user 文本（mock 数据，用于断言领取消费不泄漏）
    userTexts: entry.userTexts ?? [],
  }
}

// ---------- 宿主进程 ----------
function startHost({ kernelBin, dshHome, profileName, port, cwd }) {
  const child = spawn(process.execPath, [kernelBin, '--profile', profileName, '--no-open', '--port', String(port)], {
    cwd,
    env: { ...process.env, DSH_HOME: dshHome, NODE_TEST_CONTEXT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const watcher = createDshWebUrlWatcher()
  let stderrBuf = ''
  child.stdout.on('data', (c) => watcher.feed(c.toString()))
  child.stderr.on('data', (c) => {
    stderrBuf += c.toString()
    if (stderrBuf.length > 60_000) stderrBuf = stderrBuf.slice(-30_000)
  })
  return {
    child,
    watcher,
    stderr: () => stderrBuf,
    stop: async () => {
      try {
        killTree(child)
        await Promise.race([
          new Promise((r) => child.on('exit', r)),
          new Promise((r) => setTimeout(r, 8000).then(() => r(-1))),
        ])
      } catch { /* 已退出 */ }
    },
  }
}

async function waitFor(urlPath, base, timeoutMs = 90_000) {
  const t0 = Date.now()
  let lastErr = null
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await httpJson(`${base}${urlPath}`)
      return r
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 700))
    }
  }
  throw new Error(`等待 ${urlPath} 超时: ${lastErr?.message ?? '无'}`)
}

// ---------- 主流程 ----------
async function main() {
  const kernelPrefix = defaultPrefix()
  const kernel = locateKernel(kernelPrefix)
  if (!kernel) throw new Error(`内核未安装：${kernelPrefix}（先跑 node scripts/setup-profile.mjs）`)
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'kernel', 'pin.json'), 'utf8'))
  const kernelDigests = {
    version: kernel.version,
    pinned: pin.version,
    matches: String(kernel.version) === String(pin.version),
    files: {
      'dsh/package.json': sha256(path.join(kernelPrefix, 'node_modules/@deepseek-ai/dsh/package.json')),
      'dsh-agent-loop/lib/index.js': sha256(path.join(kernelPrefix, 'node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js')),
      'dsh-subagent/lib/index.js': sha256(path.join(kernelPrefix, 'node_modules/@deepseek-ai/dsh-subagent/lib/index.js')),
      'dsh-subagent-in-process-driver/lib/index.js': sha256(path.join(kernelPrefix, 'node_modules/@deepseek-ai/dsh-subagent-in-process-driver/lib/index.js')),
      'dsh-llm/package.json': sha256(path.join(kernelPrefix, 'node_modules/@deepseek-ai/dsh-llm/package.json')),
    },
  }

  const tmpDir = path.join(os.tmpdir(), `mixed-probe-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  log(`临时工作区 ${tmpDir}（用后删除${KEEP ? '，--keep 保留' : ''}）`)

  const results = []
  const invocationLog = []
  let mock = null
  let host = null
  let gw = null
  let gwInfo = null
  let fatal = null
  const cleanup = async () => {
    try { if (gw) await gw.close() } catch { /* 忽略 */ }
    try { if (host) await host.stop() } catch { /* 忽略 */ }
    try { if (mock) await mock.close() } catch { /* 忽略 */ }
    if (!KEEP) {
      // Windows 上宿主进程可能仍持有 tmpDir 句柄；稍等重试，失败也不该掩盖主错误。
      for (let i = 0; i < 5; i++) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true })
          return
        } catch (err) {
          if (i === 4) log(`临时目录清理失败（可手动删除 ${tmpDir}）: ${err.message}`)
          else await new Promise((r) => setTimeout(r, 600))
        }
      }
    }
  }

  try {
    // 1) 脚本化模型服务器
    mock = await startMockLlm({ log })

    // 2) 临时 profile + 初始 provider 配置（L1 直连 mock）
    const profile = setupProbeProfile({ root, tmpDir, kernelPrefix })
    const l1Provider = {
      providers: {
        mock: {
          displayName: 'Mock Probe',
          apiKeyEnv: 'MIXED_PROBE_KEY',
          api: 'openai-completions',
          baseURL: `${mock.baseUrl}/v1`,
          models: MOCK_MODELS,
        },
      },
      defaultModel: { provider: 'mock', model: 'mock-planner' },
    }
    fs.writeFileSync(profile.providerFile, JSON.stringify(l1Provider, null, 2))

    // 3) 起宿主（真实内核 + 临时家目录）
    const hostPort = await freePort()
    host = startHost({ kernelBin: profile.kernelBin, dshHome: profile.home, profileName: profile.profileName, port: hostPort, cwd: tmpDir })
    const webUrl = await resolveDshWebUrl({ port: hostPort, getPrinted: () => host.watcher.get(), timeoutMs: 120_000 })
    const base = new URL(webUrl).origin
    log(`宿主就绪 ${base}（web: ${webUrl.slice(0, 60)}...）`)
    await waitFor('/probe/api/health', base, 90_000)
    let health = null
    const t0 = Date.now()
    while (!health?.provider) {
      if (Date.now() - t0 > 30_000) break
      await new Promise((r) => setTimeout(r, 300))
      health = await httpJson(`${base}/probe/api/health`)
    }
    log(`探测插件就绪，场景：${health.scenarios.join(', ')}`)
    if (!health?.provider) throw new Error(`宿主未应用初始 provider 配置（宿主 stderr 尾部）:\n${host.stderr().slice(-4000)}`)

    const runScenario = async (layer, name) => {
      await httpJson(`${mock.baseUrl}/_reset`, { method: 'POST' })
      const before = invocationLog.length
      const t0 = Date.now()
      const res = await httpJson(`${base}/probe/api/scenario`, {
        method: 'POST',
        body: { name, cwd: path.join(profile.workDir, `${layer}-${name}`) },
      })
      const mockLog = await httpJson(`${mock.baseUrl}/_log`)
      for (const e of mockLog.entries) {
        const r = redact(e)
        r.layer = layer
        r.scenario = name
        invocationLog.push(r)
      }
      log(`${layer} ${name}: ${res.pass ? 'PASS' : 'FAIL'}（${res.durationMs}ms，上游调用 ${mockLog.entries.length} 次）`)
      for (const ch of res.checks ?? []) {
        if (!ch.ok) log(`   ✗ ${ch.name}${ch.detail ? ` —— ${ch.detail}` : ''}`)
      }
      return res
    }

    // 4) L1 直连层
    if (LAYER !== '2') {
      for (const name of L1_SCENARIOS.filter((n) => !scenarioFilter.length || scenarioFilter.includes(n))) {
        try {
          const res = await runScenario('L1', name)
          // 线上断言（driver 侧，用上游日志）：s6 被领取消费的消息不得出现在任何模型请求的 user 文本里
          if (name === 's6-claim-empty') {
            const s6wire = invocationLog.filter((e) => e.scenario === 's6-claim-empty')
            const leaked = s6wire.some((e) => (e.userTexts ?? []).some((t) => t.includes('mixed probe: claim me')))
            res.checks.push({ name: '（线上）被领取消息未出现在任何上游 user 文本', ok: !leaked, detail: `上游调用=${s6wire.length}` })
            res.pass = res.checks.every((ch) => ch.ok)
          }
          results.push({ layer: 'L1-direct', ...res })
        } catch (err) {
          results.push({ layer: 'L1-direct', name, pass: false, error: err.message })
          log(`${name} 异常: ${err.message}`)
        }
      }
    }

    // 5) L2 公司网关节点层（归属 + 账本 + 线上元数据缺口）
    if (LAYER !== '1') {
      try {
      const gwDataDir = path.join(tmpDir, 'gateway-data')
      gw = await createGateway({
        port: 0,
        host: '127.0.0.1',
        dataDir: gwDataDir,
        lanDiscover: false,
        seedAdmin: { username: 'probe-admin', password: 'probe-pass-123', displayName: '探测管理员', department: '探测' },
        seedUsers: [],
        seedDriveSamples: false,
        upstreams: {
          mockprobe: {
            kind: 'openai-compatible',
            label: 'Mock Probe',
            baseUrl: `${mock.baseUrl}/v1`,
            apiKey: 'mock-upstream-key',
            models: MOCK_MODELS,
          },
        },
      })
      const gwUrl = await gw.listen()
      const login = await httpJson(`${gwUrl}/api/auth/login`, { method: 'POST', body: { username: 'probe-admin', password: 'probe-pass-123', gatewayToken: true, device: 'probe' } })
      gwInfo = { url: gwUrl, user: login.user?.username, hasSessionToken: !!login.sessionToken, hasGatewayToken: !!login.gatewayToken, instanceId: null }
      // instanceId 从 dataDir 读（instance-id.js 落盘为无扩展名文件）
      try {
        gwInfo.instanceId = fs.readFileSync(path.join(gwDataDir, 'instance-id'), 'utf8').trim()
      } catch {
        gwInfo.instanceId = null
      }
      log(`网关就绪 ${gwUrl}（用户 ${gwInfo.user}，instanceId ${String(gwInfo.instanceId).slice(0, 8)}…）`)

      const l2Provider = {
        credential: login.gatewayToken,
        providers: {
          mock: {
            displayName: 'Mock Probe (via gateway)',
            apiKeyEnv: 'MIXED_PROBE_KEY',
            api: 'openai-completions',
            baseURL: `${gwUrl}/v1`,
            models: MOCK_MODELS,
          },
        },
        defaultModel: { provider: 'mock', model: 'mock-planner' },
      }
      await httpJson(`${base}/probe/api/provider`, { method: 'POST', body: l2Provider })
      log('宿主 provider 已切到网关节点')

      for (const name of L2_SCENARIOS.filter((n) => !scenarioFilter.length || scenarioFilter.includes(n))) {
        try {
          results.push({ layer: 'L2-gateway', ...await runScenario('L2', name) })
        } catch (err) {
          results.push({ layer: 'L2-gateway', name, pass: false, error: err.message })
          log(`${name} 异常: ${err.message}`)
        }
      }

      try {
        const ledger = await httpJson(`${gwUrl}/api/ledger?days=1`, { token: login.sessionToken })
        results.push({ layer: 'L2-gateway', name: 'ledger', pass: true, entries: (ledger.entries ?? []).map((e) => ({ model: e.model, promptTokens: e.promptTokens, completionTokens: e.completionTokens, costCny: e.costCny, status: e.status, extra: e.extra ?? null })) })
      } catch (err) {
        results.push({ layer: 'L2-gateway', name: 'ledger', pass: false, error: err.message })
        log(`账本读取失败（不影响场景结论）: ${err.message}`)
      }
      const wire = invocationLog.filter((e) => e.layer === 'L2')
      results.push({
        layer: 'L2-gateway',
        name: 'wire-inspection',
        pass: true,
        bodyKeys: [...new Set(wire.flatMap((e) => e.bodyKeys ?? []))].sort(),
        xHeaders: [...new Set(wire.flatMap((e) => Object.keys(e.xHeaders ?? {})))].sort(),
        sawMetadataField: wire.some((e) => e.metadataFields !== undefined),
        note: '上游收到的请求体顶层字段 / x-* 头 —— 网关→上游归属元数据通道的现状证据',
      })
      await gw.close()
      gw = null
      } catch (err) {
        results.push({ layer: 'L2-gateway', name: 'setup', pass: false, error: err.message })
        log(`L2 层异常（跳过剩余 L2 场景，不影响 L1 证据）: ${err.message}`)
        try { if (gw) await gw.close() } catch { /* 忽略 */ }
        gw = null
      }
    }

  } catch (err) {
    fatal = err
    results.push({ layer: 'FATAL', name: 'probe-driver', pass: false, error: err.message, stack: String(err.stack ?? '').slice(0, 1500) })
    log(`致命异常（继续落已收集的证据）: ${err.message}`)
  } finally {
    await cleanup()
    if (KEEP) log(`保留临时目录：${tmpDir}`)
  }

  // 6) 落证据（总是执行：即使上面某步致命异常，也把已有证据写出来）
  try {
    fs.mkdirSync(evidenceDir, { recursive: true })
    const passed = results.filter((r) => r.pass).length
    const meta = {
      ts,
      purpose: 'Mixed P0 内核契约探测（T01 门槛）',
      plan: 'docs/superpowers/plans/2026-09-09-mixed-mode-implementation.md',
      kernel: kernelDigests,
      reference: { teamGui: 'github.com/toolclub/dsh-agent-team-gui @ 561ddf5b55c433a594310f0ae6a5e21036fbcbcd' },
      environment: { os: process.platform, arch: process.arch, node: process.version, kernelPrefix },
      layer: LAYER,
      tmpDir: KEEP ? tmpDir : '（已删除）',
      summary: { total: results.length, passed, failed: results.length - passed },
      fatal: fatal ? fatal.message : null,
      gateway: gwInfo,
    }
    const resultsFile = path.join(evidenceDir, `probe-results-${ts}.json`)
    fs.writeFileSync(resultsFile, JSON.stringify({ meta, results }, null, 2))
    const logFile = path.join(evidenceDir, `invocation-log-${ts}.jsonl`)
    fs.writeFileSync(logFile, invocationLog.map((e) => JSON.stringify(e)).join('\n') + '\n')
    fs.writeFileSync(path.join(evidenceDir, 'latest-pointer.json'), JSON.stringify({ ts, resultsFile, logFile }, null, 2))
    log(`证据已写入 ${evidenceDir}（${resultsFile.split(path.sep).pop()}、${logFile.split(path.sep).pop()}）`)

    const failedNames = results.filter((r) => !r.pass).map((r) => `${r.layer}/${r.name}`)
    log(`完成：${passed}/${results.length} 通过${failedNames.length ? `；失败：${failedNames.join(', ')}` : '（全部通过）'}`)
    process.exitCode = fatal ? 2 : failedNames.length ? 1 : 0
  } catch (err) {
    log(`证据落盘失败: ${err.message}`)
    process.exitCode = 2
  }
}

main().catch((err) => {
  console.error('[probe] 失败:', err)
  process.exitCode = 2
})
