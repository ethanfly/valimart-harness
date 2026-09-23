/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi()

const loginPane = document.getElementById('loginPane')
const chatPane = document.getElementById('chatPane')
const loginForm = document.getElementById('loginForm')
const loginBtn = document.getElementById('loginBtn')
const loginError = document.getElementById('loginError')
const logoutBtn = document.getElementById('logoutBtn')
const statusLine = document.getElementById('statusLine')
const userCard = document.getElementById('userCard')
const quotaCard = document.getElementById('quotaCard')
const transcript = document.getElementById('transcript')
const thinking = document.getElementById('thinking')
const composer = document.getElementById('composer')
const promptEl = document.getElementById('prompt')
const sendBtn = document.getElementById('sendBtn')
const modelSelect = document.getElementById('modelSelect')
const effortSelect = document.getElementById('effortSelect')
const contextChip = document.getElementById('contextChip')
const gatewayUrl = document.getElementById('gatewayUrl')
const username = document.getElementById('username')
const slashPalette = document.getElementById('slashPalette')
const imageInput = document.getElementById('imageInput')
const imageChips = document.getElementById('imageChips')
const attachBtn = document.getElementById('attachBtn')
const tabChat = document.getElementById('tabChat')
const tabTasks = document.getElementById('tabTasks')
const chatWorkspace = document.getElementById('chatWorkspace')
const taskWorkspace = document.getElementById('taskWorkspace')
const newSessionBtn = document.getElementById('newSessionBtn')
const sessionSelect = document.getElementById('sessionSelect')
const renameSessionBtn = document.getElementById('renameSessionBtn')
const deleteSessionBtn = document.getElementById('deleteSessionBtn')
const detachBtn = document.getElementById('detachBtn')
const stopBtn = document.getElementById('stopBtn')
const gatewayFindBtn = document.getElementById('gatewayFindBtn')
const gatewayNote = document.getElementById('gatewayNote')
const gatewayList = document.getElementById('gatewayList')

let busy = false
let loggedIn = false
let state = {}
let pendingImages = []
let slashIndex = 0
let slashMatches = []
let readingImages = 0
let attachmentGeneration = 0
let reviewerTaskId = null
let renderedTask = null
let thinkingTimer = null
let thinkingSince = 0
let discoveredGateways = []
let discoverRequestId = 0
let discovering = false
let discoverNote = ''
let urlTouched = false
let autoDiscovered = false
let stickToBottom = true
let liveArticle = null

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

function setThinkingLabel(text) {
  document.querySelector('.thinking-label').textContent = text
}

/** 输入框随内容长高，最多 5 行，避免固定 3 行滚来滚去。 */
function growPrompt() {
  promptEl.style.height = 'auto'
  promptEl.style.height = `${Math.min(150, Math.max(56, promptEl.scrollHeight))}px`
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

function setBusy(value) {
  busy = value
  loginBtn.disabled = value
  sendBtn.disabled = value || !loggedIn || readingImages > 0
  newSessionBtn.disabled = value
  if (sessionSelect) sessionSelect.disabled = value
  if (renameSessionBtn) renameSessionBtn.disabled = value
  if (deleteSessionBtn) deleteSessionBtn.disabled = value
  logoutBtn.disabled = value
  attachBtn.disabled = value
  thinking.hidden = !value || !loggedIn || chatWorkspace.hidden
  const timeEl = document.getElementById('thinkingTime')
  if (value && !thinkingTimer) {
    thinkingSince = Date.now()
    setThinkingLabel('模型思考中')
    thinkingTimer = setInterval(() => {
      timeEl.textContent = formatElapsed(Date.now() - thinkingSince)
    }, 1000)
  } else if (!value && thinkingTimer) {
    clearInterval(thinkingTimer)
    thinkingTimer = null
    timeEl.textContent = ''
    liveArticle = null
  }
}

function nearBottom(el = transcript) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 56
}

function maybeStick() {
  if (stickToBottom) transcript.scrollTop = transcript.scrollHeight
}

transcript.addEventListener('scroll', () => {
  stickToBottom = nearBottom()
}, { passive: true })

function renderQuota(quota) {
  quotaCard.replaceChildren()
  for (const q of quota ?? []) {
    const row = document.createElement('div')
    row.className = 'quota-row'
    const rem = q.remaining != null ? q.remaining : ''
    const lim = q.limit != null ? q.limit : ''
    const label = document.createElement('span')
    label.textContent = `${q.label ?? q.provider} · 剩余 ${rem} / ${lim}（${Math.round(q.remainingPct ?? 0)}%）`
    row.append(label)
    const bar = document.createElement('div')
    bar.className = 'quota-bar'
    const i = document.createElement('progress')
    i.max = 100
    i.value = Math.max(0, Math.min(100, q.remainingPct ?? 0))
    i.setAttribute('aria-label', `${q.label ?? q.provider} 剩余额度`)
    bar.append(i)
    row.append(bar)
    quotaCard.append(row)
  }
}

function renderSelects(s) {
  const models = s.models ?? []
  modelSelect.replaceChildren()
  for (const m of models) {
    const opt = document.createElement('option')
    opt.value = m.id
    opt.textContent = m.name ? `${m.name} (${m.id})` : m.id
    if (m.id === s.model) opt.selected = true
    modelSelect.append(opt)
  }
  const efforts = s.efforts ?? []
  effortSelect.replaceChildren()
  const none = document.createElement('option')
  none.value = ''
  none.textContent = efforts.length ? '思考强度' : '无思考强度'
  effortSelect.append(none)
  for (const e of efforts) {
    const opt = document.createElement('option')
    opt.value = e
    opt.textContent = e
    if (e === s.effort) opt.selected = true
    effortSelect.append(opt)
  }
  effortSelect.disabled = efforts.length === 0
}

function renderSessions(s) {
  if (!sessionSelect) return
  const sessions = s.sessions ?? []
  sessionSelect.replaceChildren()
  for (const c of sessions) {
    const opt = document.createElement('option')
    opt.value = c.id
    opt.textContent = c.title || '新会话'
    if (c.id === s.sessionId) opt.selected = true
    sessionSelect.append(opt)
  }
  sessionSelect.hidden = sessions.length === 0
}

function renderTranscript(messages) {
  const keep = stickToBottom
  liveArticle = null
  transcript.replaceChildren()
  if (!messages?.length) {
    const el = document.createElement('div')
    el.className = 'empty'
    el.id = 'emptyHint'
    el.textContent = '向工作区提问：输入 @ 引用文件、/ 呼出命令。Agent 会经公司网关改文件。'
    transcript.append(el)
    return
  }
  for (const m of messages) appendMessage(m, { follow: false })
  if (keep) transcript.scrollTop = transcript.scrollHeight
}

/** 文件名按钮：点击在 VS Code 里开 diff（有改动）或直接打开文件。 */
function fileLink(relPath, mode, label) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'file-link'
  btn.dataset.path = relPath
  btn.textContent = label ?? relPath
  btn.title = mode === 'diff' ? '预览本轮改动（VS Code diff）' : '打开文件'
  btn.addEventListener('click', () => openChange(relPath, mode))
  return btn
}

/** 改动卡片：路径 + 新增/删除行数。 */
function fileChangeChip(f) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'file-change'
  btn.title = f.hasDiff ? '预览本轮改动（VS Code diff）' : '打开文件'
  const name = document.createElement('span')
  name.className = 'fc-name'
  name.textContent = f.path
  const stat = document.createElement('span')
  stat.className = 'fc-stat'
  if (f.created) {
    stat.textContent = '新建'
  } else if (f.tooLarge) {
    stat.textContent = '文件较大'
  } else {
    const add = document.createElement('b')
    add.className = 'fc-add'
    add.textContent = `+${f.added}`
    const del = document.createElement('b')
    del.className = 'fc-del'
    del.textContent = `−${f.removed}`
    stat.append(add, del)
  }
  btn.append(name, stat)
  btn.addEventListener('click', () => openChange(f.path, f.hasDiff ? 'diff' : 'file'))
  return btn
}

function openChange(relPath, mode) {
  if (!relPath) return
  vscode.postMessage({ type: 'openChange', path: relPath, mode, sessionId: state.sessionId ?? null })
}

function wireMarkdown(root) {
  for (const btn of root.querySelectorAll('.copy-code')) {
    if (btn.dataset.bound) continue
    btn.dataset.bound = '1'
    btn.addEventListener('click', async () => {
      const code = btn.parentElement?.querySelector('code')?.textContent ?? ''
      try {
        await navigator.clipboard.writeText(code)
        btn.textContent = '已复制'
        setTimeout(() => { btn.textContent = '复制' }, 1200)
      } catch {
        btn.textContent = '复制失败'
      }
    })
  }
  for (const btn of root.querySelectorAll('.file-ref')) {
    if (btn.dataset.bound) continue
    btn.dataset.bound = '1'
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'openChange', path: btn.dataset.path, mode: 'file', line: btn.dataset.line, sessionId: state.sessionId ?? null })
    })
  }
}

function appendProcess(el, m) {
  const tools = m.tools ?? []
  const reasoning = String(m.reasoning ?? '').trim()
  if (!tools.length && !reasoning && !m.stopReason) return
  const box = document.createElement('details')
  box.className = 'process'
  const sum = document.createElement('summary')
  const bits = []
  if (tools.length) bits.push(`工具 ${tools.map((t) => `${t.name}×${t.count}`).join(' · ')}`)
  if (reasoning) bits.push('思考过程')
  if (m.stopReason === 'cancelled') bits.push('已停止')
  else if (m.stopReason === 'max_turns' || m.stopReason === 'elapsed') bits.push('已收尾')
  sum.textContent = bits.join(' · ') || '过程'
  box.append(sum)
  if (reasoning) {
    const pre = document.createElement('pre')
    pre.className = 'reasoning'
    pre.textContent = reasoning
    box.append(pre)
  }
  if (tools.length) {
    const list = document.createElement('div')
    list.className = 'tool-list'
    for (const t of tools) {
      const row = document.createElement('div')
      row.className = 'tool-line'
      row.textContent = `${t.name} ×${t.count}`
      list.append(row)
    }
    box.append(list)
  }
  el.append(box)
}

function lastToolStack() {
  const last = transcript.lastElementChild
  return last?.classList.contains('tool-stack') ? last : null
}

function toolChip({ name, path, mode, pending } = {}) {
  const row = document.createElement('div')
  row.className = `tool-chip${pending ? ' pending' : ''}`
  const mark = document.createElement('span')
  mark.className = 'tool-mark'
  mark.setAttribute('aria-hidden', 'true')
  const label = document.createElement('span')
  label.className = 'tool-name'
  label.textContent = name || 'tool'
  row.append(mark, label)
  if (path) row.append(fileLink(path, mode ?? 'file'))
  return row
}

function appendToolChip({ name, path, mode, pending } = {}) {
  document.getElementById('emptyHint')?.remove()
  let stack = lastToolStack()
  if (!stack) {
    stack = document.createElement('div')
    stack.className = 'tool-stack'
    transcript.append(stack)
  }
  const pendingRow = [...stack.querySelectorAll('.tool-chip.pending')].find(
    (row) => row.querySelector('.tool-name')?.textContent === name,
  )
  const row = toolChip({ name, path, mode, pending })
  if (pendingRow) pendingRow.replaceWith(row)
  else stack.append(row)
  maybeStick()
  return row
}

function appendMessage(m, { follow = true } = {}) {
  document.getElementById('emptyHint')?.remove()
  if (m.role === 'tool') {
    appendToolChip({ name: m.content, path: m.path, mode: m.mode, pending: !!m.pending })
    if (follow) maybeStick()
    return
  }
  const el = document.createElement('article')
  el.className = `msg ${m.role ?? 'assistant'}${m.error ? ' err' : ''}${m.live ? ' live' : ''}`
  const who = document.createElement('span')
  who.className = 'who'
  who.textContent = m.error ? '中断' : m.role === 'user' ? 'you' : m.role === 'system' ? '系统' : 'agent'
  el.append(who)
  if (m.role === 'assistant') appendProcess(el, m)
  const body = document.createElement('div')
  body.className = 'md'
  if (m.html) body.innerHTML = m.html
  else body.textContent = m.content ?? m.message ?? ''
  el.append(body)
  wireMarkdown(body)
  if (m.path) el.append(fileLink(m.path, m.mode ?? 'file'))
  for (const img of m.images ?? []) {
    if (!img.dataUrl && !img.url) continue
    const node = document.createElement('img')
    node.src = img.dataUrl || img.url
    node.alt = img.name || 'attached image'
    el.append(node)
  }
  if (m.mentions?.length) {
    const line = document.createElement('div')
    line.className = 'msg-mentions'
    for (const p of m.mentions) {
      const tag = document.createElement('span')
      tag.className = 'mention-tag'
      tag.textContent = `@${p}`
      tag.title = '正文已随这条消息内联给 Agent'
      line.append(tag)
    }
    el.append(line)
  }
  if (m.files?.length) {
    const box = document.createElement('div')
    box.className = 'file-changes'
    for (const f of m.files) box.append(fileChangeChip(f))
    el.append(box)
  } else if (m.applied?.length) {
    const tools = document.createElement('div')
    tools.className = 'tool-stack in-msg'
    for (const a of m.applied) {
      tools.append(toolChip({
        name: a.name,
        path: a.path,
        mode: a.name === 'read_file' ? 'file' : 'diff',
      }))
    }
    el.append(tools)
  }
  transcript.append(el)
  if (follow) maybeStick()
  return el
}

function ensureLive() {
  if (liveArticle?.isConnected) return liveArticle
  liveArticle = appendMessage({ role: 'assistant', content: '', live: true, html: '' }, { follow: stickToBottom })
  return liveArticle
}

function updateLive({ text = '', reasoning = '' } = {}) {
  const el = ensureLive()
  const body = el.querySelector('.md')
  if (body) {
    body.textContent = text
  }
  let process = el.querySelector('.process')
  if (reasoning) {
    if (!process) {
      process = document.createElement('details')
      process.className = 'process'
      process.open = true
      const sum = document.createElement('summary')
      sum.textContent = '思考中'
      const pre = document.createElement('pre')
      pre.className = 'reasoning'
      process.append(sum, pre)
      el.insertBefore(process, body)
    }
    const pre = process.querySelector('.reasoning')
    if (pre) pre.textContent = reasoning
    const sum = process.querySelector('summary')
    if (sum) sum.textContent = '思考中'
  }
  maybeStick()
}

function renderState(next, nextBusy) {
  const previousSession = state.sessionId
  state = next ?? {}
  loggedIn = !!state.loggedIn
  if (typeof nextBusy === 'boolean') setBusy(nextBusy)
  loginPane.hidden = loggedIn
  chatPane.hidden = !loggedIn
  logoutBtn.hidden = !loggedIn
  if (!loggedIn || (previousSession && previousSession !== state.sessionId)) {
    attachmentGeneration++
    pendingImages = []
    promptEl.value = ''
    growPrompt()
    renderImageChips()
    hidePalette()
  }
  if (state.gatewayUrl && !urlTouched) gatewayUrl.value = state.gatewayUrl
  if (state.user?.username && !username.value) username.value = state.user.username
  if (loggedIn) {
    const u = state.user ?? {}
    const who = u.displayName || u.username || ''
    statusLine.textContent = who ? `${who} · ${state.gatewayUrl ?? ''}` : state.gatewayUrl ?? '已登录'
    userCard.textContent = [who, { admin: '管理员', director: '总监', employee: '员工' }[u.role] || u.role, u.department].filter(Boolean).join(' · ')
    const c = state.companyContext ?? {}
    document.getElementById('companySummary').textContent = `公司知识 · ${{ idle: '待加载', loading: '加载中', ready: `已载入 ${c.loaded ?? 0} 份`, partial: '部分加载', error: '加载失败' }[c.status] ?? '待加载'}`
    document.getElementById('companyStatus').textContent = c.error || `手册、团队经验、个人记忆和技能：已读取 ${c.loaded ?? 0} / ${c.files?.length ?? 0} 份。每次发送前刷新；其余资料由 Agent 按需读取。`
    document.getElementById('memoryStatus').textContent = c.memory || '尚未生成'
    document.getElementById('autoMemory').checked = state.autoMemory !== false
    const driveEl = document.getElementById('driveStatus')
    if (driveEl) {
      driveEl.textContent = state.driveDir
        ? `公司盘 ${state.driveDir}${state.lastSyncAt ? ` · 同步 ${state.lastSyncAt}` : ''}${state.driveLog ? ` · ${state.driveLog}` : ''}`
        : '公司盘未同步'
    }
    renderQuota(state.quota)
    renderSelects(state)
    renderSessions(state)
    renderTranscript(state.transcript)
    renderTaskList(state)
    renderTaskDetail(state.taskDetail)
  } else {
    statusLine.textContent = '未连接公司网关'
    userCard.replaceChildren()
    quotaCard.replaceChildren()
    renderTranscript([])
    // 与桌面客户端一致：登录页一出现就自动找一次网关（宿主侧 30 秒内复用结果）。
    if (!autoDiscovered) {
      autoDiscovered = true
      runDiscover()
    }
  }
}

function renderContext(ctx) {
  if (!ctx?.currentFile && !ctx?.selection) {
    contextChip.hidden = true
    contextChip.textContent = ''
    return
  }
  const file = ctx.currentFile ? ctx.currentFile.split(/[/\\]/).pop() : ''
  const sel = ctx.selection ? ` · ${ctx.selection.length} chars selected` : ''
  contextChip.hidden = false
  contextChip.textContent = `ctx ${file}${sel}`
}

/* ---------------- 补全面板：/ 命令 与 @ 工作区文件 ---------------- */

let paletteMode = null // 'slash' | 'mention' | null
let mentionMatches = []
let mentionQuery = ''
let mentionLoading = false
let mentionNotice = ''
let mentionTimer = null
let mentionRequestId = 0

function tokenAtCaret(value, caret) {
  let start = caret
  while (start > 0 && !/\s/.test(value[start - 1])) start -= 1
  return { start, end: caret, text: value.slice(start, caret) }
}

function hidePalette() {
  paletteMode = null
  slashMatches = []
  mentionMatches = []
  mentionLoading = false
  mentionNotice = ''
  slashIndex = 0
  slashPalette.hidden = true
  slashPalette.classList.remove('mention')
  slashPalette.replaceChildren()
}

function paletteHint(text) {
  const row = document.createElement('div')
  row.className = 'slash-hint'
  row.textContent = text
  slashPalette.append(row)
}

function renderSlash() {
  const value = promptEl.value
  if (!value.startsWith('/') || value.includes('\n')) {
    slashMatches = []
    if (paletteMode === 'slash') hidePalette()
    slashPalette.hidden = true
    return
  }
  const commands = state.slashCommands ?? []
  const body = value.slice(1)
  const space = body.search(/\s/)
  const head = (space < 0 ? body : body.slice(0, space)).toLowerCase()
  paletteMode = 'slash'
  slashPalette.hidden = false
  slashPalette.classList.remove('mention')
  slashPalette.replaceChildren()

  if (space >= 0) {
    // 已经带参数了：是命令就只显示用法，否则提示这条会作为普通消息发送。
    slashMatches = []
    const exact = commands.find((c) => c.name === head)
    paletteHint(exact ? `${exact.usage} — ${exact.description}` : '不是斜杠命令，将作为普通消息发送 · /help 查看命令')
    return
  }

  const cmds = commands.filter((c) => !head || c.name.startsWith(head) || c.name.includes(head))
  if (!cmds.length) {
    slashMatches = []
    paletteHint('不是斜杠命令，将作为普通消息发送 · /help 查看命令')
    return
  }
  slashMatches = cmds
  if (slashIndex >= cmds.length) slashIndex = 0
  cmds.forEach((c, i) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `slash-item${i === slashIndex ? ' on' : ''}`
    btn.innerHTML = `<b>/${escapeHtml(c.name)}</b><span>${escapeHtml(c.usage ?? '')} — ${escapeHtml(c.description ?? '')}</span>`
    btn.addEventListener('click', () => acceptSlash(c))
    slashPalette.append(btn)
  })
}

/** 光标停在 @xxx 上就切到文件补全；query 交给宿主在工作区里模糊匹配。 */
function renderMentions(token) {
  const query = token.text.slice(1)
  mentionQuery = query
  paletteMode = 'mention'
  slashPalette.hidden = false
  slashPalette.classList.add('mention')
  slashIndex = Math.min(slashIndex, Math.max(0, mentionMatches.length - 1))
  drawMentions()
  clearTimeout(mentionTimer)
  const requestId = ++mentionRequestId
  mentionTimer = setTimeout(() => {
    if (paletteMode !== 'mention') return
    mentionLoading = true
    drawMentions()
    vscode.postMessage({ type: 'mention-search', query, requestId })
  }, 110)
}

function drawMentions() {
  slashPalette.replaceChildren()
  if (!mentionMatches.length) {
    paletteHint(
      mentionNotice ||
        (mentionLoading
          ? `正在搜索工作区文件 · @${mentionQuery}`
          : mentionQuery
            ? `没有匹配 @${mentionQuery} 的文件 · 直接把路径写在句子里让 Agent 去找也行`
            : '继续输入文件名过滤 · Enter / Tab 插入 @路径'),
    )
    return
  }
  mentionMatches.forEach((p, i) => {
    const slash = p.lastIndexOf('/')
    const dir = slash < 0 ? '' : p.slice(0, slash + 1)
    const base = slash < 0 ? p : p.slice(slash + 1)
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `slash-item mention-item${i === slashIndex ? ' on' : ''}`
    btn.innerHTML = `<span class="m-dir">${escapeHtml(dir)}</span><b>${escapeHtml(base)}</b>`
    btn.addEventListener('click', () => acceptMention(p))
    slashPalette.append(btn)
  })
}

function acceptSlash(cmd) {
  promptEl.value = `/${cmd.name} `
  promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length)
  hidePalette()
  promptEl.focus()
}

function acceptMention(path) {
  const value = promptEl.value
  const caret = promptEl.selectionStart ?? value.length
  const token = tokenAtCaret(value, caret)
  promptEl.value = `${value.slice(0, token.start)}@${path} ${value.slice(token.end)}`
  const pos = token.start + path.length + 2
  promptEl.setSelectionRange(pos, pos)
  hidePalette()
  promptEl.focus()
}

function paletteItems() {
  return paletteMode === 'mention' ? mentionMatches : slashMatches
}

function redrawPalette() {
  if (paletteMode === 'mention') drawMentions()
  else renderSlash()
}

function movePalette(delta) {
  const items = paletteItems()
  if (!items.length) return
  slashIndex = (slashIndex + delta + items.length) % items.length
  redrawPalette()
  slashPalette.querySelector('.slash-item.on')?.scrollIntoView({ block: 'nearest' })
}

function acceptPalette() {
  const items = paletteItems()
  if (!items.length) return false
  const pick = items[Math.min(slashIndex, items.length - 1)]
  if (paletteMode === 'mention') acceptMention(pick)
  else acceptSlash(pick)
  return true
}

function refreshPalette() {
  const value = promptEl.value
  const caret = promptEl.selectionStart ?? value.length
  const token = tokenAtCaret(value, caret)
  if (!value.startsWith('/') && token.text.startsWith('@')) {
    renderMentions(token)
    return
  }
  if (paletteMode === 'mention') hidePalette()
  renderSlash()
}

function renderImageChips() {
  imageChips.replaceChildren()
  for (const img of pendingImages) {
    const node = document.createElement('img')
    node.src = img.dataUrl
    node.alt = img.name || 'image'
    const chip = document.createElement('div')
    chip.className = 'image-chip'
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = '×'
    remove.setAttribute('aria-label', `移除图片 ${img.name}`)
    remove.addEventListener('click', () => {
      pendingImages = pendingImages.filter(item => item !== img)
      renderImageChips()
    })
    chip.append(node, remove)
    imageChips.append(chip)
  }
}

/** 登录页的网关发现：本机 → 局域网（与桌面客户端同一协议，实际扫描在宿主里做）。 */
function renderGateways() {
  gatewayFindBtn.disabled = discovering
  gatewayFindBtn.textContent = discovering ? '寻找中' : '自动搜索'
  gatewayNote.textContent = discoverNote
  gatewayList.replaceChildren()
  const current = gatewayUrl.value.trim().replace(/\/+$/, '')
  for (const g of discoveredGateways) {
    const urls = (g.urls ?? []).filter(Boolean)
    const url = urls[0] ?? ''
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'finder-item'
    item.setAttribute('role', 'listitem')
    if (url && url === current) item.classList.add('on')
    const name = document.createElement('b')
    name.textContent = g.name || '公司网关'
    const meta = document.createElement('span')
    meta.textContent = [url, urls.length > 1 ? `另有 ${urls.length - 1} 个地址` : '', g.needsSetup ? '未初始化' : ''].filter(Boolean).join(' · ')
    item.append(name, meta)
    item.title = urls.join('\n')
    item.addEventListener('click', () => {
      if (!url) return
      gatewayUrl.value = url
      urlTouched = true
      loginError.textContent = ''
      renderGateways()
    })
    gatewayList.append(item)
  }
}

function runDiscover({ force = false } = {}) {
  if (discovering) return
  discovering = true
  discoverNote = '正在寻找本机网关，没有再找局域网…'
  renderGateways()
  vscode.postMessage({
    type: 'discover',
    requestId: ++discoverRequestId,
    gatewayUrl: gatewayUrl.value.trim(),
    force,
    keepUrl: urlTouched && !!gatewayUrl.value.trim(),
  })
}

function applyDiscoverResult(msg) {
  discovering = false
  if (msg.error) {
    discoveredGateways = []
    discoverNote = `寻找网关失败：${msg.error}`
    renderGateways()
    return
  }
  discoveredGateways = Array.isArray(msg.gateways) ? msg.gateways : []
  const picked = String(msg.picked ?? '')
  if (picked && !urlTouched) gatewayUrl.value = picked
  const n = discoveredGateways.length
  if (!n) discoverNote = '本机和局域网都没找到网关，请填写地址或点「自动搜索」'
  else if (n === 1) discoverNote = `已找到 ${discoveredGateways[0].name || picked || '公司网关'}`
  else discoverNote = `找到 ${n} 台网关，可在下方选择`
  renderGateways()
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault()
  loginError.textContent = ''
  vscode.postMessage({
    type: 'login',
    gatewayUrl: gatewayUrl.value.trim(),
    username: username.value.trim(),
    password: document.getElementById('password').value,
  })
})

gatewayUrl.addEventListener('input', () => {
  urlTouched = true
})
gatewayFindBtn.addEventListener('click', () => runDiscover({ force: true }))

logoutBtn.addEventListener('click', () => vscode.postMessage({ type: 'logout' }))
newSessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }))
sessionSelect?.addEventListener('change', () => {
  if (sessionSelect.value && sessionSelect.value !== state.sessionId) {
    vscode.postMessage({ type: 'switchSession', id: sessionSelect.value })
  }
})
renameSessionBtn?.addEventListener('click', () => {
  const current = (state.sessions ?? []).find((c) => c.id === state.sessionId)
  const title = window.prompt('会话标题', current?.title || '')
  if (title == null) return
  const next = title.trim()
  if (!next) return
  vscode.postMessage({ type: 'renameSession', id: state.sessionId, title: next })
})
deleteSessionBtn?.addEventListener('click', () => {
  if (!window.confirm('删除当前会话？历史会从本机清掉。')) return
  vscode.postMessage({ type: 'deleteSession', id: state.sessionId })
})
detachBtn?.addEventListener('click', () => vscode.postMessage({ type: 'openEditor' }))
stopBtn?.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }))
tabChat.addEventListener('click', () => {
  tabChat.classList.add('on')
  tabTasks.classList.remove('on')
  chatWorkspace.hidden = false
  taskWorkspace.hidden = true
})
tabTasks.addEventListener('click', () => {
  tabTasks.classList.add('on')
  tabChat.classList.remove('on')
  chatWorkspace.hidden = true
  taskWorkspace.hidden = false
  state.peopleStatus = 'loading'
  document.getElementById('taskError').hidden = true
  renderTaskDetail(state.taskDetail)
  vscode.postMessage({ type: 'taskRefresh' })
})

modelSelect.addEventListener('change', () => vscode.postMessage({ type: 'setModel', id: modelSelect.value }))
effortSelect.addEventListener('change', () => {
  if (effortSelect.value) vscode.postMessage({ type: 'setEffort', effort: effortSelect.value })
})

attachBtn.addEventListener('click', () => imageInput.click())
imageInput.addEventListener('change', async () => {
  await addImages([...(imageInput.files ?? [])])
  imageInput.value = ''
})

async function addImages(files) {
  if (busy || !loggedIn) return
  const generation = attachmentGeneration
  const error = document.getElementById('attachmentError')
  error.hidden = true
  readingImages++
  setBusy(busy)
  try {
    for (const file of files) {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('支持 PNG、JPEG、WebP 和 GIF 图片')
      if (file.size > 10 * 1024 * 1024) throw new Error('单张图片不能超过 10 MB')
      if (pendingImages.length >= 6) throw new Error('每次最多添加 6 张图片')
      const dataUrl = await readDataUrl(file)
      if (generation !== attachmentGeneration) return
      // A second paste may finish while this image is being read.
      if (pendingImages.length >= 6) throw new Error('每次最多添加 6 张图片')
      pendingImages.push({ name: file.name || `粘贴图片-${pendingImages.length + 1}`, mime: file.type, dataUrl })
    }
  } catch (e) {
    error.textContent = e.message
    error.hidden = false
  } finally {
    readingImages--
    renderImageChips()
    setBusy(busy)
  }
}

promptEl.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.items ?? [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean)
  if (!files.length) return
  event.preventDefault()
  const text = event.clipboardData.getData('text/plain')
  if (text) promptEl.setRangeText(text, promptEl.selectionStart, promptEl.selectionEnd, 'end')
  void addImages(files)
})
document.getElementById('companyRefresh').addEventListener('click', () => vscode.postMessage({ type: 'companyRefresh' }))
document.getElementById('driveSync').addEventListener('click', () => vscode.postMessage({ type: 'driveSync' }))
document.getElementById('driveOpen').addEventListener('click', () => vscode.postMessage({ type: 'openDrive' }))
document.getElementById('autoMemory').addEventListener('change', event => vscode.postMessage({ type: 'setAutoMemory', enabled: event.target.checked }))

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error(`读取 ${file.name} 失败`))
    r.readAsDataURL(file)
  })
}

composer.addEventListener('submit', (e) => {
  e.preventDefault()
  const text = promptEl.value.trim()
  if ((!text && !pendingImages.length) || busy || readingImages || !loggedIn) return
  vscode.postMessage({ type: 'send', prompt: text, images: pendingImages })
  promptEl.value = ''
  growPrompt()
  pendingImages = []
  renderImageChips()
  clearTimeout(mentionTimer)
  hidePalette()
})

promptEl.addEventListener('input', () => {
  slashIndex = 0
  refreshPalette()
  growPrompt()
})
promptEl.addEventListener('click', () => refreshPalette())

promptEl.addEventListener('keydown', (e) => {
  if (e.isComposing) return // 中文输入法组词期间不抢回车/方向键
  const paletteOpen = !slashPalette.hidden && !!paletteItems().length
  if (paletteOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault()
    movePalette(e.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (paletteOpen && (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey))) {
    e.preventDefault()
    acceptPalette()
    return
  }
  if (e.key === 'Escape') {
    clearTimeout(mentionTimer)
    hidePalette()
    return
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.shiftKey)) {
    e.preventDefault()
    const start = promptEl.selectionStart ?? promptEl.value.length
    const end = promptEl.selectionEnd ?? start
    promptEl.value = `${promptEl.value.slice(0, start)}\n${promptEl.value.slice(end)}`
    promptEl.setSelectionRange(start + 1, start + 1)
    growPrompt()
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    clearTimeout(mentionTimer)
    hidePalette()
    composer.requestSubmit()
  }
})

function renderTaskList(s) {
  const list = document.getElementById('taskList')
  list.replaceChildren()
  for (const t of s.tasks ?? []) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `task-item${s.taskDetail?.id === t.id ? ' on' : ''}`
    btn.innerHTML = `${escapeHtml(t.title)}<small>${escapeHtml(t.statusLabel ?? t.status)} · ${escapeHtml(t.id)}</small>`
    btn.addEventListener('click', () => vscode.postMessage({ type: 'taskSelect', id: t.id }))
    list.append(btn)
  }
}

function renderTaskDetail(task) {
  const meta = document.getElementById('taskMeta')
  const files = document.getElementById('taskFiles')
  document.getElementById('taskDetail').hidden = !task
  document.getElementById('taskEmpty').hidden = !!task
  if (!task) {
    renderedTask = null
    meta.textContent = '从列表选择任务卡，或新建。'
    files.replaceChildren()
    return
  }
  const who = (p) => (p ? p.displayName || p.username : '—')
  document.getElementById('taskHeading').textContent = task.title
  meta.textContent = `派单 ${who(task.assigner)} → ${who(task.assignee)} · ${task.statusLabel ?? task.status} · 项目 ${task.project || '—'} · 部门 ${task.department || '—'}`
  for (const [id, key] of [['taskContentEdit', 'content'], ['taskSubmissionEdit', 'submission']]) {
    const input = document.getElementById(id)
    if (renderedTask?.id !== task.id || input.value === (renderedTask?.[key] ?? '')) input.value = task[key] ?? ''
  }
  if (renderedTask?.id !== task.id) document.getElementById('reviewComment').value = ''
  renderedTask = { id: task.id, content: task.content, submission: task.submission }
  files.replaceChildren()
  for (const f of task.deliverables ?? []) {
    const row = document.createElement('div')
    row.textContent = f.name
    files.append(row)
  }
  const map = { draft: 'submit', pending_review: 'review', pending_final: 'final', approved: 'done', rejected: 'done' }
  for (const step of document.querySelectorAll('.quad-step')) {
    step.classList.remove('current', 'done', 'rejected')
    const key = step.getAttribute('data-step')
    if (task.status === 'approved' && key === 'done') step.classList.add('done')
    else if (task.status === 'rejected' && key === 'done') step.classList.add('rejected')
    else if (map[task.status] === key) step.classList.add('current')
    else if (['pending_review', 'pending_final', 'approved'].includes(task.status) && key === 'submit') step.classList.add('done')
    else if (['pending_final', 'approved'].includes(task.status) && key === 'review') step.classList.add('done')
  }
  const reviewerSelect = document.getElementById('reviewerSelect')
  const previous = reviewerTaskId === task.id ? reviewerSelect.value : task.reviewerId || ''
  reviewerTaskId = task.id
  reviewerSelect.replaceChildren()
  const roleLabel = { admin: '管理员', director: '总监', employee: '员工' }
  const people = (state.people ?? []).filter(p => p.id !== state.user?.id && !p.disabled)
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = state.peopleStatus === 'loading' ? '正在加载审核人…' : state.peopleStatus === 'error' ? '审核人加载失败' : people.length ? '请选择审核人' : '没有其他可选审核人'
  reviewerSelect.append(placeholder)
  for (const p of people) {
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = `${p.displayName || p.username} · ${roleLabel[p.role] ?? p.role ?? ''}${p.department ? ` · ${p.department}` : ''}`
    reviewerSelect.append(opt)
  }
  reviewerSelect.value = people.some(p => p.id === previous) ? previous : ''
  reviewerSelect.disabled = !people.length || state.peopleStatus !== 'ready'
  document.getElementById('reviewerHint').textContent = state.peopleError || (people.length ? '可以选择任意同事初审，不能选择自己。' : '没有其他可选审核人。可切换回会话后重新打开任务卡刷新名单。')
  document.getElementById('taskBindBtn').textContent = state.boundTaskId === task.id ? '已绑定当前会话' : '绑定当前会话'
  updateTaskActions()
}

function updateTaskActions() {
  const t = state.taskDetail
  if (!t) return
  const u = state.user ?? {}
  const submit = ['draft', 'rejected'].includes(t.status) && (u.role === 'admin' || t.assigneeId === u.id)
  const review = t.status === 'pending_review' && (u.role === 'admin' || t.reviewerId === u.id)
  const final = t.status === 'pending_final' && (u.role === 'admin' || (t.assignerId === u.id && u.role === 'director'))
  document.getElementById('taskSubmitBtn').hidden = !submit
  document.getElementById('reviewerSelect').closest('label').hidden = !submit
  const ready = !!document.getElementById('reviewerSelect').value && !!t.deliverables?.length
  document.getElementById('taskSubmitBtn').disabled = !ready
  document.getElementById('submitHint').textContent = submit && !ready ? '提交前请添加交付物，并选择验收审核人。' : ''
  for (const id of ['taskReviewPass', 'taskReviewReject']) document.getElementById(id).hidden = !review
  for (const id of ['taskFinalPass', 'taskFinalReject']) document.getElementById(id).hidden = !final
  document.getElementById('reviewComment').closest('label').hidden = !review && !final
}
document.getElementById('reviewerSelect').addEventListener('change', updateTaskActions)

document.getElementById('taskCreateForm').addEventListener('submit', (e) => {
  e.preventDefault()
  vscode.postMessage({
    type: 'taskCreate',
    title: document.getElementById('taskTitle').value,
    content: document.getElementById('taskContent').value,
  })
  document.getElementById('taskTitle').value = ''
  document.getElementById('taskContent').value = ''
})

document.getElementById('taskSaveBtn').addEventListener('click', () => {
  const id = state.taskDetail?.id
  if (!id) return
  vscode.postMessage({
    type: 'taskPatch',
    id,
    patch: {
      content: document.getElementById('taskContentEdit').value,
      submission: document.getElementById('taskSubmissionEdit').value,
    },
  })
})
document.getElementById('taskBindBtn').addEventListener('click', () => {
  if (state.taskDetail?.id) vscode.postMessage({ type: 'taskBind', id: state.taskDetail.id })
})
document.getElementById('taskSubmitBtn').addEventListener('click', () => {
  if (state.taskDetail?.id) {
    vscode.postMessage({
      type: 'taskSubmit',
      id: state.taskDetail.id,
      reviewerId: document.getElementById('reviewerSelect').value,
      content: document.getElementById('taskContentEdit').value,
      submission: document.getElementById('taskSubmissionEdit').value,
    })
  }
})
document.getElementById('taskReviewPass').addEventListener('click', () => {
  if (state.taskDetail?.id) vscode.postMessage({ type: 'taskReview', id: state.taskDetail.id, decision: 'pass', comment: document.getElementById('reviewComment').value })
})
document.getElementById('taskReviewReject').addEventListener('click', () => {
  if (state.taskDetail?.id) vscode.postMessage({ type: 'taskReview', id: state.taskDetail.id, decision: 'reject', comment: document.getElementById('reviewComment').value })
})
document.getElementById('taskFinalPass').addEventListener('click', () => {
  if (state.taskDetail?.id) vscode.postMessage({ type: 'taskFinal', id: state.taskDetail.id, decision: 'pass', comment: document.getElementById('reviewComment').value })
})
document.getElementById('taskFinalReject').addEventListener('click', () => {
  if (state.taskDetail?.id) vscode.postMessage({ type: 'taskFinal', id: state.taskDetail.id, decision: 'reject', comment: document.getElementById('reviewComment').value })
})
document.getElementById('deliverableInput').addEventListener('change', async () => {
  const file = document.getElementById('deliverableInput').files?.[0]
  const id = state.taskDetail?.id
  if (!file || !id) return
  const dataUrl = await readDataUrl(file)
  const dataBase64 = String(dataUrl).replace(/^data:[^,]*,/, '')
  vscode.postMessage({ type: 'taskDeliverable', id, name: file.name, dataBase64 })
  document.getElementById('deliverableInput').value = ''
})

window.addEventListener('message', (event) => {
  const msg = event.data
  if (!msg) return
  if (msg.type === 'state') {
    renderState(msg.state, msg.busy)
    return
  }
  if (msg.type === 'context') {
    renderContext(msg.context)
    return
  }
  if (msg.type === 'discover-result') {
    if (msg.requestId !== discoverRequestId) return
    applyDiscoverResult(msg)
    return
  }
  if (msg.type === 'mention-result') {
    if (msg.requestId !== mentionRequestId || paletteMode !== 'mention') return
    mentionLoading = false
    mentionNotice = msg.root ? '' : '先打开一个工作区文件夹，才能 @ 文件'
    mentionMatches = msg.root && Array.isArray(msg.paths) ? msg.paths : []
    drawMentions()
    return
  }
  if (msg.type === 'user') {
    appendMessage({ role: 'user', content: msg.content, html: msg.html, images: msg.images })
    return
  }
  if (msg.type === 'assistant') {
    appendMessage({ role: 'assistant', content: msg.content, html: msg.html, applied: msg.applied })
    return
  }
  if (msg.type === 'slash-result' || msg.type === 'goal-stopped') {
    if (msg.inTranscript) return // host 已写进 transcript，pushState 会重绘出来
    const text = msg.result?.message ?? msg.result?.stopped ?? ''
    if (!text && !msg.html) return
    appendMessage({ role: 'system', content: text, html: msg.html })
    return
  }
  if (msg.type === 'event' && msg.event?.type === 'delta') {
    updateLive({ text: msg.event.text, reasoning: msg.event.reasoning })
    return
  }
  if (msg.type === 'event' && msg.event?.type === 'tool') {
    const name = msg.event.name
    const p = msg.event.result?.path ?? msg.event.args?.path ?? ''
    const mode = name === 'write_file' || name === 'apply_patch' ? 'diff' : 'file'
    liveArticle = null
    appendToolChip({ name, path: p || null, mode })
    setThinkingLabel(`工具 ${name} 已返回 · Agent 继续中`)
    return
  }
  if (msg.type === 'openChange-result') {
    if (msg.ok === false) appendMessage({ role: 'system', content: '没有打开工作区文件夹，无法预览改动。' })
    return
  }
  if (msg.type === 'event' && msg.event?.type === 'tool-start') {
    liveArticle = null
    appendToolChip({
      name: msg.event.name,
      path: msg.event.args?.path || null,
      mode: msg.event.name === 'write_file' || msg.event.name === 'apply_patch' ? 'diff' : 'file',
      pending: true,
    })
    setThinkingLabel(`正在执行 ${msg.event.name}…`)
    return
  }
  if (msg.type === 'event' && (msg.event?.type === 'max-turns' || msg.event?.type === 'time-limit')) {
    setThinkingLabel('本轮已到达上限，正在总结进度…')
    return
  }
  if (msg.type === 'event' && msg.event?.type === 'goal-turn') {
    setThinkingLabel(`目标推进 · 第 ${Number(msg.event.round ?? 0) + 1} 轮`)
    return
  }
  if (msg.type === 'event' && msg.event?.type === 'stage') {
    setThinkingLabel(msg.event.message)
    return
  }
  if (msg.type === 'event' && msg.event?.type === 'memory') {
    setThinkingLabel(msg.event.message)
    return
  }
  if (msg.type === 'event' && msg.event?.type === 'request') {
    const ev = msg.event
    setThinkingLabel(ev.maxTurns ? `模型思考中 · 第 ${ev.turnCount}/${ev.maxTurns} 轮` : `模型思考中 · 第 ${ev.turnCount} 轮`)
    return
  }
  if (msg.type === 'error') {
    if (!taskWorkspace.hidden) {
      const error = document.getElementById('taskError')
      error.textContent = msg.message
      error.hidden = false
    }
    if (!loggedIn) {
      loginError.textContent = msg.message ?? ''
      return
    }
    // 运行中断类错误 host 已写进 transcript，随后 pushState 会重绘；这里再 append 会被覆盖掉。
    if (!msg.inTranscript) appendMessage({ role: 'system', content: msg.message, error: true })
  }
})

renderTranscript([])
vscode.postMessage({ type: 'ready' })
