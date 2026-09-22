/**
 * Login + agent send + sessions + slash + 任务卡 orchestration. No VS Code types here.
 */
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { catalogModelId, catalogModels, findCatalogModel, listEfforts, resolveSelection } from './lib/models.js'
import { summarizeQuota } from './lib/quota.js'
import { buildTurnPayload, extractMessageText, appendContextToContent } from './lib/chat-payload.js'
import { buildEditorContext } from './lib/editor-context.js'
import { createWorkspaceTools } from './lib/workspace-fs.js'
import { extractMentions, resolveMentions, formatMentionBlock } from './lib/mentions.js'
import { WorkspaceIndex } from './lib/workspace-index.js'
import { runAgentLoop, DEFAULT_SYSTEM_PROMPT, DEFAULT_MAX_TURNS, DEFAULT_MAX_ELAPSED_MS } from './lib/agent-loop.js'
import { FileChangeLog, summarizeChange } from './lib/text-diff.js'
import { CompanyContext } from './lib/company-context.js'
import { DriveMirror, makeDriveGateway } from './lib/drive-mirror.js'
import { parseSlashInput, dispatchSlash, SLASH_COMMANDS } from './lib/slash.js'
import { GatewayFinder, normalizeUrl } from './lib/lan-discover.js'
import { runUntilGoal, workspaceGoalCheck } from './lib/goal.js'
import { TaskClient, TASK_QUAD, TASK_OVERVIEW_FIELDS, TASK_STATUS_LABELS } from './lib/tasks.js'
import { renderMarkdown } from './lib/markdown.js'
import { ChatStore } from './lib/chat-store.js'
import { autoSessionTitle, shouldAutoTitle, DEFAULT_SESSION_TITLE } from './lib/session-title.js'

export function defaultDevice() {
  return `vscode:${os.hostname()}`
}

function newChatSession() {
  const now = new Date().toISOString()
  return {
    id: `chat-${crypto.randomBytes(6).toString('hex')}`,
    title: DEFAULT_SESSION_TITLE,
    titleLocked: false,
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
}

export class SessionController {
  constructor({ store, client, getWorkspaceRoot, getEditorContext, gatewayFinder, chatStore } = {}) {
    this.store = store
    this.client = client
    this.tasks = new TaskClient(client)
    this.driveDir = this.store?.dir ? path.join(this.store.dir, 'drive') : null
    this.driveLog = ''
    this.mirror = this.driveDir && client
      ? new DriveMirror({
          root: this.driveDir,
          gateway: makeDriveGateway(client),
          state: store,
          log: (m) => {
            this.driveLog = m
          },
        })
      : null
    this.companyContext = new CompanyContext(client, { mirror: this.mirror })
    this.getWorkspaceRoot = getWorkspaceRoot ?? (() => null)
    this.getEditorContext = getEditorContext ?? (() => ({}))
    this.fileIndex = new WorkspaceIndex({ getWorkspaceRoot: () => this.getWorkspaceRoot() })
    this.gatewayFinder = gatewayFinder ?? new GatewayFinder()
    this.fileChanges = new FileChangeLog()
    this.limits = { maxTurns: DEFAULT_MAX_TURNS, maxElapsedMs: DEFAULT_MAX_ELAPSED_MS }
    this.chatStore = chatStore ?? (store?.dir ? new ChatStore(store.dir) : null)
    this.chats = [newChatSession()]
    this.currentId = this.chats[0].id
    this.selectedModel = null
    this.selectedEffort = null
    this.goal = null
    this.taskList = []
    this.taskDetail = null
    this.people = []
    this.boundTaskId = null
    this.abort = null
    if (this.store?.loggedIn) this.restoreChats()
  }

  username() {
    return this.store?.data?.user?.username ?? ''
  }

  restoreChats() {
    const loaded = this.chatStore?.load(this.username())
    if (loaded?.chats?.length) {
      this.chats = loaded.chats
      this.currentId = loaded.currentId && this.chats.some((c) => c.id === loaded.currentId) ? loaded.currentId : this.chats[0].id
    } else {
      this.chats = [newChatSession()]
      this.currentId = this.chats[0].id
    }
    return this.chats
  }

  persistChats() {
    try {
      this.chatStore?.save(this.username(), { currentId: this.currentId, chats: this.chats })
    } catch {
      /* disk full / tests without a dir */
    }
  }

  current() {
    return this.chats.find((c) => c.id === this.currentId) ?? this.chats[0]
  }

  get transcript() {
    return this.current()?.messages ?? []
  }

  historyMessages() {
    return this.transcript
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role,
        content: m.apiContent ?? m.content ?? '',
      }))
  }

  publicState() {
    const view = this.store.publicView()
    let model = this.selectedModel
    try {
      if (!model && view.company) model = catalogModelId(view.company)
    } catch {
      model = null
    }
    const catalog = findCatalogModel(view.company, model)
    const efforts = listEfforts(catalog)
    return {
      ...view,
      model,
      effort: this.selectedEffort,
      models: catalogModels(view.company).map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        provider: m.provider,
        reasoningEfforts: m.reasoningEfforts ?? null,
      })),
      efforts,
      quota: summarizeQuota(view.quota),
      sessionId: this.currentId,
      sessions: this.chats.map((c) => ({
        id: c.id,
        title: c.title,
        titleLocked: !!c.titleLocked,
        updatedAt: c.updatedAt,
        createdAt: c.createdAt,
      })),
      transcript: this.transcript,
      goal: this.goal,
      slashCommands: SLASH_COMMANDS,
      tasks: this.taskList,
      taskDetail: this.taskDetail,
      people: this.people,
      boundTaskId: this.boundTaskId,
      driveDir: this.driveDir,
      lastSyncAt: this.store?.data?.lastSyncAt ?? null,
      driveLog: this.driveLog,
      companyContext: this.companyContext.state,
      autoMemory: this.store.data.autoMemory !== false,
      peopleStatus: this.peopleStatus ?? 'idle',
      peopleError: this.peopleError,
      taskQuad: TASK_QUAD,
      taskOverviewFields: TASK_OVERVIEW_FIELDS,
      taskStatusLabels: TASK_STATUS_LABELS,
    }
  }

  async login({ gatewayUrl, username, password, device }) {
    await this.client.login({
      gatewayUrl,
      username,
      password,
      device: device ?? this.store.data.device ?? defaultDevice(),
    })
    try {
      const sel = resolveSelection(this.store.data.company, {})
      this.selectedModel = sel.modelId
      this.selectedEffort = sel.efforts[0] ?? null
    } catch {
      this.selectedModel = null
      this.selectedEffort = null
    }
    this.boundTaskId = null
    this.taskList = []
    this.taskDetail = null
    this.people = []
    this.companyContext.reset()
    this.restoreChats()
    await Promise.all([
      this.companyContext.refresh(),
      this.syncDrive().catch((e) => {
        this.driveLog = e.message
      }),
    ])
    return this.publicState()
  }

  async logout() {
    this.persistChats()
    await this.client.logout()
    this.companyContext.reset()
    this.fileChanges = new FileChangeLog()
    this.chats = [newChatSession()]
    this.currentId = this.chats[0].id
    this.selectedModel = null
    this.selectedEffort = null
    this.goal = null
    this.taskList = []
    this.taskDetail = null
    this.people = []
    this.boundTaskId = null
    return this.publicState()
  }

  async refreshMe() {
    const me = await this.client.me()
    this.store.data.user = me.user
    this.store.data.company = me.company
    this.store.data.quota = me.quota
    this.store.save()
    return me
  }

  setModel(id) {
    const sel = resolveSelection(this.store.data.company, { modelId: id, effort: this.selectedEffort })
    this.selectedModel = sel.modelId
    this.selectedEffort = sel.effort
    return sel
  }

  setEffort(effort) {
    const sel = resolveSelection(this.store.data.company, { modelId: this.selectedModel, effort })
    if (sel.efforts.length && !sel.efforts.includes(String(effort))) {
      throw new Error(`思考强度 ${effort} 不在模型 ${sel.modelId} 的可选列表里`)
    }
    this.selectedModel = sel.modelId
    this.selectedEffort = String(effort)
    return sel
  }

  newSession() {
    const session = newChatSession()
    this.chats.push(session)
    this.currentId = session.id
    this.boundTaskId = null
    this.goal = null
    this.persistChats()
    return session
  }

  switchSession(id) {
    const next = this.chats.find((c) => c.id === id)
    if (!next) throw new Error('找不到这个会话')
    this.currentId = next.id
    this.boundTaskId = null
    this.persistChats()
    return next
  }

  renameSession(id, title) {
    const chat = this.chats.find((c) => c.id === (id || this.currentId))
    if (!chat) throw new Error('找不到这个会话')
    const next = String(title ?? '').trim()
    if (!next) throw new Error('标题不能为空')
    chat.title = next.slice(0, 80)
    chat.titleLocked = true
    chat.updatedAt = new Date().toISOString()
    this.persistChats()
    return chat
  }

  deleteSession(id) {
    const target = id || this.currentId
    if (this.chats.length <= 1) {
      const only = this.chats[0]
      only.messages = []
      only.title = DEFAULT_SESSION_TITLE
      only.titleLocked = false
      only.updatedAt = new Date().toISOString()
      this.fileChanges.clear(only.id)
      this.persistChats()
      return only
    }
    this.chats = this.chats.filter((c) => c.id !== target)
    if (this.currentId === target) this.currentId = this.chats[this.chats.length - 1].id
    this.fileChanges.clear(target)
    this.persistChats()
    return this.current()
  }

  cancel() {
    this.abort?.abort()
    return { ok: true }
  }

  /** 单轮往返上限 / 墙钟上限（来自 VS Code 设置）。maxTurns = 0 表示不限制。 */
  setLimits({ maxTurns, maxElapsedMs } = {}) {
    if (Number.isFinite(maxTurns) && maxTurns >= 0) this.limits.maxTurns = Math.floor(maxTurns)
    if (Number.isFinite(maxElapsedMs) && maxElapsedMs > 0) this.limits.maxElapsedMs = Math.floor(maxElapsedMs)
    return { ...this.limits }
  }

  /** 改动预览：拿某次会话里这个文件的 before/after。 */
  getFileChange({ path: relPath, sessionId } = {}) {
    const entry = this.fileChanges.get(sessionId ?? this.currentId, relPath)
    if (!entry) return null
    return {
      path: entry.path,
      abs: entry.abs,
      before: entry.before,
      after: entry.after,
      created: entry.created,
      sessionId: entry.sessionId,
      ...summarizeChange(entry),
    }
  }

  setGoal(condition) {
    this.goal = { condition: String(condition), cleared: false, setAt: new Date().toISOString() }
    return this.goal
  }

  clearGoal() {
    this.goal = null
    return null
  }

  handleSlash(text) {
    const parsed = parseSlashInput(text)
    // 只有真正的斜杠命令才在这里处理；其它以 / 开头的输入（路径、//、/123）交给模型当普通消息。
    if (!parsed || !parsed.known) return null
    return dispatchSlash(this, parsed)
  }

  /** @ 补全面板的候选：模糊匹配工作区文件；query 为空时给最近改动过的。 */
  searchMentions(query, { limit = 24, force = false } = {}) {
    const { paths, root } = this.fileIndex.search(query, { limit, force })
    return { paths, root, query: String(query ?? '') }
  }

  /**
   * 局域网找网关：本机 → UDP 广播/组播 → HTTP /24 扫描（与桌面客户端同一协议）。
   * 结果 30 秒内复用；未登录时把选中的地址记进本地状态，下次打开直接填好。
   */
  async discoverGateways({ gatewayUrl, force = false, keepUrl = false, ...rest } = {}) {
    const lastUrl = normalizeUrl(gatewayUrl) || normalizeUrl(this.store.data.gatewayUrl) || ''
    const result = await this.gatewayFinder.find({ lastUrl, force, ...rest })
    const picked = result.picked || ''
    if (picked && !keepUrl && !this.store.loggedIn && picked !== this.store.data.gatewayUrl) {
      this.store.data.gatewayUrl = picked
      this.store.save()
    }
    return {
      gateways: (result.gateways ?? []).map((g) => ({
        name: g.name ?? '',
        urls: g.urls ?? [],
        needsSetup: !!g.needsSetup,
        instanceId: g.instanceId,
        source: g.source ?? 'http',
      })),
      picked,
      lastUrl,
      cached: !!result.cached,
      at: new Date().toISOString(),
    }
  }

  /** 把提示/错误写进当前会话，刷新后仍然可见。 */
  pushSystemNote(message, { error = false } = {}) {
    const text = String(message ?? '').trim()
    if (!text) return null
    const note = { role: 'system', content: text, html: renderMarkdown(text), error }
    this.current().messages.push(note)
    this.current().updatedAt = new Date().toISOString()
    this.persistChats()
    return note
  }

  async send(prompt, { images = [], onEvent } = {}) {
    const text = String(prompt ?? '').trim()
    if (!text && !(images && images.length)) throw new Error('请输入提示词')
    if (!this.store.loggedIn) throw new Error('请先登录公司网关')
    const workspaceRoot = this.getWorkspaceRoot()
    if (!workspaceRoot) throw new Error('请先打开一个工作区文件夹')
    this.abort = new AbortController()
    const signal = this.abort.signal
    try {
      const model = this.selectedModel ?? catalogModelId(this.store.data.company)
      const effort = this.selectedEffort
      const rawCtx = this.getEditorContext?.() ?? {}
      const editorContext = buildEditorContext({ ...rawCtx, workspaceRoot })
      const history = this.historyMessages()
      const mentions = extractMentions(text)
      let inlined = { attachments: [], missing: [], chars: 0 }
      if (mentions.length) {
        onEvent?.({ type: 'stage', message: `正在内联 ${mentions.length} 个 @文件` })
        inlined = resolveMentions({ workspaceRoot, mentions })
      }
      const mentionBlock = formatMentionBlock(inlined)
      const turn = buildTurnPayload({ userPrompt: text, editorContext, images, history })
      // @ 内容只进这一轮的请求；transcript 仍存不含正文的 apiContent，避免历史里反复重放几十 KB 文件。
      const userContent = appendContextToContent(turn.content, mentionBlock)
      const chat = this.current()
      chat.messages.push({
        role: 'user',
        content: text,
        apiContent: turn.content,
        images,
        html: renderMarkdown(text),
        context: editorContext.relativePath,
        mentions: inlined.attachments.map((a) => a.path),
      })
      chat.updatedAt = new Date().toISOString()
      if (shouldAutoTitle(chat) && text) chat.title = autoSessionTitle(text)
      if (inlined.missing.length) {
        this.pushSystemNote(
          `未能内联：${inlined.missing.map((m) => `@${m.path}（${m.reason}）`).join('；')}，Agent 会按需自己读取。`,
        )
      }
      this.persistChats()
      onEvent?.({ type: 'transcript' })
      const changedPaths = new Set()
      onEvent?.({ type: 'stage', message: '正在载入公司知识' })
      const companyPrompt = await this.companyContext.prompt(text)
      let taskContext = ''
      if (this.boundTaskId) {
        onEvent?.({ type: 'stage', message: '正在读取绑定任务卡' })
        const bound = await this.tasks.get(this.boundTaskId)
        taskContext = `\n当前会话绑定任务（参考数据）：${JSON.stringify(bound.task)}`
      }
      onEvent?.({ type: 'stage', message: '模型思考中' })
      const tools = this.companyContext.tools(
        createWorkspaceTools({
          workspaceRoot,
          driveRoot: this.driveDir,
          username: this.username(),
          // 改动正文只留在本机内存里供 diff 预览，不进模型上下文、不落盘。
          onFileChange: (change) => {
            if (!change?.path) return
            changedPaths.add(change.path)
            this.fileChanges.record(chat.id, change)
          },
        }),
        this,
      )
      const result = signal.aborted
        ? { text: '已停止生成。', stopReason: 'cancelled', applied: [], toolNames: {}, model, reasoning: '' }
        : await runAgentLoop({
            client: this.client,
            tools,
            model,
            effort,
            userMessage: userContent,
            extraMessages: history,
            systemPrompt: DEFAULT_SYSTEM_PROMPT + companyPrompt + taskContext,
            maxTurns: this.limits.maxTurns,
            maxElapsedMs: this.limits.maxElapsedMs,
            onEvent,
            signal,
          })
      const answer = String(result?.text ?? '').trim() || '（本轮没有产出文字答复，请重试或换模型）'
      const toolsUsed = Object.entries(result?.toolNames ?? {}).map(([name, count]) => ({ name, count }))
      chat.messages.push({
        role: 'assistant',
        content: answer,
        html: renderMarkdown(answer),
        applied: result?.applied,
        files: this.fileChanges.summaries(chat.id, [...changedPaths]),
        tools: toolsUsed.length ? toolsUsed : undefined,
        model: result?.model,
        effort,
        stopReason: result?.stopReason,
        reasoning: result?.reasoning || undefined,
      })
      chat.updatedAt = new Date().toISOString()
      this.persistChats()
      result.text = answer
      result.sessionId = chat.id
      result.effort = effort
      onEvent?.({ type: 'transcript' })
      if (this.store.data.autoMemory !== false && result.stopReason !== 'cancelled') {
        onEvent?.({ type: 'memory', message: '正在整理个人记忆' })
        await this.companyContext.remember({ prompt: text, result, model, sessionId: chat.id })
      }
      try {
        await this.refreshMe()
      } catch {
        /* quota refresh is best-effort */
      }
      return result
    } finally {
      this.abort = null
    }
  }

  async runGoal({ onEvent, check } = {}) {
    const workspaceRoot = this.getWorkspaceRoot()
    const checker =
      check ?? ((condition) => workspaceGoalCheck(workspaceRoot, condition))
    return runUntilGoal({
      getGoal: () => this.goal,
      sendTurn: (prompt) => this.send(prompt, { onEvent }),
      check: checker,
      onEvent,
    })
  }

  async syncDrive() {
    if (!this.store.loggedIn) throw new Error('请先登录公司网关')
    if (!this.mirror) throw new Error('没有公司盘镜像目录')
    const r = await this.mirror.sync()
    return { ...r, driveDir: this.driveDir, log: this.driveLog }
  }

  async refreshTasks() {
    const r = await this.tasks.list()
    this.taskList = r.tasks ?? []
    return r
  }

  async refreshPeople() {
    this.peopleStatus = 'loading'
    this.peopleError = null
    try {
      const r = await this.tasks.people()
      this.people = r.users ?? r.people ?? []
      this.peopleStatus = 'ready'
      return r
    } catch (e) {
      this.people = []
      this.peopleStatus = 'error'
      this.peopleError = e.message
      throw e
    }
  }

  async createTask(body) {
    const r = await this.tasks.create(body)
    this.taskDetail = r.task
    this.mirror?.writeTaskCard(r.task)
    await this.refreshTasks()
    return r
  }

  async openTask(id) {
    const r = await this.tasks.get(id)
    this.taskDetail = r.task
    this.mirror?.writeTaskCard(r.task)
    return r
  }

  async patchTask(id, patch) {
    const r = await this.tasks.update(id, patch)
    this.taskDetail = r.task
    await this.refreshTasks()
    return r
  }

  async bindCurrentSession(taskId) {
    const r = await this.tasks.bindSession(taskId, {
      sessionId: this.currentId,
      title: this.current()?.title,
      device: this.store.data.device,
    })
    this.taskDetail = r.task
    this.boundTaskId = taskId
    this.mirror?.writeTaskCard(r.task)
    return r
  }

  async addTaskDeliverable(taskId, file) {
    const r = await this.tasks.addDeliverables(taskId, [file])
    this.taskDetail = r.task
    return r
  }

  async submitTask(taskId, { reviewerId }) {
    const r = await this.tasks.submit(taskId, { reviewerId })
    this.taskDetail = r.task
    await this.refreshTasks()
    return r
  }

  async reviewTask(taskId, body) {
    const r = await this.tasks.review(taskId, body)
    this.taskDetail = r.task
    await this.refreshTasks()
    return r
  }

  async finalTask(taskId, body) {
    const r = await this.tasks.final(taskId, body)
    this.taskDetail = r.task
    await this.refreshTasks()
    return r
  }
}

export { extractMessageText, SLASH_COMMANDS }
