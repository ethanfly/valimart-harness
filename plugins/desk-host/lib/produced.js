/**
 * 窗口产物索引：监听会话事件流，把成功的文件写入/编辑调用记录为「该进程产出的文件」，
 * 供任务卡「自动附带窗口产物」使用。按会话持久化到 produced-index.json。
 */
import fs from 'node:fs'
import path from 'node:path'

const MUTATION_TOOLS = new Set(['write', 'edit', 'write_file', 'edit_file', 'create_file', 'str_replace_editor', 'apply_patch', 'multi_edit'])

export class ProducedIndex {
  constructor(stateDir) {
    this.file = path.join(stateDir, 'produced-index.json')
    this.pendingCalls = new Map() // callId -> { sessionId, filePath, tool }
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      this.data = { sessions: {} }
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data))
  }

  /** @param session dsh Session；@param event SessionEvent */
  observe(session, event) {
    const sessionId = String(session.id)
    const cwd = session.header?.cwd
    if (event.type === 'tool/call') {
      const { callId, name } = event.data
      if (!MUTATION_TOOLS.has(name)) return
      let args = {}
      try {
        args = typeof event.data.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data.arguments ?? {}
      } catch {
        return
      }
      const raw = args.file_path ?? args.path ?? args.filePath
      if (typeof raw !== 'string' || raw.length === 0) return
      const resolved = path.isAbsolute(raw) ? raw : cwd ? path.resolve(cwd, raw) : raw
      this.pendingCalls.set(callId, { sessionId, filePath: resolved, tool: name })
      return
    }
    if (event.type === 'tool/result') {
      const block = event.data.message?.content?.[0]
      const callId = block?.toolCallId ?? event.data.callId
      const pending = callId ? this.pendingCalls.get(callId) : undefined
      if (!pending) return
      this.pendingCalls.delete(callId)
      if (block?.isError || event.data.error) return
      const list = (this.data.sessions[sessionId] ??= [])
      const existing = list.find((p) => p.path === pending.filePath)
      if (existing) {
        existing.ts = new Date().toISOString()
        existing.count = (existing.count ?? 1) + 1
      } else list.push({ path: pending.filePath, tool: pending.tool, ts: new Date().toISOString(), count: 1 })
      this.save()
    }
  }

  /** 会话产出的文件列表（附本地存在性与大小）。 */
  list(sessionId) {
    const items = this.data.sessions[String(sessionId)] ?? []
    return items.map((p) => {
      let size = null
      let exists = false
      try {
        const st = fs.statSync(p.path)
        exists = st.isFile()
        size = st.size
      } catch {
        /* 文件已不存在 */
      }
      return { ...p, name: path.basename(p.path), exists, size }
    })
  }

  /** 也从内存中的会话事件重建（会话在索引启动前就运行过时的兜底）。 */
  rebuildFrom(session) {
    for (const event of session.events ?? []) this.observe(session, event)
  }
}
