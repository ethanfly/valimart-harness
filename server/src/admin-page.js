/**
 * 服务器管理页 GET /admin：视频里「这里面配了模型和企业知识库」那一屏。
 * 单文件 HTML（无构建），用管理员/总监账号登录后调 /api/*：
 *   服务器状态 · 内核 · 公司盘 · 模型通道（加入订阅 / 加入模型）· 模型目录 · 知识库查询 · 知识 / 工具合集
 * 凭据只在浏览器与网关之间走一次，随后只保存登录会话令牌（sessionStorage）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRAND_MARK = 'valimart-mark.png'
const BRAND_WORD = 'valimart-wordmark.png'

function resolveBrandPng(name) {
  for (const p of [
    path.join(HERE, '../../plugins/desk-ui/src/client/assets', name),
    path.join(HERE, 'brand', name),
  ]) {
    if (fs.existsSync(p)) return p
  }
  return ''
}

function brandDataUri(filePath) {
  return filePath ? `data:image/png;base64,${fs.readFileSync(filePath).toString('base64')}` : ''
}

const MARK_FILE = resolveBrandPng(BRAND_MARK)
const WORD_FILE = resolveBrandPng(BRAND_WORD)
const WORD_MASK = brandDataUri(WORD_FILE) || `/admin/brand/${BRAND_WORD}`

const LOGO_HTML = `<div class="logo" role="img" aria-label="valimart harness"><span class="word"></span></div>`

function sendBrandPng(res, filePath) {
  if (!filePath) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('not found')
    return
  }
  const buf = fs.readFileSync(filePath)
  res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': buf.length })
  res.end(buf)
}

export function registerAdminPage(router, { cfg }) {
  const html = renderAdminHtml({ companyName: cfg.company?.name ?? 'Company' })
  const serve = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(html) })
    res.end(html)
  }
  router.get('/admin', serve)
  router.get('/admin/index.html', serve)
  router.get(`/admin/brand/${BRAND_MARK}`, (_req, res) => sendBrandPng(res, MARK_FILE))
  router.get(`/admin/brand/${BRAND_WORD}`, (_req, res) => sendBrandPng(res, WORD_FILE))
  router.get('/favicon.ico', (_req, res) => sendBrandPng(res, MARK_FILE))
  router.get('/', (_req, res) => {
    res.writeHead(302, { location: '/admin' })
    res.end()
  })
}

const AGENT_TOOLS = [
  ['company_knowledge', '检索：公司里有没有人做过（手册 / 共享经验 / 个人记忆 / 任务卡），只回「谁、何时、在哪」'],
  ['company_memory_read', '读岗位手册 / 共享经验 / 个人记忆'],
  ['company_memory_list', '列公司盘记忆目录'],
  ['company_memory_write', '把经验写进公司盘（personal 跟人走；shared 总监/管理员可写，员工只能追加 05-logs）'],
  ['company_task_read', '读任务卡：派单人 / 提交人 / 状态 / 交付物 / 关联进程 / 工作日志'],
  ['company_task_log', '往任务卡追加工作日志'],
  ['company_task_update', '写提交内容 / 任务内容'],
  ['company_task_attach', '把文件挂成交付物（口头完成不算完成）'],
]

export function renderAdminHtml({ companyName }) {
  const toolsJson = JSON.stringify(AGENT_TOOLS)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(companyName)} · 服务器 — valimart harness</title>
<link rel="icon" type="image/png" href="/admin/brand/valimart-mark.png" />
<link rel="apple-touch-icon" href="/admin/brand/valimart-mark.png" />
<style>
  :root { --bg:#f6f6f4; --card:#fff; --text:#1c1c1c; --muted:#6b6b6b; --line:#e6e6e2; --accent:#1c1c1c; --ok:#0a7d37; --warn:#b26a00; --bad:#b3261e; --chip:#f0efe9; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font: 14px/1.6 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  header { display:flex; align-items:center; gap:16px; padding:18px 32px; border-bottom:1px solid var(--line); background:var(--card); position:sticky; top:0; z-index:5; }
  .logo { display:flex; align-items:center; color:var(--text); }
  .logo .word { display:block; height:18px; width:calc(18px * 4.97); background:currentColor; -webkit-mask:url("${WORD_MASK}") center / contain no-repeat; mask:url("${WORD_MASK}") center / contain no-repeat; }
  .login .logo .word { height:22px; width:calc(22px * 4.97); }
  header .sp { flex:1; }
  header .who { color:var(--muted); font-size:13px; }
  main { max-width: 1080px; margin: 0 auto; padding: 24px 32px 64px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px 24px; margin-bottom:16px; }
  h2 { margin:0 0 4px; font-size:16px; }
  .desc { color:var(--muted); font-size:13px; margin:0 0 14px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:500; }
  tr:last-child td { border-bottom:none; }
  .kv { display:grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap:10px 24px; font-size:13px; }
  .kv div span { color:var(--muted); display:block; font-size:12px; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  button, .btn { height:32px; padding:0 14px; border-radius:8px; border:1px solid var(--line); background:#fff; color:var(--text); font:inherit; font-size:13px; cursor:pointer; }
  button:hover { background:#f3f3f0; }
  button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
  button.primary:hover { background:#333; }
  button.danger { color:var(--bad); }
  button:disabled { opacity:.5; cursor:default; }
  input, select, textarea { height:32px; padding:0 10px; border-radius:8px; border:1px solid var(--line); font:inherit; font-size:13px; background:#fff; min-width:0; }
  textarea { height:auto; min-height:64px; padding:8px 10px; }
  input:focus, select:focus, textarea:focus { outline:none; border-color:#999; }
  .chip { display:inline-block; padding:0 8px; border-radius:6px; background:var(--chip); font-size:12px; line-height:20px; }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); } .muted { color:var(--muted); }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size:12px; }
  .hit { padding:10px 0; border-bottom:1px solid var(--line); }
  .hit:last-child { border-bottom:none; }
  .hit .t { font-weight:600; }
  .hit .m { color:var(--muted); font-size:12px; }
  .hit .s { margin-top:4px; font-size:13px; }
  .overlay { position:fixed; inset:0; background:rgba(0,0,0,.35); display:flex; align-items:center; justify-content:center; z-index:10; }
  .dialog { background:#fff; border-radius:14px; padding:22px 24px; width: min(520px, calc(100vw - 32px)); box-shadow: 0 20px 60px rgba(0,0,0,.2); }
  .dialog h3 { margin:0 0 4px; font-size:16px; }
  .field { display:flex; flex-direction:column; gap:4px; margin-top:12px; font-size:13px; }
  .field label { color:var(--muted); font-size:12px; }
  .login { max-width:380px; margin: 60px auto; }
  .login.setup { max-width:460px; }
  .login .logo { justify-content:center; margin:0 auto 6px; }
  .steps { display:flex; gap:6px; margin: 8px 0 16px; }
  .steps i { flex:1; text-align:center; font-style:normal; font-size:11px; color:var(--muted); padding-bottom:6px; border-bottom:2px solid var(--line); }
  .steps i.on { color:var(--text); border-bottom-color:var(--text); font-weight:600; }
  .toast { position:fixed; left:50%; bottom:28px; transform:translateX(-50%); background:#1c1c1c; color:#fff; padding:8px 14px; border-radius:8px; font-size:13px; opacity:0; transition:opacity .2s; pointer-events:none; }
  .toast.show { opacity:1; }
  .grid2 { display:grid; grid-template-columns: 1fr 1fr; gap:16px; }
  @media (max-width: 760px) { .grid2 { grid-template-columns:1fr; } main { padding:16px; } header { padding:14px 16px; } }
  ul.files { margin:4px 0 0; padding-left:18px; font-size:13px; }
  ul.files li { margin:2px 0; }
  .empty { color:var(--muted); font-size:13px; }
</style>
</head>
<body>
<header>
  ${LOGO_HTML}
  <div class="muted">服务器 · ${escapeHtml(companyName)}</div>
  <div class="sp"></div>
  <div class="who" id="who"></div>
  <button id="logout" style="display:none">退出</button>
</header>
<main id="main"></main>
<div class="toast" id="toast"></div>
<script>
(() => {
  const TOOLS = ${toolsJson};
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtBytes = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');
  const fmtDur = (s) => (s < 60 ? s + ' 秒' : s < 3600 ? Math.floor(s / 60) + ' 分钟' : s < 86400 ? (s / 3600).toFixed(1) + ' 小时' : (s / 86400).toFixed(1) + ' 天');
  let token = sessionStorage.getItem('diva-admin-token') || '';
  let me = null;
  const toast = (msg, bad) => { const t = $('#toast'); t.textContent = msg; t.style.background = bad ? '#b3261e' : '#1c1c1c'; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600); };
  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { if (r.status === 401) { token = ''; sessionStorage.removeItem('diva-admin-token'); renderLogin(); } throw new Error((j.error && j.error.message) || ('HTTP ' + r.status)); }
    return j;
  }

  function renderSetup(info) {
    $('#who').textContent = '';
    $('#logout').style.display = 'none';
    const state = { step: 1, companyName: (info && info.companyName) || 'valimart harness', admin: {}, colleague: {} };
    const paint = (err) => {
      const s = state.step;
      $('#main').innerHTML = \`
        <section class="login setup">
          ${LOGO_HTML}
          <p class="desc" style="text-align:center">首次安装 · 初始设置</p>
          <div class="steps"><i class="\${s===1?'on':''}">1 公司</i><i class="\${s===2?'on':''}">2 管理员</i><i class="\${s===3?'on':''}">3 同事</i></div>
          <form id="setupForm">
            \${s===1 ? \`
              <p class="desc">给这台网关起一个公司名。之后可在设置里改。</p>
              <div class="field"><label>公司名称</label><input name="companyName" value="\${esc(state.companyName)}" required autofocus /></div>
            \` : s===2 ? \`
              <p class="desc">创建第一个管理员账号。没有演示数据，密码由你自己定。</p>
              <div class="field"><label>管理员账号</label><input name="username" value="\${esc(state.admin.username||'')}" autocomplete="username" required autofocus placeholder="字母数字 ._-，2–32 位" /></div>
              <div class="field"><label>显示名</label><input name="displayName" value="\${esc(state.admin.displayName||'')}" placeholder="例如：系统管理员" /></div>
              <div class="field"><label>部门</label><input name="department" value="\${esc(state.admin.department||'管理层')}" /></div>
              <div class="field"><label>密码</label><input name="password" type="password" autocomplete="new-password" required minlength="6" /></div>
              <div class="field"><label>确认密码</label><input name="passwordConfirm" type="password" autocomplete="new-password" required minlength="6" /></div>
            \` : \`
              <p class="desc">可选：现在发第一个同事账号，也可以跳过，之后在「人员」里添加。</p>
              <div class="field"><label>同事账号（可留空跳过）</label><input name="cUsername" value="\${esc(state.colleague.username||'')}" placeholder="留空则跳过" /></div>
              <div class="field"><label>显示名</label><input name="cDisplayName" value="\${esc(state.colleague.displayName||'')}" /></div>
              <div class="field"><label>部门</label><input name="cDepartment" value="\${esc(state.colleague.department||'')}" /></div>
              <div class="field"><label>密码</label><input name="cPassword" type="password" autocomplete="new-password" /></div>
            \`}
            <p class="desc" id="setupErr" style="color:#b3261e;margin-top:10px">\${esc(err || '')}</p>
            <div class="row" style="margin-top:8px;justify-content:space-between">
              <button type="button" id="setupBack" \${s===1?'disabled':''}>上一步</button>
              <button class="primary" type="submit">\${s===3?'完成并进入':'下一步'}</button>
            </div>
          </form>
        </section>\`;
      $('#setupBack').addEventListener('click', () => { state.step = Math.max(1, state.step - 1); paint(); });
      $('#setupForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        if (s === 1) {
          state.companyName = String(fd.get('companyName') || '').trim();
          if (!state.companyName) return paint('请填写公司名称');
          state.step = 2; return paint();
        }
        if (s === 2) {
          if (fd.get('password') !== fd.get('passwordConfirm')) return paint('两次输入的密码不一致');
          state.admin = { username: String(fd.get('username')||'').trim(), displayName: String(fd.get('displayName')||'').trim(), department: String(fd.get('department')||'').trim(), password: fd.get('password'), passwordConfirm: fd.get('passwordConfirm') };
          state.step = 3; return paint();
        }
        const cUser = String(fd.get('cUsername')||'').trim();
        const colleagues = [];
        if (cUser) {
          if (!fd.get('cPassword') || String(fd.get('cPassword')).length < 6) return paint('同事密码至少 6 位，或清空账号以跳过');
          colleagues.push({ username: cUser, displayName: String(fd.get('cDisplayName')||'').trim(), department: String(fd.get('cDepartment')||'').trim(), password: fd.get('cPassword'), role: 'employee' });
        }
        try {
          const r = await api('POST', '/api/setup', { companyName: state.companyName, admin: state.admin, colleagues, device: 'admin-page', gatewayToken: false });
          token = r.sessionToken; sessionStorage.setItem('diva-admin-token', token); me = r.user;
          toast('初始设置完成');
          await renderMain();
        } catch (err) { paint(err.message); }
      });
    };
    paint();
  }

  function renderLogin(err) {
    $('#who').textContent = '';
    $('#logout').style.display = 'none';
    $('#main').innerHTML = \`
      <section class="login">
        ${LOGO_HTML}
        <p class="desc" style="text-align:center">服务器管理页 · 管理员 / 总监登录</p>
        <form id="loginForm">
          <div class="field"><label>公司账号</label><input name="username" autocomplete="username" autofocus /></div>
          <div class="field"><label>密码</label><input name="password" type="password" autocomplete="current-password" /></div>
          <div class="field"><button class="primary" type="submit">登录</button></div>
          <p class="desc" id="loginErr" style="color:#b3261e;margin-top:10px">\${esc(err || '')}</p>
        </form>
      </section>\`;
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        // 管理页只看数据、不调模型：不签网关令牌，也就不会影响这个人桌面端上的令牌
        const r = await api('POST', '/api/auth/login', { username: fd.get('username'), password: fd.get('password'), device: 'admin-page', gatewayToken: false });
        if (r.user.role === 'employee') { throw new Error('管理页仅管理员 / 总监可用'); }
        token = r.sessionToken; sessionStorage.setItem('diva-admin-token', token); me = r.user;
        await renderMain();
      } catch (err) { $('#loginErr').textContent = err.message; }
    });
  }

  async function renderMain() {
    let status, channels, collections, kernel, plugins = { entries: [] };
    try {
      [status, channels, collections, kernel] = await Promise.all([api('GET', '/api/status'), api('GET', '/api/channels'), api('GET', '/api/knowledge/collections'), api('GET', '/api/admin/kernel')]);
      try { plugins = await api('GET', '/api/plugins'); } catch (e) { /* 旧网关 */ }
      if (!me) me = (await api('GET', '/api/auth/me')).user;
    } catch (err) { if (!token) return; return renderLogin(err.message); }
    const isAdmin = me.role === 'admin';
    $('#who').textContent = me.displayName + '（' + me.username + ' · ' + me.roleLabel + '）';
    $('#logout').style.display = '';
    const s = status.server, p = status.people, t = status.tasks;
    const statusRow = Object.entries(t.labels).map(([k, label]) => label + ' ' + (t.byStatus[k] || 0)).join(' · ');
    $('#main').innerHTML = \`
      <section>
        <h2>服务器</h2>
        <p class="desc">公司网关：账号登录 → 按人签发令牌 → /v1 模型代理（真实密钥不出服务端）→ 按人记账 / 周额度 → 任务卡与四格验收 → 公司盘。</p>
        <div class="kv">
          <div><span>公司</span>\${esc(status.company.name)} · \${esc(status.company.plan)} · \${status.company.seatsUsed}/\${status.company.seats} 席</div>
          <div><span>网关</span><span class="mono" style="display:inline;color:inherit">\${esc(s.publicUrl)}</span></div>
          <div><span>内核</span>\${esc(s.kernel)} · 服务端 v\${esc(s.version)}</div>
          <div><span>启动于</span>\${fmtTime(s.startedAt)}（已运行 \${fmtDur(s.uptimeSeconds)}）</div>
          <div><span>人员</span>在线 \${p.online} / 有效令牌 \${p.tokensActive} / 启用 \${p.active} / 共 \${p.total}</div>
          <div><span>任务卡</span>共 \${t.total} · \${statusRow}</div>
          <div><span>近 7 天</span>¥\${status.ledger7d.totalCny.toFixed(2)} · \${status.ledger7d.requests} 次请求</div>
          <div><span>默认模型</span>\${esc(status.company.defaultModel || '—')} · 快速推理 \${esc(status.company.quickInferenceModel || '—')}</div>
        </div>
      </section>

      <section id="kernel">
        <h2>内核</h2>
        <p class="desc">GitHub Release 发现 → 试打 16 处公司补丁 → 通过才入库 / 发布。员工机登录后后台下载，下次启动再切换。\${isAdmin ? '' : '（总监只读）'}</p>
        <div class="kv">
          <div><span>当前</span>\${kernel.current && kernel.current.version ? esc(kernel.current.version) + (kernel.current.sourceTag ? ' · ' + esc(kernel.current.sourceTag) : '') : '随包保底 ' + esc(kernel.pinVersion || '—')}</div>
        </div>
        \${kernel.discoverError ? '<p class="bad" style="margin:10px 0 0">' + esc(kernel.discoverError) + '</p>' : ''}
        \${isAdmin ? '<div class="row" style="margin:14px 0 10px"><button id="kRollback">回滚到上一版</button></div>' : ''}
        <p class="desc" style="margin-top:8px">已存版本</p>
        \${(kernel.stored && kernel.stored.length) ? \`<table><thead><tr><th>版本</th><th>SHA256</th><th>大小</th><th></th></tr></thead><tbody>
          \${kernel.stored.map((v) => \`<tr>
            <td class="mono">\${esc(v.version)}</td>
            <td class="mono muted">\${esc((v.sha256 || '').slice(0, 12))}</td>
            <td>\${fmtBytes(v.bytes || 0)}</td>
            <td style="text-align:right">\${isAdmin ? '<button data-kpub="' + esc(v.version) + '">发布</button>' : ''}</td>
          </tr>\`).join('')}
        </tbody></table>\` : '<div class="empty">还没有入库的内核包</div>'}
        <p class="desc" style="margin-top:14px">发现（比当前新的 GitHub Release；试打补丁需要 npm 已上架同一版本）</p>
        \${(kernel.discover && kernel.discover.length) ? \`<table><thead><tr><th>版本</th><th>tag</th><th></th></tr></thead><tbody>
          \${kernel.discover.map((d) => \`<tr>
            <td class="mono">\${esc(d.version)}\${d.onNpm === false ? '<div class="muted">未上架 npm</div>' : ''}</td>
            <td class="mono">\${esc(d.tag)}</td>
            <td style="text-align:right">\${isAdmin ? (d.onNpm === false ? '<span class="muted">未上架 npm</span>' : '<button data-kprep="' + esc(d.version) + '">试打补丁</button>') : ''}</td>
          </tr>\`).join('')}
        </tbody></table>\` : '<div class="empty">没有比当前更新的版本</div>'}
      </section>

      <section>
        <h2>公司盘</h2>
        <p class="desc">\${esc(s.driveRoot)} · 客户端登录后自动同步到本机镜像；Agent 在本机读写，服务器只保存文件。</p>
        <table>
          <thead><tr><th>区</th><th>用途</th><th>文件</th><th>大小</th></tr></thead>
          <tbody>
            <tr><td class="mono">_shared/</td><td>岗位手册 / 公司技能手册 + 共享经验（01-projects · 02-methods · 03-evidence · 04-reviews · 05-logs · 90-system）</td><td>\${status.drive.shared.files}</td><td>\${fmtBytes(status.drive.shared.bytes)}</td></tr>
            <tr><td class="mono">_office/&lt;账号&gt;/</td><td>个人记忆（一人一座，跟人走，换电脑还在）</td><td>\${status.drive.office.files}</td><td>\${fmtBytes(status.drive.office.bytes)}</td></tr>
            <tr><td class="mono">projects/inbox/&lt;任务ID&gt;/</td><td>任务交付格子（交付物 + 任务卡副本 + 工作日志）</td><td>\${status.drive.inbox.files}</td><td>\${fmtBytes(status.drive.inbox.bytes)}</td></tr>
          </tbody>
        </table>
      </section>

      <section id="channels">
        <h2>模型通道</h2>
        <p class="desc">可接入订阅（Grok / ChatGPT / Claude）或 API key（OpenAI / Anthropic / DeepSeek）；员工统一走公司网关，凭据不出服务端。\${isAdmin ? '' : '（总监只读）'}</p>
        <div class="row" style="margin-bottom:10px">
          <button id="addSub" \${isAdmin ? '' : 'disabled'}>加入订阅</button>
          <button id="addKey" \${isAdmin ? '' : 'disabled'}>加入模型</button>
          <button id="addCustom" \${isAdmin ? '' : 'disabled'}>自定义端点</button>
        </div>
        <table>
          <thead><tr><th>通道</th><th>种类</th><th>状态</th><th>模型</th><th>接入</th><th></th></tr></thead>
          <tbody>
            \${channels.channels.map((c) => \`<tr>
              <td>\${esc(c.label)}</td><td>\${esc(c.kindLabel)}</td>
              <td class="\${c.connected ? 'ok' : 'muted'}">\${esc(c.statusLabel)}\${c.accountCount > 1 ? ' · ' + c.accountCount + ' 账号' : ''}</td>
              <td class="mono">\${c.models.length ? esc(c.models.join(', ')) : '<span class="muted">' + esc(c.hint) + '</span>'}</td>
              <td class="muted">\${c.source === 'config' ? '服务端配置' : c.source === 'runtime' ? esc((c.connectedBy || '') + ' · ' + fmtTime(c.connectedAt)) : '—'}</td>
              <td style="text-align:right">\${isAdmin ? (c.connected ? (c.source === 'runtime' ? '<button data-more="' + esc(c.id) + '">再登录</button> <button class="danger" data-disc="' + esc(c.id) + '">断开</button>' : '') : '<button data-conn="' + esc(c.id) + '">接入</button>') : ''}</td>
            </tr>\`).join('')}
          </tbody>
        </table>
      </section>

      <section>
        <h2>模型目录</h2>
        <p class="desc">当前对全员分发的模型（客户端模型菜单按厂商分组显示）。</p>
        \${status.models.length ? \`<table><thead><tr><th>模型</th><th>厂商</th><th>上下文</th><th>推理档位</th><th>价格 ¥/M（输入 / 输出）</th></tr></thead><tbody>
          \${status.models.map((m) => \`<tr><td>\${esc(m.name)} <span class="mono muted">\${esc(m.id)}</span></td><td>\${esc(m.providerLabel)}</td><td>\${(m.contextWindow / 1000).toFixed(0)}K</td><td>\${m.reasoningEfforts ? esc(Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts.join(' / ') : Object.keys(m.reasoningEfforts).join(' / ')) : '—'}</td><td>\${m.priceCnyPerM.input} / \${m.priceCnyPerM.output}</td></tr>\`).join('')}
        </tbody></table>\` : '<div class="empty">还没有可用模型：接入一个通道，或在 config.json / 环境变量里配置上游密钥。</div>'}
      </section>

      <section>
        <h2>知识库查询</h2>
        <p class="desc">企业知识库的第四层通道：在公司盘（手册 / 共享经验 / 你的个人记忆 / 任务格子）和任务卡里搜「公司里有没有人做过」。只回谁、何时、在哪；不拷贝会话，细节去问那张任务卡旁边的进程。</p>
        <form id="kq" class="row"><input name="q" placeholder="例如：详情页 / 复盘 / 发货" style="flex:1;min-width:220px" /><button class="primary" type="submit">查询</button></form>
        <div id="kres" style="margin-top:10px"></div>
        \${isAdmin ? \`<form id="kadd" style="margin-top:16px">
          <p class="desc">手动增加知识（共享经验 / 手册 / 技能 / 个人记忆）</p>
          <div class="field"><label>标题</label><input name="title" /></div>
          <div class="row">
            <div class="field" style="flex:1"><label>位置</label><select name="scope"><option value="shared">共享经验</option><option value="handbook">岗位手册</option><option value="skill">技能</option><option value="personal">个人记忆</option></select></div>
            <div class="field" style="flex:1"><label>分层</label><select name="layer">\${(collections.memoryLayers || []).map((l) => '<option value="' + esc(l.dir) + '">' + esc(l.label) + '</option>').join('')}</select></div>
          </div>
          <div class="field"><label>内容</label><textarea name="content" rows="5"></textarea></div>
          <button class="primary" type="submit">写入知识库</button>
        </form>\` : ''}
      </section>

      <section class="grid2">
        <div>
          <h2>知识 / 手册合集</h2>
          <p class="desc">岗位手册 / 公司技能手册（全员只读，管理员可写）</p>
          \${collections.handbook.length ? '<ul class="files">' + collections.handbook.map((f) => '<li>' + esc(f.name) + ' <span class="muted">' + fmtBytes(f.size) + '</span></li>').join('') + '</ul>' : '<div class="empty">还没有手册</div>'}
          <p class="desc" style="margin-top:14px">公司技能 _shared/skills</p>
          \${(collections.skills && collections.skills.length) ? '<ul class="files">' + collections.skills.map((f) => '<li>' + esc(f.path) + ' <span class="muted">' + fmtBytes(f.size) + '</span></li>').join('') + '</ul>' : '<div class="empty">还没有技能</div>'}
          <p class="desc" style="margin-top:14px">共享经验 _shared/_memory</p>
          <ul class="files">
            \${Object.entries(collections.shared).map(([dir, layer]) => '<li><span class="mono">' + esc(dir) + '</span> ' + esc(layer.label) + ' <span class="muted">' + layer.files.length + ' 个文件</span></li>').join('')}
          </ul>
        </div>
        <div>
          <h2>Agent 工具合集</h2>
          <p class="desc">客户端本机 Agent 可用的公司工具（由 desk-host 插件注册）</p>
          <table><tbody>\${TOOLS.map(([n, d]) => '<tr><td class="mono" style="white-space:nowrap">' + esc(n) + '</td><td>' + esc(d) + '</td></tr>').join('')}</tbody></table>
          <p class="desc" style="margin-top:14px">DeepSeek Harness 插件列表（兼容 plugin inventory）</p>
          \${(plugins.entries && plugins.entries.length) ? '<table><thead><tr><th>id</th><th>模块</th><th>状态</th></tr></thead><tbody>' + plugins.entries.map((p) => '<tr><td class="mono">' + esc(p.entryId) + '</td><td>' + esc(p.moduleName) + '</td><td>' + (p.enabled ? '启用' : '关闭') + '</td></tr>').join('') + '</tbody></table>' : '<div class="empty">没有插件快照</div>'}
        </div>
      </section>\`;

    const kBusy = (on) => { document.querySelectorAll('#kernel button').forEach((b) => { b.disabled = on; }); };
    document.querySelectorAll('[data-kpub]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('发布 ' + b.dataset.kpub + ' 为当前内核？员工下次启动后切换。')) return;
      try { await api('POST', '/api/admin/kernel/publish', { version: b.dataset.kpub }); toast('已发布 ' + b.dataset.kpub); renderMain(); } catch (err) { toast(err.message, true); }
    }));
    document.querySelectorAll('[data-kprep]').forEach((b) => b.addEventListener('click', async () => {
      kBusy(true);
      toast('可能需要几分钟');
      try { await api('POST', '/api/admin/kernel/prepare', { version: b.dataset.kprep }); toast('试打完成：' + b.dataset.kprep); renderMain(); }
      catch (err) { toast(err.message, true); kBusy(false); }
    }));
    const kRollback = $('#kRollback');
    if (kRollback) kRollback.addEventListener('click', async () => {
      if (!confirm('回滚到上一版？')) return;
      try { const r = await api('POST', '/api/admin/kernel/rollback'); toast('已回滚到 ' + (r.version || '上一版')); renderMain(); } catch (err) { toast(err.message, true); }
    });
    $('#addSub').addEventListener('click', () => openConnect(channels.channels, 'subscription'));
    $('#addKey').addEventListener('click', () => openConnect(channels.channels, 'key'));
    const addCustom = $('#addCustom');
    if (addCustom) addCustom.addEventListener('click', () => openCustom());
    document.querySelectorAll('[data-conn]').forEach((b) => b.addEventListener('click', () => openConnect(channels.channels, null, b.dataset.conn)));
    document.querySelectorAll('[data-more]').forEach((b) => b.addEventListener('click', () => openConnect(channels.channels, null, b.dataset.more, true)));
    document.querySelectorAll('[data-disc]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('断开后该通道的模型立刻从全员目录下架，确定？')) return;
      try { await api('POST', '/api/channels/' + encodeURIComponent(b.dataset.disc) + '/disconnect'); toast('已断开'); renderMain(); } catch (err) { toast(err.message, true); }
    }));
    const kadd = $('#kadd');
    if (kadd) kadd.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('POST', '/api/knowledge/entries', { title: fd.get('title'), content: fd.get('content'), scope: fd.get('scope'), layer: fd.get('layer') });
        toast('已写入知识库'); renderMain();
      } catch (err) { toast(err.message, true); }
    });
    $('#kq').addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = new FormData(e.target).get('q');
      const box = $('#kres');
      box.innerHTML = '<div class="empty">检索中…</div>';
      try {
        const r = await api('GET', '/api/knowledge/search?q=' + encodeURIComponent(q) + '&limit=30');
        if (!r.hits.length) { box.innerHTML = '<div class="empty">没有人做过「' + esc(q) + '」（扫描 ' + r.scanned.files + ' 个文件、' + r.scanned.tasks + ' 张任务卡）</div>'; return; }
        box.innerHTML = r.hits.map((h) => \`<div class="hit">
          <div><span class="chip">\${esc(h.kindLabel)}</span> <span class="t">\${esc(h.title)}</span>\${h.statusLabel ? ' <span class="chip">' + esc(h.statusLabel) + '</span>' : ''}</div>
          <div class="m">\${esc(h.who || '—')} · \${fmtTime(h.when)} · <span class="mono">\${esc(h.path)}</span>\${h.taskId && h.kind !== 'task' ? ' · 任务卡 ' + esc(h.taskId) : ''}</div>
          <div class="s">\${esc(h.snippet)}</div>
        </div>\`).join('') + '<div class="muted" style="font-size:12px;margin-top:6px">共 ' + r.hits.length + ' 条 · 扫描 ' + r.scanned.files + ' 个文件、' + r.scanned.tasks + ' 张任务卡</div>';
      } catch (err) { box.innerHTML = '<div class="bad">' + esc(err.message) + '</div>'; }
    });
  }

  /* desk-oauth-subscribe: 只改加入订阅/接入通道弹窗，勿并入内核或 header 改动。 */
  function openCustom() {
    const wrap = document.createElement('div');
    wrap.className = 'overlay';
    wrap.innerHTML = '<div class="dialog"><h3>自定义模型端点</h3><form id="cf"><div class="field"><label>名称</label><input name="label" required /></div><div class="field"><label>Base URL</label><input name="baseUrl" value="https://" required /></div><div class="field"><label>API key</label><input name="credential" type="password" /></div><div class="field"><label>模型 id（可留空自动拉）</label><input name="models" /></div><div class="field"><label>上下文窗口</label><input name="contextWindow" /></div><div class="field"><label>思考强度</label><input name="reasoningEfforts" placeholder="low,medium,high" /></div><div class="row" style="margin-top:16px;justify-content:flex-end"><button type="button" id="cancel">取消</button><button class="primary" type="submit">保存</button></div></form></div>';
    document.body.appendChild(wrap);
    wrap.querySelector('#cancel').addEventListener('click', () => wrap.remove());
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
    wrap.querySelector('#cf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const r = await api('POST', '/api/channels', { label: fd.get('label'), baseUrl: fd.get('baseUrl'), credential: fd.get('credential'), models: fd.get('models'), contextWindow: fd.get('contextWindow') ? Number(fd.get('contextWindow')) : undefined, reasoningEfforts: fd.get('reasoningEfforts') ? String(fd.get('reasoningEfforts')).split(/[,\s]+/).filter(Boolean) : undefined });
        toast('已添加 ' + r.channel.label); wrap.remove(); renderMain();
      } catch (err) { toast(err.message, true); }
    });
  }

  function openConnect(list, kind, presetId, addAccount) {
    const candidates = list.filter((c) => (presetId ? c.id === presetId : c.kind === kind) && (presetId || addAccount || !c.connected));
    if (!candidates.length) return toast(kind === 'subscription' ? '订阅通道都已接入' : '模型通道都已接入');
    const wrap = document.createElement('div');
    wrap.className = 'overlay';
    const isSub = (presetId ? candidates[0].kind : kind) === 'subscription';
    wrap.innerHTML = \`<div class="dialog">
      <h3>\${addAccount ? '再登录一个账号' : isSub ? '加入订阅' : '加入模型'}</h3>
      <p class="desc" id="connDesc"></p>
      <form id="cf">
        <div class="field"><label>通道</label><select name="id">\${candidates.map((c) => '<option value="' + esc(c.id) + '">' + esc(c.label) + '（' + esc(c.kindLabel) + '）</option>').join('')}</select></div>
        <div id="oauthBox"></div>
        <div class="field" id="credField"><label id="credLabel">\${isSub ? '订阅凭据（访问令牌）' : 'API key'}</label><input name="credential" type="password" autocomplete="off" /></div>
        <div class="field"><label>模型 id（可留空自动拉取）</label><div class="row"><input name="models" style="flex:1" /><button type="button" id="discover">拉取列表</button></div></div>
        <div class="field"><label>Base URL（可选，留空用默认）</label><input name="baseUrl" /></div>
        <div class="field"><label>上下文窗口</label><input name="contextWindow" placeholder="自动" /></div>
        <div class="field"><label>思考强度</label><input name="reasoningEfforts" placeholder="low,medium,high" /></div>
        <div class="row" style="margin-top:16px;justify-content:flex-end"><button type="button" id="cancel">取消</button><button class="primary" type="submit" id="connSubmit">接入</button></div>
      </form>
    </div>\`;
    document.body.appendChild(wrap);
    const sel = wrap.querySelector('select[name=id]');
    const modelsIn = wrap.querySelector('input[name=models]');
    const baseIn = wrap.querySelector('input[name=baseUrl]');
    const credIn = wrap.querySelector('input[name=credential]');
    const credField = wrap.querySelector('#credField');
    const credLabel = wrap.querySelector('#credLabel');
    const oauthBox = wrap.querySelector('#oauthBox');
    const desc = wrap.querySelector('#connDesc');
    let pollTimer = null;
    const current = () => candidates.find((x) => x.id === sel.value) || candidates[0];
    const setOAuthStatus = (msg, bad) => {
      const el = wrap.querySelector('#oauthStatus');
      if (el) { el.textContent = msg; el.className = bad ? 'desc bad' : 'desc'; }
    };
    const watchStatus = (channelId, state) => {
      if (pollTimer) clearInterval(pollTimer);
      const t0 = Date.now();
      pollTimer = setInterval(async () => {
        if (Date.now() - t0 > 10 * 60 * 1000) { clearInterval(pollTimer); setOAuthStatus('授权超时，请重试', true); return; }
        try {
          const st = await api('GET', '/api/channels/' + encodeURIComponent(channelId) + '/oauth/status?state=' + encodeURIComponent(state));
          if (st.status === 'success') { clearInterval(pollTimer); toast('已接入 ' + st.channel.label + '：' + (st.channel.models || []).join(', ')); wrap.remove(); renderMain(); }
          else if (st.status === 'error') { clearInterval(pollTimer); setOAuthStatus(st.error || '授权失败', true); }
        } catch (err) { /* 进行中 */ }
      }, 1200);
    };
    const showOAuthLink = (url) => {
      const a = wrap.querySelector('#oauthOpenLink');
      const box = wrap.querySelector('#oauthOpenWrap');
      if (!a || !box) return;
      if (url) { a.href = url; box.style.display = ''; }
      else { a.removeAttribute('href'); box.style.display = 'none'; }
    };
    const openAuthorizePage = (url, popup) => {
      if (!url) return;
      try { if (popup && !popup.closed) { popup.location.replace(url); return; } } catch (e) { /* 已关 */ }
      if (window.deskShell && window.deskShell.openExternal) { window.deskShell.openExternal(url); return; }
      window.open(url, 'desk-oauth-subscribe', 'width=520,height=740');
    };
    const startOAuth = async () => {
      const c = current();
      const popup = (window.deskShell && window.deskShell.openExternal) ? null : window.open('about:blank', 'desk-oauth-subscribe', 'width=520,height=740');
      setOAuthStatus('正在发起授权…');
      showOAuthLink('');
      try {
        const r = await api('POST', '/api/channels/' + encodeURIComponent(c.id) + '/oauth/start', { models: modelsIn.value, baseUrl: baseIn.value || undefined, contextWindow: wrap.querySelector('input[name=contextWindow]').value ? Number(wrap.querySelector('input[name=contextWindow]').value) : undefined, reasoningEfforts: wrap.querySelector('input[name=reasoningEfforts]').value ? wrap.querySelector('input[name=reasoningEfforts]').value.split(/[,\\s]+/).filter(Boolean) : undefined });
        if (r.flow === 'device_code') {
          const openUrl = r.verificationUriComplete || r.verificationUri;
          openAuthorizePage(openUrl, popup);
          showOAuthLink(openUrl);
          setOAuthStatus('在打开的页面输入代码 ' + (r.userCode || '') + '，登录订阅账号。');
          const codeEl = wrap.querySelector('#oauthDeviceCode');
          if (codeEl) codeEl.textContent = r.userCode || '';
          watchStatus(c.id, r.state);
          return;
        }
        openAuthorizePage(r.authorizeUrl, popup);
        showOAuthLink(r.authorizeUrl);
        wrap.dataset.oauthState = r.state || '';
        if (r.flow === 'authorization_code_paste') {
          setOAuthStatus('浏览器登录后，把回调页上的授权码（或整段网址）贴到下面。');
          const paste = wrap.querySelector('#oauthPaste');
          if (paste) paste.style.display = '';
          return;
        }
        setOAuthStatus('已打开授权页，等待回调…');
        watchStatus(c.id, r.state);
      } catch (err) {
        try { if (popup && !popup.closed) popup.close(); } catch (e) { /* 已关 */ }
        setOAuthStatus(err.message, true);
      }
    };
    const completeOAuth = async () => {
      const c = current();
      const code = (wrap.querySelector('#oauthPasteCode') || {}).value;
      try {
        const st = await api('POST', '/api/channels/' + encodeURIComponent(c.id) + '/oauth/complete', { state: wrap.dataset.oauthState, code });
        if (st.status === 'success') { toast('已接入 ' + st.channel.label + '：' + (st.channel.models || []).join(', ')); wrap.remove(); renderMain(); }
        else setOAuthStatus(st.error || '授权失败', true);
      } catch (err) { setOAuthStatus(err.message, true); }
    };
    const paintChannel = () => {
      const c = current();
      modelsIn.value = c.hint; modelsIn.placeholder = c.hint; baseIn.placeholder = c.baseUrl;
      if (!isSub) {
        desc.textContent = '按 API key 接入一个模型厂商，员工统一走公司网关，按人记账。';
        oauthBox.innerHTML = '';
        credField.style.display = '';
        credLabel.textContent = 'API key';
        credIn.required = true;
        return;
      }
      const o = c.oauth || {};
      if (o.available && o.configured) {
        desc.textContent = '用官方 OAuth 登录订阅账号，令牌只保存在服务端；员工不接触凭据。';
        const flowHint = o.flow === 'device_code'
          ? '将打开浏览器，输入一次性代码登录订阅账号。'
          : o.flow === 'authorization_code_paste'
            ? '将打开浏览器登录；登录后把授权码贴回来。'
            : '浏览器打开授权页，完成后自动接入。';
        oauthBox.innerHTML = '<div class="field"><button type="button" class="primary" id="oauthLogin">登录账号</button><p class="desc" id="oauthStatus">' + flowHint + '</p><p class="mono" id="oauthDeviceCode" style="font-size:22px;letter-spacing:2px;margin:6px 0 0"></p><p id="oauthOpenWrap" style="display:none;margin:8px 0 0"><a id="oauthOpenLink" target="_blank" rel="noopener noreferrer">如果浏览器拦截了弹窗，点这里打开授权页</a></p><div id="oauthPaste" style="display:none;margin-top:10px"><input id="oauthPasteCode" placeholder="授权码或回调网址" /><button type="button" id="oauthComplete" style="margin-top:8px">提交授权码</button></div><details style="margin-top:10px"><summary class="muted" style="cursor:pointer;font-size:12px">高级：手动粘贴</summary></details></div>';
        credLabel.textContent = '订阅凭据（访问令牌）';
        credIn.required = false;
        credField.style.display = 'none';
        wrap.querySelector('details').addEventListener('toggle', (e) => { credField.style.display = e.target.open ? '' : 'none'; });
        wrap.querySelector('#oauthLogin').addEventListener('click', startOAuth);
        wrap.querySelector('#oauthComplete').addEventListener('click', completeOAuth);
      } else if (o.available && !o.configured) {
        desc.textContent = '该通道支持官方 OAuth，但网关还没配置应用。';
        oauthBox.innerHTML = '<p class="desc">' + esc(o.reason || '请先配置 OAuth 应用') + '</p><p class="muted" style="font-size:12px">开发者后台请登记 callback：<span class="mono">' + esc(o.callbackUrl || '') + '</span></p><details style="margin-top:10px" open><summary class="muted" style="cursor:pointer;font-size:12px">高级：手动粘贴</summary></details>';
        credLabel.textContent = '订阅凭据（访问令牌）';
        credIn.required = true;
        credField.style.display = '';
      } else {
        desc.textContent = '把订阅账号共享给全公司：该平台无官方 OAuth，仍需粘贴令牌。服务端代为请求，员工不接触凭据。';
        oauthBox.innerHTML = '<p class="desc">' + esc((o && o.reason) || '该平台无官方 OAuth，仍需粘贴令牌') + (o && o.detail ? ' ' + esc(o.detail) : '') + '</p>';
        credField.style.display = '';
        credLabel.textContent = '订阅凭据（访问令牌）';
        credIn.required = true;
      }
    };
    sel.addEventListener('change', paintChannel);
    paintChannel();
    const discoverBtn = wrap.querySelector('#discover');
    if (discoverBtn) discoverBtn.addEventListener('click', async () => {
      const c = current();
      try {
        const r = await api('POST', '/api/channels/' + encodeURIComponent(c.id) + '/discover-models', { credential: credIn.value, baseUrl: baseIn.value || undefined });
        modelsIn.value = (r.models || []).map((m) => m.id).join(', ');
        toast((r.source === 'upstream' ? '已拉取 ' : '内置目录 ') + (r.models || []).length + ' 个模型');
      } catch (err) { toast(err.message, true); }
    });
    wrap.querySelector('#cancel').addEventListener('click', () => { if (pollTimer) clearInterval(pollTimer); wrap.remove(); });
    wrap.addEventListener('click', (e) => { if (e.target === wrap) { if (pollTimer) clearInterval(pollTimer); wrap.remove(); } });
    wrap.querySelector('#cf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const r = await api('POST', '/api/channels/' + encodeURIComponent(fd.get('id')) + '/connect', { credential: fd.get('credential'), models: fd.get('models'), baseUrl: fd.get('baseUrl') || undefined, contextWindow: fd.get('contextWindow') ? Number(fd.get('contextWindow')) : undefined, reasoningEfforts: fd.get('reasoningEfforts') ? String(fd.get('reasoningEfforts')).split(/[,\\s]+/).filter(Boolean) : undefined });
        toast('已接入 ' + r.channel.label + '：' + r.channel.models.join(', '));
        if (pollTimer) clearInterval(pollTimer);
        wrap.remove(); renderMain();
      } catch (err) { toast(err.message, true); }
    });
  }

  $('#logout').addEventListener('click', async () => { try { await api('POST', '/api/auth/logout'); } catch {} token = ''; me = null; sessionStorage.removeItem('diva-admin-token'); boot(); });
  async function boot() {
    try {
      const s = await fetch('/api/setup').then((r) => r.json());
      if (s && s.needsSetup) return renderSetup(s);
    } catch {}
    if (token) renderMain(); else renderLogin();
  }
  boot();
})();
</script>
</body>
</html>`
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}
