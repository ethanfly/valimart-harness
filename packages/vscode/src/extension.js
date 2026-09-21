import * as vscode from 'vscode'
import { TokenStore } from './lib/token-store.js'
import { GatewayClient } from './lib/gateway-client.js'
import { SessionController, defaultDevice } from './session.js'
import { ChatViewProvider, CHAT_VIEW_ID, currentEditorContext, bindEditorContext } from './chat-view.js'
import { DEFAULT_MAX_TURNS, DEFAULT_MAX_ELAPSED_MS } from './lib/agent-loop.js'
import { ChatStore } from './lib/chat-store.js'
import { HarnessLog } from './lib/harness-log.js'

export const OPEN_CHAT_COMMAND = 'valimartHarness.openChat'
export const OPEN_CHAT_WINDOW_COMMAND = 'valimartHarness.openChatWindow'
export const SHOW_LOGS_COMMAND = 'valimartHarness.showLogs'
export const CANCEL_COMMAND = 'valimartHarness.cancel'

export function activate(context) {
  const stateDir = context.globalStorageUri?.fsPath ?? context.globalStoragePath
  const channel = vscode.window.createOutputChannel('valimart harness')
  const log = new HarnessLog(channel)
  const store = new TokenStore(stateDir)
  store.data.device = store.data.device ?? defaultDevice()
  store.save()
  const client = new GatewayClient(store, { log })
  const session = new SessionController({
    store,
    client,
    chatStore: new ChatStore(stateDir),
    getWorkspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
    getEditorContext: () => currentEditorContext(),
  })
  const applyLimits = () => {
    const cfg = vscode.workspace.getConfiguration('valimartHarness')
    const minutes = Number(cfg.get('maxMinutes', DEFAULT_MAX_ELAPSED_MS / 60_000))
    const turns = Number(cfg.get('maxTurns', DEFAULT_MAX_TURNS))
    session.setLimits({
      maxTurns: Number.isFinite(turns) && turns >= 0 ? turns : DEFAULT_MAX_TURNS,
      maxElapsedMs: (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_MAX_ELAPSED_MS / 60_000) * 60_000,
    })
  }
  applyLimits()
  const provider = new ChatViewProvider(context, session, log)
  context.subscriptions.push(
    channel,
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand(OPEN_CHAT_COMMAND, async () => {
      await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`)
      provider.reveal()
    }),
    vscode.commands.registerCommand(OPEN_CHAT_WINDOW_COMMAND, async () => {
      await provider.openInEditor()
    }),
    vscode.commands.registerCommand(SHOW_LOGS_COMMAND, () => log.show()),
    vscode.commands.registerCommand(CANCEL_COMMAND, () => session.cancel()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('valimartHarness')) applyLimits()
    }),
  )
  bindEditorContext(context, provider)
  log.info('extension activated')
  return {
    store,
    client,
    session,
    provider,
    viewId: CHAT_VIEW_ID,
    command: OPEN_CHAT_COMMAND,
  }
}

export function deactivate() {}
