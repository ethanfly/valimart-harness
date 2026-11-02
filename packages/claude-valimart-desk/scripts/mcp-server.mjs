/**
 * valimart-desk 的 MCP 服务（stdio）：把公司盘 / 记忆 / 知识 / 任务卡工具交给 Claude Code。
 * 协议是按行分隔的 JSON-RPC 2.0；stdout 只写协议消息，日志一律走 stderr。
 * 进程跟着 Claude Code 会话起停；已登录时后台每 30 秒同步一次公司盘镜像（VALIMART_DRIVE_SYNC_MS=0 关掉）。
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { MCP_INSTRUCTIONS } from '../lib/company-prompt.mjs'
import { driveLog, syncDrive } from '../lib/drive-runtime.mjs'
import { isLoggedIn, loadState } from '../lib/state.mjs'
import { callTool, findTool, listTools } from '../lib/tools.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()

// 只用到 tools 这一块，各版本形状一致：客户端要哪版就回哪版，不认识的回 2025-06-18
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const SYNC_MS = process.env.VALIMART_DRIVE_SYNC_MS ? Number(process.env.VALIMART_DRIVE_SYNC_MS) : 30_000

function send(msg) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
}

const reply = (id, result) => send({ id, result })
const replyError = (id, code, message) => send({ id, error: { code, message } })

// 后台同步：未登录 / 需重新登录时静默跳过；同一时刻只跑一轮；同样的错误只记一次，断网时不刷屏
let timer = null
let syncing = false
let lastSyncError = ''

async function backgroundSync() {
  const state = loadState()
  if (syncing || !isLoggedIn(state) || state.needsRelogin) return
  syncing = true
  try {
    await syncDrive()
    lastSyncError = ''
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg !== lastSyncError) driveLog(`后台同步失败：${msg}`)
    lastSyncError = msg
  } finally {
    syncing = false
  }
}

function startSyncLoop() {
  if (timer || !(SYNC_MS > 0)) return
  backgroundSync()
  timer = setInterval(backgroundSync, SYNC_MS)
}

async function handle(msg) {
  const { id, method, params } = msg ?? {}
  if (typeof method !== 'string') return // 客户端发来的响应：本服务不发请求，忽略
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') startSyncLoop()
    return // 其余通知（cancelled 等）不回
  }
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion
      return reply(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'valimart-desk', version },
        instructions: MCP_INSTRUCTIONS,
      })
    }
    case 'ping':
      return reply(id, {})
    case 'tools/list':
      return reply(id, { tools: listTools() })
    case 'tools/call': {
      const name = params?.name
      if (!findTool(name)) return replyError(id, -32602, `未知工具 ${name}`)
      try {
        const r = await callTool(name, params?.arguments)
        return reply(id, { content: r.content, isError: !!r.isError })
      } catch (err) {
        return reply(id, { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true })
      }
    }
    default:
      return replyError(id, -32601, `不支持的方法 ${method}`)
  }
}

process.stdout.on('error', () => process.exit(0)) // Claude Code 先关了管道
process.on('unhandledRejection', (err) => driveLog(`未处理的异常：${err instanceof Error ? err.message : String(err)}`))

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    replyError(null, -32700, 'JSON 解析失败')
    return
  }
  for (const m of Array.isArray(msg) ? msg : [msg]) {
    handle(m).catch((err) => driveLog(`处理 ${m?.method} 出错：${err instanceof Error ? err.message : String(err)}`))
  }
})
rl.on('close', () => {
  if (timer) clearInterval(timer)
  process.exit(0)
})
