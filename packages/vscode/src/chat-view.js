/**
 * Sidebar + detachable editor webview: chat + 任务卡. Renders only; protocol lives in SessionController.
 */
import fs from 'node:fs'
import path from 'node:path'
import * as vscode from 'vscode'
import { defaultDevice } from './session.js'
import { looksLikeSlashCommand } from './lib/slash.js'
import { renderMarkdown } from './lib/markdown.js'
import { ChangeDocumentProvider } from './lib/change-document-provider.js'

export const CHAT_VIEW_ID = 'valimartHarness.chat'
export const CHAT_EDITOR_VIEW_TYPE = 'valimartHarness.chatEditor'

function nonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

export function currentEditorContext() {
  const editor = vscode.window.activeTextEditor
  const folder = vscode.workspace.workspaceFolders?.[0]
  const workspaceRoot = folder?.uri.fsPath ?? null
  const currentFile = editor?.document?.uri?.scheme === 'file' ? editor.document.uri.fsPath : null
  const selection =
    editor && editor.selection && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : ''
  return { currentFile, selection, workspaceRoot }
}

export class ChatViewProvider {
  static viewType = CHAT_VIEW_ID

  constructor(context, session, log) {
    this.context = context
    this.session = session
    this.log = log ?? null
    this.view = undefined
    this.busy = false
    this.diffs = new ChangeDocumentProvider()
    this.targets = new Set()
    this.editorPanel = undefined
    this.context?.subscriptions?.push(this.diffs.register())
  }

  attach(webview) {
    this.targets.add(webview)
    return () => this.targets.delete(webview)
  }

  /** 点文件名：有本轮改动就开原生 diff，否则直接打开文件。 */
  async openChange({ path: relPath, sessionId, mode, line } = {}) {
    const root = this.session.getWorkspaceRoot?.() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null
    const change = relPath ? this.session.getFileChange({ path: relPath, sessionId }) : null
    const abs = change?.abs ?? (root && relPath ? path.join(root, relPath) : null)
    if (!abs) {
      vscode.window.showWarningMessage('找不到文件：先打开一个工作区文件夹。')
      return { ok: false, reason: 'no-root' }
    }
    const afterUri = vscode.Uri.file(abs)
    if (mode === 'file' || !change || !change.hasDiff) {
      const doc = await vscode.window.showTextDocument(afterUri, { preview: true })
      const n = Number(line)
      if (Number.isInteger(n) && n > 0) {
        const pos = new vscode.Position(Math.max(0, n - 1), 0)
        doc.selection = new vscode.Selection(pos, pos)
        doc.revealRange(new vscode.Range(pos, pos))
      }
      return { ok: true, mode: 'file', path: relPath }
    }
    const beforeUri = this.diffs.makeUri(change.path)
    this.diffs.set(beforeUri, change.before)
    this.diffs.prune()
    const label = change.created ? '新建' : `+${change.added} −${change.removed}`
    await vscode.commands.executeCommand(
      'vscode.diff',
      beforeUri,
      afterUri,
      `${path.basename(change.path)}（本轮改动 ${label}）`,
      { preview: true },
    )
    return { ok: true, mode: 'diff', path: change.path }
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView
    this.wireWebview(webviewView.webview)
    webviewView.onDidChangeVisibility?.(() => {
      if (!webviewView.visible) return
      this.pushState()
      this.pushContext()
    })
    this.pushState()
    this.pushContext()
  }

  wireWebview(webview) {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    }
    webview.html = this.buildHtml(webview)
    const detach = this.attach(webview)
    webview.onDidReceiveMessage((msg) => this.onMessage(msg))
    webview.onDidDispose?.(() => detach())
    return detach
  }

  async openInEditor() {
    if (this.editorPanel) {
      this.editorPanel.reveal(vscode.ViewColumn.Beside, false)
      return this.editorPanel
    }
    const panel = vscode.window.createWebviewPanel(
      CHAT_EDITOR_VIEW_TYPE,
      'valimart harness',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] },
    )
    this.editorPanel = panel
    const detach = this.wireWebview(panel.webview)
    this.pushState()
    this.pushContext()
    panel.onDidDispose(() => {
      detach()
      if (this.editorPanel === panel) this.editorPanel = undefined
    })
    return panel
  }

  reveal() {
    this.view?.show?.(true)
  }

  post(payload) {
    for (const webview of this.targets) {
      try {
        webview.postMessage(payload)
      } catch {
        this.targets.delete(webview)
      }
    }
  }

  pushState() {
    this.post({ type: 'state', state: this.session.publicState(), busy: this.busy })
  }

  pushContext() {
    this.post({ type: 'context', context: currentEditorContext() })
  }

  async onMessage(msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'cancel') {
      this.session.cancel()
      return
    }
    if (this.busy && ['login', 'logout', 'newSession', 'switchSession', 'renameSession', 'deleteSession', 'setModel', 'setEffort', 'setAutoMemory', 'companyRefresh', 'taskBind'].includes(msg.type)) return
    try {
      switch (msg.type) {
        case 'ready':
          this.pushState()
          this.pushContext()
          if (this.session.store.loggedIn) {
            await this.session.companyContext.refresh()
            this.pushState()
          }
          return
        case 'companyRefresh':
          await this.session.companyContext.refresh()
          await this.session.syncDrive().catch(() => {})
          this.pushState()
          return
        case 'driveSync':
          await this.session.syncDrive()
          this.pushState()
          return
        case 'openDrive':
          if (this.session.driveDir) {
            await vscode.commands.executeCommand('valimartHarness.openDrive')
          }
          return
        case 'setAutoMemory':
          this.session.store.data.autoMemory = !!msg.enabled
          this.session.store.save()
          this.pushState()
          return
        case 'login':
          this.busy = true
          this.pushState()
          await this.session.login({
            gatewayUrl: msg.gatewayUrl,
            username: msg.username,
            password: msg.password,
            device: this.session.store.data.device ?? defaultDevice(),
          })
          this.busy = false
          this.pushState()
          return
        case 'logout':
          await this.session.logout()
          this.pushState()
          return
        case 'setModel':
          this.session.setModel(msg.id)
          this.pushState()
          return
        case 'setEffort':
          this.session.setEffort(msg.effort)
          this.pushState()
          return
        case 'mention-search': {
          const result = this.session.searchMentions(msg.query, { limit: 24, force: !!msg.force })
          this.post({ type: 'mention-result', requestId: msg.requestId ?? null, ...result })
          return
        }
        case 'discover': {
          try {
            const result = await this.session.discoverGateways({
              gatewayUrl: msg.gatewayUrl,
              force: !!msg.force,
              keepUrl: !!msg.keepUrl,
            })
            this.post({ type: 'discover-result', requestId: msg.requestId ?? null, ...result })
          } catch (err) {
            this.post({
              type: 'discover-result',
              requestId: msg.requestId ?? null,
              gateways: [],
              picked: '',
              error: err?.message ?? String(err),
            })
          }
          return
        }
        case 'openChange': {
          const opened = await this.openChange({ path: msg.path, sessionId: msg.sessionId, mode: msg.mode, line: msg.line })
          this.post({ type: 'openChange-result', requestId: msg.requestId ?? null, ...opened })
          return
        }
        case 'newSession':
          this.session.newSession()
          this.pushState()
          return
        case 'switchSession':
          this.session.switchSession(msg.id)
          this.pushState()
          return
        case 'renameSession':
          this.session.renameSession(msg.id, msg.title)
          this.pushState()
          return
        case 'deleteSession':
          this.session.deleteSession(msg.id)
          this.pushState()
          return
        case 'openEditor':
          await this.openInEditor()
          return
        case 'slash':
        case 'send':
          await this.handleComposer(msg)
          return
        case 'taskRefresh':
          await Promise.all([this.session.refreshTasks(), this.session.refreshPeople()])
          this.pushState()
          return
        case 'taskCreate':
          await this.session.createTask({ title: msg.title, content: msg.content })
          this.pushState()
          return
        case 'taskSelect':
          await this.session.openTask(msg.id)
          this.pushState()
          return
        case 'taskPatch':
          await this.session.patchTask(msg.id, msg.patch)
          this.pushState()
          return
        case 'taskBind':
          await this.session.bindCurrentSession(msg.id)
          this.pushState()
          return
        case 'taskDeliverable':
          await this.session.addTaskDeliverable(msg.id, {
            name: msg.name,
            dataBase64: msg.dataBase64,
            source: 'vscode',
            sessionId: this.session.currentId,
          })
          this.pushState()
          return
        case 'taskSubmit':
          await this.session.patchTask(msg.id, { submission: msg.submission, content: msg.content })
          await this.session.submitTask(msg.id, { reviewerId: msg.reviewerId })
          this.pushState()
          return
        case 'taskReview':
          await this.session.reviewTask(msg.id, { decision: msg.decision, comment: msg.comment })
          this.pushState()
          return
        case 'taskFinal':
          await this.session.finalTask(msg.id, { decision: msg.decision, comment: msg.comment })
          this.pushState()
          return
        default:
          return
      }
    } catch (err) {
      const message = err?.message ?? String(err)
      this.log?.error(message)
      if (['login', 'send', 'slash'].includes(msg.type)) {
        this.busy = false
        if (msg.type !== 'login') this.session.pushSystemNote(`运行中断：${message}`, { error: true })
        this.post({ type: 'error', message, inTranscript: msg.type !== 'login' })
      } else {
        this.post({ type: 'error', message })
      }
      this.pushState()
    }
  }

  async handleComposer(msg) {
    if (this.busy) {
      this.post({ type: 'error', message: '上一个任务还在进行中，请等它返回后再发送（或先点“停止”/“新会话”）。' })
      return
    }
    const text = String(msg.prompt ?? msg.text ?? '')
    if (looksLikeSlashCommand(text.trim())) {
      const result = this.session.handleSlash(text.trim())
      if (result) {
        if (result.message) this.session.pushSystemNote(result.message)
        this.post({ type: 'slash-result', result, inTranscript: !!result.message, html: renderMarkdown(result.message ?? '') })
        this.pushState()
        if (result.startSync) {
          this.busy = true
          this.pushState()
          try {
            const r = await this.session.syncDrive()
            const note = `公司盘已同步：远端 ${r.files} 个，下载 ${r.pulled}，回推 ${r.pushed}\n${r.driveDir}`
            this.session.pushSystemNote(note)
            this.post({ type: 'slash-result', result: { ...result, message: note }, inTranscript: true, html: renderMarkdown(note) })
          } finally {
            this.busy = false
            this.pushState()
          }
        }
        if (result.startLoop) {
          this.busy = true
          this.pushState()
          try {
            const goal = await this.session.runGoal({
              onEvent: (ev) => this.post({ type: 'event', event: ev }),
            })
            const note =
              goal.stopped === 'condition_held' ? `目标已达成：${goal.condition}` : `目标循环结束：${goal.stopped}`
            this.session.pushSystemNote(note)
            this.post({ type: 'goal-stopped', result: goal, inTranscript: true, html: renderMarkdown(note) })
          } finally {
            this.busy = false
            this.pushState()
          }
        }
      }
      return
    }
    this.busy = true
    this.pushState()
    try {
      await this.session.send(text, {
        images: msg.images ?? [],
        onEvent: (ev) => {
          if (ev.type === 'transcript') this.pushState()
          else this.post({ type: 'event', event: ev })
        },
      })
    } finally {
      this.busy = false
    }
    this.pushState()
  }

  buildHtml(webview) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media')
    const template = fs.readFileSync(path.join(this.context.extensionPath, 'media', 'chat.html'), 'utf8')
    const n = nonce()
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'))
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js'))
    const mark = webview.asWebviewUri(vscode.Uri.joinPath(media, 'mark.png'))
    return template
      .replaceAll('{{cspSource}}', webview.cspSource)
      .replaceAll('{{nonce}}', n)
      .replaceAll('{{css}}', String(css))
      .replaceAll('{{js}}', String(js))
      .replaceAll('{{mark}}', String(mark))
  }
}

export function bindEditorContext(context, provider) {
  const fire = () => provider.pushContext()
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(fire),
    vscode.window.onDidChangeTextEditorSelection(fire),
    vscode.workspace.onDidChangeWorkspaceFolders(fire),
  )
}
