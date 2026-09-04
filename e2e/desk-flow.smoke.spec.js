/**
 * 桌面流冒烟（不启 dsh 内核）：页面上走登录 → 建任务 → 交交付物 → 提交验收。
 * 调的就是 desk-host /desk/api 背后那组网关接口。完整内核 UI 用 DESK_SMOKE_URL 另跑。
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../server/src/index.js'

let gw
let base
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-e2e-flow-'))

test.beforeAll(async () => {
  gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    dataDir: tmp,
    upstreams: { mock: { kind: 'mock', label: 'Mock', models: [{ id: 'mock-echo', name: 'Mock Echo', priceCnyPerM: { input: 0, output: 0, cachedInput: 0 } }] } },
    channels: [],
    defaultModel: 'mock-echo',
    fetchReleases: async () => [],
  })
  base = await gw.listen()
})

test.afterAll(async () => {
  await gw.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const harness = (gateway) => `<!doctype html>
<meta charset="utf-8" />
<title>desk smoke</title>
<h1>登录遮罩</h1>
<form id="login">
  <input name="username" />
  <input name="password" type="password" />
  <button type="submit">登录</button>
</form>
<p id="who"></p>
<button id="new-session" hidden>新会话</button>
<form id="task" hidden>
  <input name="title" value="冒烟任务" />
  <button type="submit">新建任务</button>
</form>
<button id="submit-review" hidden>提交验收</button>
<pre id="log"></pre>
<script>
const gw = ${JSON.stringify(gateway)};
const log = (m) => { document.getElementById('log').textContent += m + '\\n'; };
let token, reviewerId, taskId;
document.getElementById('login').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const r = await fetch(gw + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: fd.get('username'), password: fd.get('password'), device: 'e2e' }) });
  const j = await r.json();
  if (!r.ok) return log('login-fail ' + (j.error?.message || r.status));
  token = j.sessionToken;
  const people = await fetch(gw + '/api/people', { headers: { authorization: 'Bearer ' + token } }).then((r) => r.json());
  reviewerId = (people.users || []).find((u) => u.role === 'director' || u.role === 'admin' && u.id !== j.user.id)?.id;
  document.getElementById('who').textContent = j.user.displayName;
  document.getElementById('new-session').hidden = false;
  document.getElementById('task').hidden = false;
  log('logged-in');
};
document.getElementById('new-session').onclick = () => log('session-new');
document.getElementById('task').onsubmit = async (e) => {
  e.preventDefault();
  const title = new FormData(e.target).get('title');
  const created = await fetch(gw + '/api/tasks', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ title }) });
  const t = (await created.json()).task;
  taskId = t.id;
  await fetch(gw + '/api/tasks/' + taskId + '/deliverables', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ files: [{ name: 'out.txt', dataBase64: btoa('ok') }] }) });
  document.getElementById('submit-review').hidden = false;
  log('task-created ' + taskId);
};
document.getElementById('submit-review').onclick = async () => {
  const r = await fetch(gw + '/api/tasks/' + taskId + '/submit', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ reviewerId }) });
  const j = await r.json();
  log('submitted ' + (j.task?.status || r.status));
};
</script>`

test('页面流：登录 → 新会话 → 新建任务 → 提交验收', async ({ page }) => {
  await page.setContent(harness(base))
  await page.locator('input[name="username"]').fill('emp-a')
  await page.locator('input[name="password"]').fill('emp123456')
  await page.locator('form#login button[type="submit"]').click()
  await expect(page.locator('#who')).toHaveText('员工A')
  await page.locator('#new-session').click()
  await expect(page.locator('#log')).toContainText('session-new')
  await page.locator('form#task button[type="submit"]').click()
  await expect(page.locator('#log')).toContainText('task-created')
  await page.locator('#submit-review').click()
  await expect(page.locator('#log')).toContainText('submitted pending_review')
})

test('可选：对已启动的内核桌面页走登录遮罩', async ({ page }) => {
  const url = process.env.DESK_SMOKE_URL
  test.skip(!url, '设 DESK_SMOKE_URL=http://127.0.0.1:3470 才打真内核页')
  await page.goto(url)
  const user = page.locator('input[name="username"], input[autocomplete="username"]').first()
  await expect(user).toBeVisible({ timeout: 15_000 })
})
