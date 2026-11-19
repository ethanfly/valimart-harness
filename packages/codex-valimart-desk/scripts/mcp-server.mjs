/** valimart desk 的 stdio MCP 服务；stdout 只写 JSON-RPC，日志一律 stderr。 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { MCP_INSTRUCTIONS } from '../lib/company-prompt.mjs'
import { driveLog, syncDrive } from '../lib/drive-runtime.mjs'
import { isLoggedIn, loadState } from '../lib/state.mjs'
import { callTool, findTool, HUD_URI, hudTree, listTools } from '../lib/tools.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'), 'utf8')).version } catch { return '0.0.0' }
})()
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const SYNC_MS = process.env.VALIMART_DRIVE_SYNC_MS ? Number(process.env.VALIMART_DRIVE_SYNC_MS) : 30_000

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
const reply = (id, result) => send({ id, result })
const replyError = (id, code, message) => send({ id, error: { code, message } })

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
    const message = err instanceof Error ? err.message : String(err)
    if (message !== lastSyncError) driveLog(`后台同步失败：${message}`)
    lastSyncError = message
  } finally { syncing = false }
}

function startSyncLoop() {
  if (timer || !(SYNC_MS > 0)) return
  backgroundSync()
  timer = setInterval(backgroundSync, SYNC_MS)
}

async function handle(msg) {
  const { id, method, params } = msg ?? {}
  if (typeof method !== 'string') return
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') startSyncLoop()
    return
  }
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false }, resources: {} },
        serverInfo: { name: 'valimart-desk', version },
        instructions: MCP_INSTRUCTIONS,
      })
    case 'ping': return reply(id, {})
    case 'tools/list': return reply(id, { tools: listTools() })
    case 'tools/call': {
      if (!findTool(params?.name)) return replyError(id, -32602, `未知工具 ${params?.name}`)
      try {
        const result = await callTool(params.name, params.arguments)
        return reply(id, { content: result.content, isError: !!result.isError })
      } catch (err) {
        return reply(id, { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true })
      }
    }
    case 'resources/list':
      return reply(id, { resources: [{ uri: HUD_URI, name: 'valimart desk HUD', mimeType: 'application/json' }] })
    case 'resources/templates/list':
      return reply(id, { resourceTemplates: [] })
    case 'resources/read': {
      if (params?.uri !== HUD_URI) return replyError(id, -32602, `未知资源 ${params?.uri}`)
      return reply(id, {
        contents: [{ uri: HUD_URI, mimeType: 'application/json', text: JSON.stringify(hudTree()) }],
      })
    }
    default: return replyError(id, -32601, `不支持的方法 ${method}`)
  }
}

process.stdout.on('error', () => process.exit(0))
process.on('unhandledRejection', (err) => driveLog(`未处理的异常：${err instanceof Error ? err.message : String(err)}`))
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { replyError(null, -32700, 'JSON 解析失败'); return }
  for (const item of Array.isArray(msg) ? msg : [msg]) handle(item).catch((err) => driveLog(`处理 ${item?.method} 出错：${err instanceof Error ? err.message : String(err)}`))
})
rl.on('close', () => { if (timer) clearInterval(timer); process.exit(0) })
