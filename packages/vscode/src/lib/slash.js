/**
 * Composer slash commands (Claude Code / Codex style).
 */
export const SLASH_COMMANDS = [
  { name: 'goal', usage: '/goal [condition|clear]', description: '设置或清除持久目标；Agent 持续推进直到条件成立' },
  { name: 'model', usage: '/model [id]', description: '查看或切换公司目录模型' },
  { name: 'effort', usage: '/effort [level]', description: '查看或切换思考强度' },
  { name: 'new', usage: '/new', description: '创建新会话' },
  { name: 'rename', usage: '/rename [标题]', description: '重命名当前会话（之后不再被自动标题覆盖）' },
  { name: 'status', usage: '/status', description: '当前登录人员与剩余额度' },
  { name: 'sync', usage: '/sync', description: '同步公司盘镜像（回推个人记忆 + 拉取）' },
  { name: 'drive', usage: '/drive', description: '显示公司盘本机镜像路径' },
  { name: 'help', usage: '/help', description: '列出斜杠命令' },
]

export function isSlashCommandName(name) {
  return SLASH_COMMANDS.some((c) => c.name === String(name ?? '').toLowerCase())
}

/**
 * Syntax parse only. `known` tells the caller whether this is really one of our commands;
 * anything else that merely starts with `/` (a path like `src/lib/slash.js`, `//`, `/123`)
 * must be sent to the model as an ordinary prompt instead of erroring out.
 */
export function parseSlashInput(text) {
  const raw = String(text ?? '')
  const trimmed = raw.trim()
  if (!trimmed.startsWith('/')) return null
  const m = /^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (!m) return { invalid: true, known: false, command: null, args: '', raw }
  const command = m[1].toLowerCase()
  return { command, args: (m[2] ?? '').trim(), raw, known: isSlashCommandName(command) }
}

/** True only for `/known-command [args]`. */
export function looksLikeSlashCommand(text) {
  const parsed = parseSlashInput(text)
  return !!(parsed && parsed.known)
}

export function filterSlashCommands(prefix) {
  const p = String(prefix ?? '')
    .replace(/^\//, '')
    .toLowerCase()
    .trim()
  if (!p) return SLASH_COMMANDS.slice()
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(p) || c.name.includes(p))
}

export function dispatchSlash(app, parsed) {
  if (!parsed || parsed.invalid) {
    return { type: 'error', message: '未知命令。输入 /help 查看。', commands: SLASH_COMMANDS }
  }
  const cmd = parsed.command
  const args = parsed.args ?? ''
  switch (cmd) {
    case 'help':
      return {
        type: 'help',
        command: 'help',
        commands: SLASH_COMMANDS.map((c) => `/${c.name}`),
        items: SLASH_COMMANDS,
        message: SLASH_COMMANDS.map((c) => `${c.usage} — ${c.description}`).join('\n'),
      }
    case 'new': {
      const session = app.newSession()
      return { type: 'new', command: 'new', sessionId: session.id, message: '已创建新会话' }
    }
    case 'rename': {
      if (!args) return { type: 'error', message: '用法：/rename 新标题' }
      const chat = app.renameSession(app.currentId, args)
      return { type: 'rename', command: 'rename', sessionId: chat.id, title: chat.title, message: `已重命名为 ${chat.title}` }
    }
    case 'model': {
      if (args) {
        const sel = app.setModel(args)
        return { type: 'model', command: 'model', model: sel.modelId, effort: sel.effort, message: `模型已切换为 ${sel.modelId}` }
      }
      const state = app.publicState()
      const ids = (state.models ?? []).map((m) => m.id)
      return { type: 'model', command: 'model', model: state.model, models: ids, message: `当前模型 ${state.model}\n${ids.join('\n')}` }
    }
    case 'effort': {
      if (args) {
        const sel = app.setEffort(args)
        return { type: 'effort', command: 'effort', effort: sel.effort, model: sel.modelId, message: `思考强度 ${sel.effort ?? '（无）'}` }
      }
      const state = app.publicState()
      return {
        type: 'effort',
        command: 'effort',
        effort: state.effort,
        efforts: state.efforts ?? [],
        message: `当前思考强度 ${state.effort ?? '（未设置）'}\n可选：${(state.efforts ?? []).join(', ') || '无'}`,
      }
    }
    case 'status': {
      const state = app.publicState()
      return {
        type: 'status',
        command: 'status',
        user: state.user,
        quota: state.quota,
        model: state.model,
        effort: state.effort,
        message: formatStatus(state),
      }
    }
    case 'sync':
      return { type: 'sync', command: 'sync', startSync: true, message: '正在同步公司盘…' }
    case 'drive': {
      const st = app.publicState()
      return {
        type: 'drive',
        command: 'drive',
        driveDir: st.driveDir,
        lastSyncAt: st.lastSyncAt,
        message: `公司盘 ${st.driveDir ?? '（无）'}${st.lastSyncAt ? `\n上次同步 ${st.lastSyncAt}` : ''}${st.driveLog ? `\n${st.driveLog}` : ''}`,
      }
    }
    case 'goal': {
      if (!args || args.toLowerCase() === 'clear') {
        app.clearGoal()
        return { type: 'goal', command: 'goal', cleared: true, goal: null, message: '已清除目标' }
      }
      const goal = app.setGoal(args)
      return {
        type: 'goal',
        command: 'goal',
        cleared: false,
        startLoop: true,
        condition: goal.condition,
        goal,
        message: `目标：${goal.condition}`,
      }
    }
    default:
      return { type: 'error', message: `未知命令 /${cmd}。输入 /help 查看。`, commands: SLASH_COMMANDS }
  }
}

function formatStatus(state) {
  const u = state.user ?? {}
  const who = `${u.displayName || u.username || '—'} (${u.username ?? ''} · ${u.role ?? ''})`
  const lines = (state.quota ?? []).map((q) => {
    const rem = q.remaining != null ? q.remaining : ''
    const lim = q.limit != null ? q.limit : ''
    return `${q.label ?? q.provider}: remaining ${rem}/${lim} (${q.remainingPct ?? '—'}%) refresh ${q.refreshAt ?? '—'}`
  })
  return [`登录 ${who}`, `模型 ${state.model ?? '—'} 思考强度 ${state.effort ?? '—'}`, ...lines].join('\n')
}
