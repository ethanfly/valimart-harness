/**
 * 服务器管理页 GET /admin：视频里「这里面配了模型和企业知识库」那一屏。
 * 单文件 HTML（无构建），用管理员/总监账号登录后调 /api/*：
 *   服务器状态 · 内核 · 公司盘 · 模型通道（加入订阅 / 加入模型）· 模型目录 · 知识库查询 · 知识 / 工具合集
 * 凭据只在浏览器与网关之间走一次，随后只保存登录会话令牌（sessionStorage）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_TOOLS } from './agent-tools.js'

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
  html, body { height:100%; }
  body { margin:0; overflow:hidden; display:flex; flex-direction:column; background:var(--bg); color:var(--text); font: 14px/1.6 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  header { display:flex; align-items:center; gap:16px; padding:14px 24px; border-bottom:1px solid var(--line); background:var(--card); flex:0 0 auto; z-index:5; }
  .app { display:flex; align-items:stretch; flex:1; min-height:0; }
  #nav { display:none; width:188px; flex:0 0 188px; padding:14px 10px; border-right:1px solid var(--line); background:var(--card); overflow-y:auto; }
  body.ready #nav { display:block; }
  #nav a { display:block; padding:8px 12px; border-radius:8px; color:inherit; text-decoration:none; font-size:13px; }
  #nav a:hover { background:#f3f3f0; }
  #nav a.on { background:#f0efe9; font-weight:600; }
  #nav .muted { padding:4px 12px 8px; font-size:11px; }
  .logo { display:flex; align-items:center; color:var(--text); }
  .logo .word { display:block; height:18px; width:calc(18px * 4.97); background:currentColor; -webkit-mask:url("${WORD_MASK}") center / contain no-repeat; mask:url("${WORD_MASK}") center / contain no-repeat; }
  .login .logo .word { height:22px; width:calc(22px * 4.97); }
  header .sp { flex:1; }
  header .who { color:var(--muted); font-size:13px; }
  main { flex:1; min-width:0; min-height:0; overflow-y:auto; padding: 24px max(28px, calc((100% - 1080px) / 2)) 64px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px 24px; margin-bottom:16px; }
  h2 { margin:0 0 4px; font-size:16px; }
  .desc { color:var(--muted); font-size:13px; margin:0 0 14px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:500; }
  #channels { overflow-x:auto; }
  #channels table { table-layout:fixed; min-width:780px; }
  #channels th:nth-child(1), #channels td:nth-child(1) { width:16%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #channels th:nth-child(2), #channels td:nth-child(2) { width:52px; white-space:nowrap; }
  #channels th:nth-child(3), #channels td:nth-child(3) { width:108px; white-space:nowrap; }
  #channels th:nth-child(5), #channels td:nth-child(5) { width:150px; }
  #channels th:nth-child(6), #channels td:nth-child(6) { width:210px; }
  #channels .ch-models { display:flex; flex-wrap:wrap; gap:4px; max-height:76px; overflow:auto; }
  #channels .ch-models .chip { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #channels .ch-who { display:flex; flex-direction:column; gap:1px; line-height:1.35; white-space:nowrap; }
  #channels .ch-actions { display:flex; flex-wrap:nowrap; justify-content:flex-end; gap:6px; }
  #channels .ch-actions button { height:28px; padding:0 10px; white-space:nowrap; }
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
  .dialog { background:#fff; border-radius:14px; padding:22px 24px; width: min(680px, calc(100vw - 32px)); max-height:calc(100dvh - 32px); overflow-y:auto; box-shadow: 0 20px 60px rgba(0,0,0,.2); }
  .model-pick { display:flex; flex-direction:column; gap:6px; max-height:280px; overflow:auto; padding:2px 0; }
  .model-tag { display:inline-flex; align-items:center; gap:2px; padding:2px 4px 2px 8px; border-radius:6px; background:var(--chip); font-size:12px; line-height:20px; }
  .model-tag.model-row { display:flex; width:100%; align-items:center; gap:8px; padding:4px 6px 4px 10px; }
  .model-tag.model-row .mono { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
  .model-tag button { height:22px; padding:0 6px; border:none; background:transparent; color:var(--muted); }
  .model-ctx { width:96px !important; height:26px !important; flex:0 0 96px; }
  .model-vision { display:inline-flex; align-items:center; gap:4px; flex:0 0 auto; color:var(--muted); font-size:12px; user-select:none; white-space:nowrap; }
  .model-vision input { width:auto !important; height:auto !important; margin:0; }
  .dialog h3 { margin:0 0 4px; font-size:16px; }
  .field { display:flex; flex-direction:column; gap:4px; margin-top:12px; font-size:13px; }
  .field label { color:var(--muted); font-size:12px; }
  form:not(.row) > button { margin-top: 16px; }
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
  .fold { border:1px solid var(--line); border-radius:8px; margin:8px 0 0; background:#fff; }
  .fold summary { padding:8px 12px; cursor:pointer; list-style:none; display:flex; justify-content:space-between; gap:12px; }
  .fold summary::-webkit-details-marker { display:none; }
  .fold-body { max-height:220px; overflow:auto; padding:0 12px 10px; border-top:1px solid var(--line); }
  .impexp { margin:0 0 14px; }
  table select { height:28px; max-width:148px; }
  .fold-body table { font-size:12px; }
  @media (max-width: 760px) {
    html, body { height:auto; }
    body { overflow:auto; display:block; }
    header { position:sticky; top:0; }
    .app { flex-direction:column; height:auto; min-height:0; }
    body.ready #nav { display:flex; width:100%; flex:none; min-height:0; overflow:visible; border-right:none; border-bottom:1px solid var(--line); flex-wrap:wrap; gap:4px; position:sticky; top:53px; z-index:4; }
    #nav a { padding:6px 10px; }
    main { overflow:visible; min-height:0; padding:16px; }
  }
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
<div class="app">
  <nav id="nav"></nav>
  <main id="main"></main>
</div>
<div class="toast" id="toast"></div>
<script>
(() => {
  const TOOLS = ${toolsJson};
  const PAGES = [{ id:'overview', label:'概览' }, { id:'updates', label:'更新' }, { id:'models', label:'模型' }, { id:'knowledge', label:'知识' }, { id:'org', label:'组织' }, { id:'tools', label:'工具' }];
  const pageOf = () => { const id = (location.hash || '#overview').replace(/^#/, ''); return PAGES.some((p) => p.id === id) ? id : 'overview'; };
  const applyPage = () => {
    const page = pageOf();
    document.querySelectorAll('#nav a[data-page]').forEach((a) => a.classList.toggle('on', a.getAttribute('data-page') === page));
    document.querySelectorAll('#main > [data-page]').forEach((el) => { el.style.display = el.getAttribute('data-page') === page ? '' : 'none'; });
  };
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const parseModelIds = (raw) => String(raw || '').split(/[,\\n，]/).map((s) => s.trim()).filter(Boolean);
  const ctxOf = (m) => (m && m.contextWindow != null && m.contextWindow !== '' ? String(m.contextWindow) : '');
  const inferVision = (id) => {
    const s = String(id || '');
    if (!s || /imagine-image|imagine-video|dall-e|gpt-image|flux|qwen-image|image-generation|video-generation|text-to-video/i.test(s) || /^mock[-_]?/i.test(s)) return false;
    return true;
  };
  const visionOf = (m) => {
    if (m == null) return false;
    if (typeof m === 'string') return inferVision(m);
    if (m.vision === true || m.vision === false) return m.vision;
    if (Array.isArray(m.input)) return m.input.indexOf('image') >= 0;
    return inferVision(m.id);
  };
  const catalogToEntries = (models, prev) => {
    const map = new Map((prev || []).map((m) => [m.id, m]));
    return (models || []).map((m) => {
      const id = typeof m === 'string' ? m : (m && m.id);
      if (!id) return null;
      const listed = typeof m === 'string' ? { id: m } : m;
      const kept = map.get(id);
      return { id: id, contextWindow: (kept ? ctxOf(kept) : '') || ctxOf(listed), vision: visionOf(kept || listed) };
    }).filter(Boolean);
  };
  const parseModelEntries = (raw, prev) => catalogToEntries(parseModelIds(raw), prev);
  const modelsPayload = (entries) => (entries || []).map((m) => {
    const row = { id: m.id, vision: m.vision === true };
    const n = Number(m.contextWindow);
    if (Number.isFinite(n) && n > 0) row.contextWindow = n;
    return row;
  });
  const renderModelRows = (box, entries, onChange) => {
    box.innerHTML = entries.map((m, i) =>
      '<span class="model-tag model-row">' +
        '<span class="mono">' + esc(m.id) + '</span>' +
        '<input class="model-ctx" data-ctx-i="' + i + '" value="' + esc(m.contextWindow || '') + '" placeholder="上下文" title="该模型的上下文长度" />' +
        '<label class="model-vision" title="该模型是否支持图片识别"><input type="checkbox" data-vision-i="' + i + '"' + (m.vision ? ' checked' : '') + ' />识图</label>' +
        '<button type="button" data-drop="' + esc(m.id) + '" title="去掉">×</button>' +
      '</span>'
    ).join('') || '<span class="muted">至少留一个模型</span>';
    box.querySelectorAll('[data-drop]').forEach((btn) => btn.addEventListener('click', () => {
      onChange(entries.filter((x) => x.id !== btn.dataset.drop));
    }));
    box.querySelectorAll('[data-ctx-i]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const i = Number(inp.dataset.ctxI);
        if (entries[i]) entries[i].contextWindow = inp.value;
      });
    });
    box.querySelectorAll('[data-vision-i]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const i = Number(inp.dataset.visionI);
        if (entries[i]) entries[i].vision = inp.checked;
      });
    });
  };
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
    document.body.classList.remove('ready');
    $('#nav').innerHTML = '';
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
    document.body.classList.remove('ready');
    $('#nav').innerHTML = '';
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
    let status, channels, collections, kernel, client, search = { anysearch: { configured: false, source: null, sourceLabel: null } }, plugins = { entries: [] }, personnel = { departments: [], positions: [], departmentCatalog: [] };
    try {
      [status, channels, collections, kernel, client, search] = await Promise.all([api('GET', '/api/status'), api('GET', '/api/channels'), api('GET', '/api/knowledge/collections'), api('GET', '/api/admin/kernel'), api('GET', '/api/admin/client'), api('GET', '/api/admin/search')]);
      try { plugins = await api('GET', '/api/plugins'); } catch (e) { /* 旧网关 */ }
      try { personnel = await api('GET', '/api/personnel'); } catch (e) { /* 总监/管理员才有 */ }
      if (!me) me = (await api('GET', '/api/auth/me')).user;
    } catch (err) { if (!token) return; return renderLogin(err.message); }
    const isAdmin = me.role === 'admin';
    const page = pageOf();
    document.body.classList.add('ready');
    $('#nav').innerHTML = PAGES.map((x) => '<a href="#' + x.id + '" data-page="' + x.id + '" class="' + (x.id === page ? 'on' : '') + '">' + x.label + '</a>').join('');
    $('#who').textContent = me.displayName + '（' + me.username + ' · ' + me.roleLabel + '）';
    $('#logout').style.display = '';
    const s = status.server, p = status.people, t = status.tasks;
    const statusRow = Object.entries(t.labels).map(([k, label]) => label + ' ' + (t.byStatus[k] || 0)).join(' · ');
    const skillGroups = (() => {
      const map = new Map();
      for (const f of (collections.skills || [])) {
        const parts = String(f.path || '').replace(/^_shared\\/skills\\/?/, '').split('/').filter(Boolean);
        const key = parts.length > 1 ? parts[0] : '（根目录）';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(f);
      }
      return [...map.entries()].map(([name, files]) => ({ name, files }));
    })();
    const foldFiles = (title, files) => {
      const list = files || [];
      const body = list.length ? '<ul class="files">' + list.map((f) => '<li>' + esc(f.name || f.path) + ' <span class="muted">' + fmtBytes(f.size) + '</span></li>').join('') + '</ul>' : '<div class="empty">没有文件</div>';
      return '<details class="fold"><summary><span>' + title + '</span><span class="muted">' + list.length + '</span></summary><div class="fold-body">' + body + '</div></details>';
    };
    const posOpts = (selected) => '<option value="">未派岗位</option>' + (personnel.positions || []).map((p) => '<option value="' + esc(p.id) + '"' + (p.id === selected ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('');
    const impexpBtn = (kinds, label) => '<button type="button" data-export="' + kinds + '">导出' + label + '</button><label class="btn" style="display:inline-flex;align-items:center">导入' + label + '<input type="file" accept="application/json" hidden data-import="' + kinds + '" /></label>';
    const impexp = (kinds, label) => isAdmin ? '<div class="row impexp">' + impexpBtn(kinds, label) + '</div>' : '';
    const impexpMany = (items) => isAdmin ? '<div class="row impexp">' + items.map((x) => impexpBtn(x[0], x[1])).join('') + '</div>' : '';
    $('#main').innerHTML = \`
      <div data-page="overview">
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
      </div>

      <div data-page="updates">
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

      <section id="client">
        <h2>客户端</h2>
        <p class="desc">上传 npm run dist:client 打出的 Setup.exe，发布后员工机登录会后台下载，下次启动静默覆盖安装。安装包文件名带构建时间；buildId 从安装包自动读取，不必手填。\${isAdmin ? '' : '（总监只读）'}</p>
        <div class="kv">
          <div><span>当前</span>\${client && client.current && client.current.buildId ? esc(client.current.buildId) : '尚未发布'}</div>
        </div>
        \${isAdmin ? '<div class="row" style="margin:14px 0 10px"><button id="cRollback">回滚到上一版</button></div>' : ''}
        \${isAdmin ? \`<form id="cUpload" class="row" style="margin:0 0 12px;align-items:flex-end;flex-wrap:wrap">
          <div class="field"><label>安装包</label><input type="file" name="exe" accept=".exe" required /></div>
          <div id="cMeta" class="muted">buildId 将从安装包自动读取</div>
          <button class="primary" type="submit">上传并发布</button>
        </form>\` : ''}
        <p class="desc" style="margin-top:8px">已存版本</p>
        \${(client && client.stored && client.stored.length) ? \`<table><thead><tr><th>buildId</th><th>SHA256</th><th>大小</th><th></th></tr></thead><tbody>
          \${client.stored.map((v) => \`<tr>
            <td class="mono">\${esc(v.buildId)}</td>
            <td class="mono muted">\${esc((v.sha256 || '').slice(0, 12))}</td>
            <td>\${fmtBytes(v.bytes || 0)}</td>
            <td style="text-align:right">\${isAdmin ? '<button data-cpub="' + esc(v.buildId) + '">发布</button> <button data-cdel="' + esc(v.buildId) + '">删除</button>' : ''}</td>
          </tr>\`).join('')}
        </tbody></table>\` : '<div class="empty">还没有入库的客户端安装包</div>'}
      </section>
      </div>

      <div data-page="overview">
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
      </div>

      <div data-page="models">
      <section id="channels">
        <h2>模型通道</h2>
        <p class="desc">可接入订阅（Grok / ChatGPT / Claude / Google One · Gemini）或 API key（OpenAI / Anthropic / DeepSeek）；员工统一走公司网关，凭据不出服务端。\${isAdmin ? '' : '（总监只读）'}</p>
        <div class="row" style="margin-bottom:10px">
          <button id="addSub" \${isAdmin ? '' : 'disabled'}>加入订阅</button>
          <button id="addKey" \${isAdmin ? '' : 'disabled'}>加入模型</button>
          <button id="addCustom" \${isAdmin ? '' : 'disabled'}>自定义端点</button>
        </div>
        <table>
          <thead><tr><th>通道</th><th>种类</th><th>状态</th><th>模型</th><th>接入</th><th>操作</th></tr></thead>
          <tbody>
            \${channels.channels.map((c) => \`<tr>
              <td title="\${esc(c.label)}">\${esc(c.label)}</td>
              <td>\${esc(c.kindLabel)}</td>
              <td class="\${c.connected ? 'ok' : 'muted'}">\${esc(c.connected ? '已接' : '未接')}\${c.accountCount > 1 ? '<div class="muted" style="font-size:12px">' + c.accountCount + ' 个账号</div>' : ''}</td>
              <td>\${c.models.length ? '<div class="ch-models" title="' + esc(c.models.join(', ')) + '">' + c.models.map((id) => '<span class="chip mono">' + esc(id) + '</span>').join('') + '</div>' : '<span class="muted">' + esc(c.hint) + '</span>'}</td>
              <td class="muted">\${c.source === 'config' ? '服务端配置' : c.source === 'runtime' ? '<div class="ch-who"><span>' + esc(c.connectedBy || '') + '</span><span>' + esc(fmtTime(c.connectedAt)) + '</span></div>' : '—'}</td>
              <td>\${isAdmin ? (c.connected ? (c.source === 'runtime' ? '<div class="ch-actions"><button data-edit="' + esc(c.id) + '">编辑</button><button data-more="' + esc(c.id) + '">再登录</button>' + (c.custom ? '<button class="danger" data-cdelch="' + esc(c.id) + '">删除</button>' : '<button class="danger" data-disc="' + esc(c.id) + '">断开</button>') + '</div>' : '') : '<div class="ch-actions"><button data-conn="' + esc(c.id) + '">接入</button>' + (c.custom ? '<button class="danger" data-cdelch="' + esc(c.id) + '">删除</button>' : '') + '</div>') : ''}</td>
            </tr>\`).join('')}
          </tbody>
        </table>
      </section>

      <section id="searchkey">
        <h2>搜索密钥</h2>
        <p class="desc">AnySearch 的 key 只存服务端，员工登录后自动下发到本机 DSH 凭据（插件逐次解析，换 key 下一次搜索即生效）。不配则员工走 AnySearch 匿名额度。\${isAdmin ? '' : '（总监只读）'}</p>
        <div class="kv">
          <div><span>状态</span>\${search.anysearch.configured ? '<span class="ok">已配置</span>' : '<span class="muted">未配置（匿名额度）</span>'}\${search.anysearch.sourceLabel ? ' · 来源：' + esc(search.anysearch.sourceLabel) : ''}</div>
        </div>
        \${isAdmin ? \`<form id="searchKeyForm" class="row" style="margin-top:12px">
          <input name="apiKey" type="password" placeholder="as_sk_…（留空保存 = 清除）" autocomplete="off" spellcheck="false" style="flex:1;min-width:260px" />
          <button class="primary" type="submit">保存</button>
          <button type="button" id="searchKeyClear">清除</button>
        </form>\` : ''}
      </section>

      <section>
        <h2>模型目录</h2>
        <p class="desc">当前对全员分发的模型（客户端模型菜单按厂商分组显示）。</p>
        \${status.models.length ? \`<table><thead><tr><th>模型</th><th>厂商</th><th>上下文</th><th>识图</th><th>推理档位</th><th>价格 ¥/M（输入 / 输出）</th></tr></thead><tbody>
          \${status.models.map((m) => \`<tr><td>\${esc(m.name)} <span class="mono muted">\${esc(m.id)}</span></td><td>\${esc(m.providerLabel)}</td><td>\${(m.contextWindow / 1000).toFixed(0)}K</td><td>\${m.vision ? '支持' : '—'}</td><td>\${m.reasoningEfforts ? esc(Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts.join(' / ') : Object.keys(m.reasoningEfforts).join(' / ')) : '—'}</td><td>\${m.priceCnyPerM.input} / \${m.priceCnyPerM.output}</td></tr>\`).join('')}
        </tbody></table>\` : '<div class="empty">还没有可用模型：接入一个通道，或在 config.json / 环境变量里配置上游密钥。</div>'}
      </section>
      </div>

      <div data-page="knowledge">
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
      <section>
        <h2>知识 / 手册合集</h2>
        <p class="desc">按组合折叠，不再整页铺开。\${isAdmin ? '' : '（总监只读）'}</p>
        \${impexpMany([['knowledge', '知识库'], ['skills', '技能']])}
        \${foldFiles('岗位手册', collections.handbook)}
        \${skillGroups.length ? skillGroups.map((g) => foldFiles('技能 · ' + esc(g.name), g.files)).join('') : '<div class="empty">还没有技能</div>'}
        \${Object.entries(collections.shared).map(([dir, layer]) => foldFiles(esc(layer.label) + ' · ' + esc(dir), layer.files)).join('')}
      </section>
      </div>

      <div data-page="org">
      <section>
        <h2>组织</h2>
        <p class="desc">人员按部门折叠；岗位可配周额度（金额或 token 总量）。额度优先级：个人覆盖 → 岗位 → 角色 → 公司默认。\${isAdmin ? '' : '（总监只读）'}</p>
        \${impexpMany([['personnel', '人员'], ['positions', '岗位'], ['departments', '部门']])}
        <h3 style="margin:16px 0 8px;font-size:14px">岗位</h3>
        \${isAdmin ? \`<form id="posAdd" class="row" style="align-items:flex-end;margin-bottom:12px">
          <div class="field"><label>岗位名</label><input name="name" required /></div>
          <div class="field"><label>额度类型</label><select name="quotaKind"><option value="cny">金额 ¥</option><option value="tokens">token 总量</option></select></div>
          <div class="field"><label>额度</label><input name="quota" type="number" min="0" step="1" required /></div>
          <button class="primary" type="submit">新增岗位</button>
        </form>\` : ''}
        \${(personnel.positions && personnel.positions.length) ? \`<table><thead><tr><th>岗位</th><th>额度</th><th></th></tr></thead><tbody>
          \${personnel.positions.map((pos) => \`<tr data-posrow="\${esc(pos.id)}">
            <td>\${esc(pos.name)}</td>
            <td>\${isAdmin ? '<div class="row"><select data-poskind><option value="cny"' + (pos.quotaKind === 'tokens' ? '' : ' selected') + '>金额 ¥</option><option value="tokens"' + (pos.quotaKind === 'tokens' ? ' selected' : '') + '>token 总量</option></select><input data-posquota type="number" min="0" step="1" value="' + esc(pos.quotaKind === 'tokens' ? (pos.weeklyQuotaTokens ?? '') : (pos.weeklyQuotaCny ?? '')) + '" style="width:110px" /><button type="button" data-possave>保存</button></div>' : '<span class="mono">' + (pos.quotaKind === 'tokens' ? (pos.weeklyQuotaTokens + ' tokens') : ('¥' + (pos.weeklyQuotaCny ?? '—'))) + '</span>'}
            <td style="text-align:right">\${isAdmin ? '<button class="danger" data-posdel="' + esc(pos.id) + '">删除</button>' : ''}</td>
          </tr>\`).join('')}
        </tbody></table>\` : '<div class="empty">还没有岗位</div>'}
        <h3 style="margin:18px 0 8px;font-size:14px">部门</h3>
        \${isAdmin ? \`<form id="depAdd" class="row" style="align-items:flex-end;margin-bottom:12px">
          <div class="field"><label>部门名</label><input name="name" required /></div>
          <button class="primary" type="submit">新增部门</button>
        </form>\` : ''}
        \${(personnel.departmentCatalog && personnel.departmentCatalog.length) ? \`<table><thead><tr><th>部门</th><th></th></tr></thead><tbody>
          \${personnel.departmentCatalog.map((d) => \`<tr>
            <td>\${esc(d.name)}</td>
            <td style="text-align:right">\${isAdmin ? '<button class="danger" data-depdel="' + esc(d.name) + '">删除</button>' : ''}</td>
          </tr>\`).join('')}
        </tbody></table>\` : '<div class="empty">尚未配置部门</div>'}
        <h3 style="margin:18px 0 8px;font-size:14px">人员</h3>
        \${isAdmin ? \`<form id="userAdd" class="row" style="align-items:flex-end;margin-bottom:12px">
          <div class="field"><label>账号</label><input name="username" required placeholder="字母数字 ._- " /></div>
          <div class="field"><label>密码</label><input name="password" type="password" minlength="6" required /></div>
          <div class="field"><label>姓名</label><input name="displayName" /></div>
          <div class="field"><label>部门</label><input name="department" /></div>
          <div class="field"><label>角色</label><select name="role">\${(personnel.roles || [{ id:'employee', label:'员工' }]).map((r) => '<option value="' + esc(r.id) + '">' + esc(r.label) + '</option>').join('')}</select></div>
          <div class="field"><label>岗位</label><select name="positionId">\${posOpts('')}</select></div>
          <button class="primary" type="submit">发账号</button>
        </form>\` : ''}
        \${(personnel.departments || []).map((dep) => \`<details class="fold"><summary><span>\${esc(dep.name)}</span><span class="muted">\${dep.users.length} 人</span></summary><div class="fold-body"><table><thead><tr><th>账号</th><th>角色</th><th>岗位</th><th>额度</th></tr></thead><tbody>
          \${dep.users.map((u) => \`<tr>
            <td>\${esc(u.displayName)} <span class="mono muted">\${esc(u.username)}</span></td>
            <td>\${esc(u.roleLabel)}</td>
            <td>\${isAdmin ? '<select data-posset="' + esc(u.id) + '">' + posOpts(u.positionId) + '</select>' : esc((personnel.positions || []).find((x) => x.id === u.positionId)?.name || '—')}</td>
            <td class="mono">\${u.quota && u.quota.kind === 'tokens' ? (u.quota.limit + ' tokens') : ('¥' + (u.quota ? u.quota.limit : '—'))}<div class="muted">\${esc((u.quota && u.quota.source) || '')}</div></td>
          </tr>\`).join('')}
        </tbody></table></div></details>\`).join('') || '<div class="empty">没有人员</div>'}
      </section>
      </div>

      <div data-page="tools">
      <section>
        <h2>Agent 工具合集</h2>
        <p class="desc">公司工具与内核插件。长列表折叠，不占满一屏。</p>
        \${impexp('tools', '工具目录')}
        <details class="fold" open><summary><span>公司工具</span><span class="muted">\${TOOLS.length}</span></summary><div class="fold-body"><table><tbody>\${TOOLS.map(([n, d]) => '<tr><td class="mono" style="white-space:nowrap">' + esc(n) + '</td><td>' + esc(d) + '</td></tr>').join('')}</tbody></table></div></details>
        <details class="fold"><summary><span>DeepSeek Harness 插件</span><span class="muted">\${(plugins.entries || []).length}</span></summary><div class="fold-body">
          \${(plugins.entries && plugins.entries.length) ? '<table><thead><tr><th>id</th><th>模块</th><th>状态</th></tr></thead><tbody>' + plugins.entries.map((p) => '<tr><td class="mono">' + esc(p.entryId) + '</td><td>' + esc(p.moduleName) + '</td><td>' + (p.enabled ? '启用' : '关闭') + '</td></tr>').join('') + '</tbody></table>' : '<div class="empty">没有插件快照</div>'}
        </div></details>
      </section>
      </div>\`;
    applyPage();

    const kBusy = (on) => { document.querySelectorAll('#kernel button').forEach((b) => { b.disabled = on; }); };
    const searchKeyForm = $('#searchKeyForm');
    if (searchKeyForm) searchKeyForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = String(new FormData(searchKeyForm).get('apiKey') || '');
      try {
        const r = await api('PUT', '/api/admin/search/anysearch', { apiKey: value });
        toast(r.anysearch.configured ? '已保存搜索密钥，员工下次打开客户端生效' : '已清除搜索密钥（回到匿名额度）');
        renderMain();
      } catch (err) { toast(err.message, true); }
    });
    const searchKeyClear = $('#searchKeyClear');
    if (searchKeyClear) searchKeyClear.addEventListener('click', async () => {
      if (!confirm('清除搜索密钥？员工将回到 AnySearch 匿名额度。')) return;
      try { await api('PUT', '/api/admin/search/anysearch', { apiKey: '' }); toast('已清除'); renderMain(); } catch (err) { toast(err.message, true); }
    });
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
    document.querySelectorAll('[data-cpub]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('发布 ' + b.dataset.cpub + ' 为当前客户端？员工下次启动后覆盖安装。')) return;
      try { await api('POST', '/api/admin/client/publish', { buildId: b.dataset.cpub }); toast('已发布 ' + b.dataset.cpub); renderMain(); } catch (err) { toast(err.message, true); }
    }));
    document.querySelectorAll('[data-cdel]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.cdel;
      const current = client && client.current && client.current.buildId === id;
      if (!confirm(current ? ('删除当前发布 ' + id + '？会回退到上一版，没有上一版则员工将没有可下载的安装包。') : ('删除安装包 ' + id + '？'))) return;
      try { await api('DELETE', '/api/admin/client/' + encodeURIComponent(id)); toast('已删除 ' + id); renderMain(); } catch (err) { toast(err.message, true); }
    }));
    const cRollback = $('#cRollback');
    if (cRollback) cRollback.addEventListener('click', async () => {
      if (!confirm('回滚客户端到上一版？')) return;
      try { const r = await api('POST', '/api/admin/client/rollback'); toast('已回滚到 ' + (r.buildId || '上一版')); renderMain(); } catch (err) { toast(err.message, true); }
    });
    const readInstallerMeta = (file) => file.slice(0, 8 * 1024 * 1024).arrayBuffer().then((ab) => {
      const u16 = new TextDecoder('utf-16le').decode(ab);
      const latin = new TextDecoder('latin1').decode(ab);
      const text = u16 + '\\n' + latin;
      const mark = /VMBUILD ([^\\s\\0]+)/.exec(text);
      const plus = /(\\d+\\.\\d+\\.\\d+\\+[A-Za-z0-9._+-]+)/.exec(text);
      const inst = /(\\d+\\.\\d+\\.\\d+-\\d{8}\\.\\d{4})/.exec(text);
      return { buildId: (mark && mark[1]) || (plus && plus[1]) || '', installerVersion: (inst && inst[1]) || '' };
    });
    const cUpload = $('#cUpload');
    const cMeta = $('#cMeta');
    const cExe = cUpload && cUpload.querySelector('input[name=exe]');
    if (cExe) cExe.addEventListener('change', async () => {
      const file = cExe.files && cExe.files[0];
      if (!file || !cMeta) return;
      try {
        const meta = await readInstallerMeta(file);
        cMeta.textContent = meta.buildId ? ('将发布 ' + meta.buildId) : (meta.installerVersion ? ('将发布 ' + meta.installerVersion) : '安装包里读不到 buildId，请用新打的包');
      } catch { cMeta.textContent = 'buildId 将从安装包自动读取'; }
    });
    if (cUpload) cUpload.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(cUpload);
      const file = fd.get('exe');
      if (!file || !file.size) return toast('请选择 Setup.exe', true);
      toast('正在读取安装包…');
      const meta = await readInstallerMeta(file).catch(() => ({ buildId: '', installerVersion: '' }));
      const buildId = meta.buildId || meta.installerVersion;
      toast('正在上传 ' + (file.size / 1048576).toFixed(1) + ' MB…');
      try {
        const headers = {
          authorization: 'Bearer ' + token,
          'content-type': 'application/octet-stream',
          'x-client-version': '0.1.0',
          'x-client-filename': file.name,
        };
        if (buildId) headers['x-client-build-id'] = buildId;
        const r = await fetch('/api/admin/client/publish', { method: 'POST', headers, body: file });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
        toast('已发布 ' + (j.buildId || buildId));
        renderMain();
      } catch (err) { toast(err.message, true); }
    });
    const addSub = $('#addSub');
    if (addSub) addSub.addEventListener('click', () => openConnect(channels.channels, 'subscription'));
    const addKey = $('#addKey');
    if (addKey) addKey.addEventListener('click', () => openConnect(channels.channels, 'key'));
    const addCustom = $('#addCustom');
    if (addCustom) addCustom.addEventListener('click', () => openCustom());
    document.querySelectorAll('[data-conn]').forEach((b) => b.addEventListener('click', () => openConnect(channels.channels, null, b.dataset.conn)));
    document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const c = channels.channels.find((x) => x.id === b.dataset.edit);
      if (c) openEdit(c);
    }));
    document.querySelectorAll('[data-more]').forEach((b) => b.addEventListener('click', () => openConnect(channels.channels, null, b.dataset.more, true)));
    document.querySelectorAll('[data-disc]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('断开后该通道的模型立刻从全员目录下架，确定？')) return;
      try { await api('POST', '/api/channels/' + encodeURIComponent(b.dataset.disc) + '/disconnect'); toast('已断开'); renderMain(); } catch (err) { toast(err.message, true); }
    }));
    document.querySelectorAll('[data-cdelch]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('删除自定义端点后，通道和模型会一起从公司目录消失，不能恢复。确定？')) return;
      try { await api('DELETE', '/api/channels/' + encodeURIComponent(b.dataset.cdelch)); toast('已删除'); renderMain(); } catch (err) { toast(err.message, true); }
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
    const kq = $('#kq');
    if (kq) kq.addEventListener('submit', async (e) => {
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
    const posAdd = $('#posAdd');
    if (posAdd) posAdd.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(posAdd);
      const kind = fd.get('quotaKind');
      const n = Number(fd.get('quota'));
      const body = { name: fd.get('name'), quotaKind: kind };
      if (kind === 'tokens') body.weeklyQuotaTokens = n; else body.weeklyQuotaCny = n;
      try { await api('POST', '/api/org/positions', body); toast('已新增岗位'); renderMain(); } catch (err) { toast(err.message, true); }
    });
    const depAdd = $('#depAdd');
    if (depAdd) depAdd.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('POST', '/api/org/departments', { name: new FormData(depAdd).get('name') }); toast('已新增部门'); renderMain(); } catch (err) { toast(err.message, true); }
    });
    document.querySelectorAll('[data-posdel]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('删除岗位 ' + b.dataset.posdel + '？')) return;
      try { await api('DELETE', '/api/org/positions/' + encodeURIComponent(b.dataset.posdel)); toast('已删除岗位'); renderMain(); } catch (err) { toast(err.message, true); }
    }));
    document.querySelectorAll('[data-possave]').forEach((b) => b.addEventListener('click', async () => {
      const row = b.closest('[data-posrow]');
      if (!row) return;
      const kind = row.querySelector('[data-poskind]').value;
      const n = Number(row.querySelector('[data-posquota]').value);
      const body = { quotaKind: kind };
      if (kind === 'tokens') body.weeklyQuotaTokens = n; else body.weeklyQuotaCny = n;
      try { await api('PATCH', '/api/org/positions/' + encodeURIComponent(row.dataset.posrow), body); toast('已保存岗位额度'); renderMain(); } catch (err) { toast(err.message, true); }
    }));
    document.querySelectorAll('[data-posset]').forEach((sel) => sel.addEventListener('change', async () => {
      try { await api('PATCH', '/api/personnel/users/' + encodeURIComponent(sel.dataset.posset), { positionId: sel.value || null }); toast('已改岗位'); renderMain(); } catch (err) { toast(err.message, true); }
    }));
    document.querySelectorAll('[data-depdel]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('从目录删除部门「' + b.dataset.depdel + '」？人员上的部门名仍保留。')) return;
      try { await api('POST', '/api/org/departments/delete', { name: b.dataset.depdel }); toast('已删除部门'); renderMain(); } catch (err) { toast(err.message, true); }
    }));
    const userAdd = $('#userAdd');
    if (userAdd) userAdd.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(userAdd);
      try {
        await api('POST', '/api/personnel/users', { username: fd.get('username'), password: fd.get('password'), displayName: fd.get('displayName'), department: fd.get('department'), role: fd.get('role'), positionId: fd.get('positionId') || null });
        toast('已发账号'); renderMain();
      } catch (err) { toast(err.message, true); }
    });
    document.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const bundle = await api('GET', '/api/admin/export?kinds=' + encodeURIComponent(b.dataset.export));
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
        a.download = 'valimart-' + b.dataset.export.replace(/,/g, '-') + '.json';
        a.click();
        toast('已导出');
      } catch (err) { toast(err.message, true); }
    }));
    document.querySelectorAll('[data-import]').forEach((inp) => inp.addEventListener('change', async () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      try {
        const bundle = JSON.parse(await file.text());
        const r = await api('POST', '/api/admin/import', { bundle, kinds: inp.dataset.import.split(',') });
        const bits = [];
        for (const [k, n] of Object.entries(r.created || {})) if (n) bits.push('新建' + k + ' ' + n);
        for (const [k, n] of Object.entries(r.updated || {})) if (n) bits.push('更新' + k + ' ' + n);
        toast(bits.length ? '已导入：' + bits.join('，') : '已导入');
        renderMain();
      } catch (err) { toast(err.message, true); }
    }));
  }

  /* desk-oauth-subscribe: 只改加入订阅/接入通道弹窗，勿并入内核或 header 改动。 */
  function openCustom() {
    const wrap = document.createElement('div');
    wrap.className = 'overlay';
    wrap.innerHTML = '<div class="dialog"><h3>自定义模型端点</h3><form id="cf"><div class="field"><label>名称</label><input name="label" required /></div><div class="field"><label>Base URL</label><input name="baseUrl" value="https://" required /></div><div class="field"><label>API key</label><input name="credential" type="password" /></div><div class="field"><label>模型 id（可留空自动拉）</label><input name="models" /></div><div class="field"><label>默认上下文（未单独填的模型）</label><input name="contextWindow" /></div><div class="field"><label>思考强度</label><input name="reasoningEfforts" placeholder="low,medium,high" /></div><div class="row" style="margin-top:16px;justify-content:flex-end"><button type="button" id="cancel">取消</button><button class="primary" type="submit">保存</button></div></form></div>';
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

  function openEdit(c) {
    const wrap = document.createElement('div');
    wrap.className = 'overlay';
    const details = c.modelDetails || [];
    const uniq = (key, join) => {
      const vals = [...new Set(details.map((m) => {
        const v = m[key];
        if (v == null || v === '' || v === false) return '';
        return join && Array.isArray(v) ? v.join(',') : String(v);
      }).filter(Boolean))];
      return vals.length === 1 ? vals[0] : '';
    };
    wrap.innerHTML = \`<div class="dialog">
      <h3>编辑 \${esc(c.label)}</h3>
      <p class="desc">改模型列表和上下文，不必重新登录。凭据保持不变。</p>
      <form id="ef">
        \${c.custom ? '<div class="field"><label>名称</label><input name="label" value="' + esc(c.label) + '" /></div>' : ''}
        <div class="field" id="modelsField"><label>模型 id</label><div class="row"><input name="models" style="flex:1" value="\${esc((c.models || []).join(', '))}" /><button type="button" id="discover">拉取列表</button></div></div>
        <div class="field" id="modelPickField"><label>已填入的模型（每行可改上下文、识图，点 × 去掉）</label><div class="model-pick" id="modelPick"></div></div>
        <div class="field"><label>Base URL（可选）</label><input name="baseUrl" value="\${esc(c.baseUrl || '')}" /></div>
        <div class="field"><label>默认上下文（未单独填的模型）</label><input name="contextWindow" value="\${esc(uniq('contextWindow'))}" placeholder="例如 200000" /></div>
        <div class="field"><label>思考强度</label><input name="reasoningEfforts" value="\${esc(uniq('reasoningEfforts', true))}" placeholder="low,medium,high" /></div>
        <div class="row" style="margin-top:16px;justify-content:flex-end"><button type="button" id="cancel">取消</button><button class="primary" type="submit">保存</button></div>
      </form>
    </div>\`;
    document.body.appendChild(wrap);
    const modelsIn = wrap.querySelector('input[name=models]');
    let pickedModels = [];
    const paintPicker = (models) => {
      const list = models || [];
      pickedModels = catalogToEntries(list, pickedModels);
      const field = wrap.querySelector('#modelPickField');
      const box = wrap.querySelector('#modelPick');
      if (!pickedModels.length) { if (field) field.style.display = 'none'; return; }
      if (field) field.style.display = '';
      const render = () => {
        renderModelRows(box, pickedModels, (next) => {
          pickedModels = next;
          modelsIn.value = pickedModels.map((m) => m.id).join(', ');
          render();
        });
      };
      modelsIn.value = pickedModels.map((m) => m.id).join(', ');
      render();
    };
    paintPicker(details.length ? details.map((m) => ({ id: m.id, contextWindow: uniq('contextWindow') ? '' : m.contextWindow, vision: m.vision })) : (c.models || []));
    wrap.querySelector('#discover').addEventListener('click', async () => {
      try {
        const r = await api('POST', '/api/channels/' + encodeURIComponent(c.id) + '/discover-models', { baseUrl: wrap.querySelector('input[name=baseUrl]').value || undefined });
        paintPicker(r.models || []);
        const ctxIn = wrap.querySelector('input[name=contextWindow]');
        const first = (r.models || []).find((m) => m && m.contextWindow);
        if (ctxIn && !String(ctxIn.value || '').trim() && first?.contextWindow) ctxIn.value = String(first.contextWindow);
        toast((r.source === 'upstream' ? '已拉取 ' : '内置目录 ') + (r.models || []).length + ' 个模型');
      } catch (err) { toast(err.message, true); }
    });
    modelsIn.addEventListener('input', () => {
      pickedModels = parseModelEntries(modelsIn.value, pickedModels);
      const field = wrap.querySelector('#modelPickField');
      const box = wrap.querySelector('#modelPick');
      if (!pickedModels.length) { if (field) field.style.display = 'none'; return; }
      if (field) field.style.display = '';
      renderModelRows(box, pickedModels, (next) => {
        pickedModels = next;
        modelsIn.value = pickedModels.map((m) => m.id).join(', ');
        modelsIn.dispatchEvent(new Event('input'));
      });
    });
    wrap.querySelector('#cancel').addEventListener('click', () => wrap.remove());
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
    wrap.querySelector('#ef').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const entries = pickedModels.length ? pickedModels : parseModelEntries(modelsIn.value);
      if (!entries.length) return toast('请至少填写或留下一个模型 id', true);
      try {
        const r = await api('PATCH', '/api/channels/' + encodeURIComponent(c.id), {
          models: modelsPayload(entries),
          label: fd.get('label') || undefined,
          baseUrl: fd.get('baseUrl') || undefined,
          contextWindow: fd.get('contextWindow') ? Number(fd.get('contextWindow')) : undefined,
          reasoningEfforts: fd.get('reasoningEfforts') ? String(fd.get('reasoningEfforts')).split(/[,\\s]+/).filter(Boolean) : undefined,
        });
        toast('已更新 ' + r.channel.label + '：' + (r.channel.models || []).join(', '));
        wrap.remove(); renderMain();
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
        <div class="field" id="modelsField"><label>模型 id（可留空自动拉取）</label><div class="row"><input name="models" style="flex:1" /><button type="button" id="discover">拉取列表</button></div></div>
        <div class="field" id="modelPickField" style="display:none"><label>已拉取的模型（每行可改上下文、识图，点 × 去掉）</label><div class="model-pick" id="modelPick"></div></div>
        <div class="field"><label>Base URL（可选，留空用默认）</label><input name="baseUrl" /></div>
        <div class="field"><label>默认上下文（未单独填的模型）</label><input name="contextWindow" placeholder="自动 / 例如 200000" /></div>
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
    let pickedModels = [];
    const current = () => candidates.find((x) => x.id === sel.value) || candidates[0];
    const setOAuthStatus = (msg, bad) => {
      const el = wrap.querySelector('#oauthStatus');
      if (el) { el.textContent = msg; el.className = bad ? 'desc bad' : 'desc'; }
    };
    const paintPicker = (models) => {
      const list = models || [];
      pickedModels = catalogToEntries(list, pickedModels);
      const field = wrap.querySelector('#modelPickField');
      const box = wrap.querySelector('#modelPick');
      const modelsField = wrap.querySelector('#modelsField');
      if (modelsField) modelsField.style.display = '';
      if (!pickedModels.length) { if (field) field.style.display = 'none'; return; }
      if (field) field.style.display = '';
      const render = () => {
        renderModelRows(box, pickedModels, (next) => {
          pickedModels = next;
          modelsIn.value = pickedModels.map((m) => m.id).join(', ');
          render();
        });
      };
      modelsIn.value = pickedModels.map((m) => m.id).join(', ');
      const ctxIn = wrap.querySelector('input[name=contextWindow]');
      const first = list.find((m) => m && m.contextWindow);
      if (ctxIn && !String(ctxIn.value || '').trim() && first?.contextWindow) ctxIn.value = String(first.contextWindow);
      render();
    };
    const onAuthorized = (st) => {
      paintPicker(st.models || []);
      setOAuthStatus('已登录，已拉取 ' + (st.models || []).length + ' 个模型。去掉不需要的，再点接入。');
      const submit = wrap.querySelector('#connSubmit');
      if (submit) { submit.style.display = ''; submit.textContent = '接入这些模型'; submit.dataset.oauthCommit = '1'; }
    };
    const watchStatus = (channelId, state) => {
      if (pollTimer) clearInterval(pollTimer);
      const t0 = Date.now();
      pollTimer = setInterval(async () => {
        if (Date.now() - t0 > 10 * 60 * 1000) { clearInterval(pollTimer); setOAuthStatus('授权超时，请重试', true); return; }
        try {
          const st = await api('GET', '/api/channels/' + encodeURIComponent(channelId) + '/oauth/status?state=' + encodeURIComponent(state));
          if (st.status === 'authorized') { clearInterval(pollTimer); onAuthorized(st); }
          else if (st.status === 'success') { clearInterval(pollTimer); toast('已接入 ' + st.channel.label + '：' + (st.channel.models || []).join(', ')); wrap.remove(); renderMain(); }
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
          wrap.dataset.oauthState = r.state || '';
          watchStatus(c.id, r.state);
          return;
        }
        openAuthorizePage(r.authorizeUrl, popup);
        showOAuthLink(r.authorizeUrl);
        wrap.dataset.oauthState = r.state || '';
        if (r.flow === 'authorization_code_paste') {
          setOAuthStatus(c.oauth?.pasteHint || '浏览器登录后，把回调页上的授权码（或整段网址）贴到下面。');
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
        if (st.status === 'authorized') onAuthorized(st);
        else if (st.status === 'success') { toast('已接入 ' + st.channel.label + '：' + (st.channel.models || []).join(', ')); wrap.remove(); renderMain(); }
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
        desc.textContent = o.detail || '用官方 OAuth 登录订阅账号，令牌只保存在服务端；员工不接触凭据。';
        const flowHint = o.flow === 'device_code'
          ? '将打开浏览器，输入一次性代码登录订阅账号。'
          : o.flow === 'authorization_code_paste'
            ? (o.pasteHint || '将打开浏览器登录；登录后把授权码贴回来。')
            : '浏览器打开授权页，登录后回到此页选择模型。';
        oauthBox.innerHTML = '<div class="field"><button type="button" class="primary" id="oauthLogin">登录账号</button><p class="desc" id="oauthStatus">' + flowHint + '</p><p class="mono" id="oauthDeviceCode" style="font-size:22px;letter-spacing:2px;margin:6px 0 0"></p><p id="oauthOpenWrap" style="display:none;margin:8px 0 0"><a id="oauthOpenLink" target="_blank" rel="noopener noreferrer">如果浏览器拦截了弹窗，点这里打开授权页</a></p><div id="oauthPaste" style="display:none;margin-top:10px"><input id="oauthPasteCode" placeholder="授权码或回调网址" /><button type="button" id="oauthComplete" style="margin-top:8px">提交授权码</button></div><details style="margin-top:10px"><summary class="muted" style="cursor:pointer;font-size:12px">高级：手动粘贴</summary></details></div>';
        credLabel.textContent = '订阅凭据（访问令牌）';
        credIn.required = false;
        credField.style.display = 'none';
        const hideSubmit = wrap.querySelector('#connSubmit');
        if (hideSubmit) hideSubmit.style.display = 'none';
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
        const r = await api('POST', '/api/channels/' + encodeURIComponent(c.id) + '/discover-models', { credential: credIn.value, baseUrl: baseIn.value || undefined, state: wrap.dataset.oauthState || undefined });
        paintPicker(r.models || []);
        toast((r.source === 'upstream' ? '已拉取 ' : '内置目录 ') + (r.models || []).length + ' 个模型');
      } catch (err) { toast(err.message, true); }
    });
    modelsIn.addEventListener('input', () => {
      pickedModels = parseModelEntries(modelsIn.value, pickedModels);
      const field = wrap.querySelector('#modelPickField');
      const box = wrap.querySelector('#modelPick');
      if (!pickedModels.length) { if (field) field.style.display = 'none'; return; }
      if (field) field.style.display = '';
      renderModelRows(box, pickedModels, (next) => {
        pickedModels = next;
        modelsIn.value = pickedModels.map((m) => m.id).join(', ');
        modelsIn.dispatchEvent(new Event('input'));
      });
    });
    wrap.querySelector('#cancel').addEventListener('click', () => { if (pollTimer) clearInterval(pollTimer); wrap.remove(); });
    wrap.addEventListener('click', (e) => { if (e.target === wrap) { if (pollTimer) clearInterval(pollTimer); wrap.remove(); } });
    wrap.querySelector('#cf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const submit = wrap.querySelector('#connSubmit');
      try {
        if (submit && submit.dataset.oauthCommit) {
          const entries = pickedModels.length ? pickedModels : parseModelEntries(modelsIn.value);
          if (!entries.length) return toast('请至少填写或留下一个模型 id', true);
          const st = await api('POST', '/api/channels/' + encodeURIComponent(fd.get('id')) + '/oauth/commit', { state: wrap.dataset.oauthState, models: modelsPayload(entries), contextWindow: fd.get('contextWindow') ? Number(fd.get('contextWindow')) : undefined, reasoningEfforts: fd.get('reasoningEfforts') ? String(fd.get('reasoningEfforts')).split(/[,\\s]+/).filter(Boolean) : undefined });
          if (st.status !== 'success') return toast(st.error || '接入失败', true);
          toast('已接入 ' + st.channel.label + '：' + (st.channel.models || []).join(', '));
        } else {
          const entries = pickedModels.length ? pickedModels : parseModelEntries(modelsIn.value);
          const r = await api('POST', '/api/channels/' + encodeURIComponent(fd.get('id')) + '/connect', { credential: fd.get('credential'), models: modelsPayload(entries), baseUrl: fd.get('baseUrl') || undefined, contextWindow: fd.get('contextWindow') ? Number(fd.get('contextWindow')) : undefined, reasoningEfforts: fd.get('reasoningEfforts') ? String(fd.get('reasoningEfforts')).split(/[,\\s]+/).filter(Boolean) : undefined });
          toast('已接入 ' + r.channel.label + '：' + r.channel.models.join(', '));
        }
        if (pollTimer) clearInterval(pollTimer);
        wrap.remove(); renderMain();
      } catch (err) { toast(err.message, true); }
    });
  }

  $('#logout').addEventListener('click', async () => { try { await api('POST', '/api/auth/logout'); } catch {} token = ''; me = null; sessionStorage.removeItem('diva-admin-token'); boot(); });
  window.addEventListener('hashchange', () => {
    if (!token || !document.body.classList.contains('ready')) return;
    if ($('#main > [data-page]')) applyPage();
    else renderMain();
  });
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
