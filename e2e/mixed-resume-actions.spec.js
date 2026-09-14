/**
 * Mixed 错误横幅：在真实浏览器里点「继续 / 重试 / 重跑 / 关闭」。
 * 用面板同一份 mixed-panel-state.js（不是抄一份逻辑），拦截 fetch 证明会发出 resume/rerun。
 * 不依赖完整 Desk 内核；DESK_MIXED_URL 未设也能跑。
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve('plugins/desk-ui/src/client')
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8')
const stateSrc = fs
  .readFileSync(path.join(root, 'mixed-panel-state.js'), 'utf8')
  .replace(/^export /gm, '')
  .concat('\nwindow.MixedPanel = { pickActionRun, resumeBusyKey, newRerunRequestId, buildResumeRequest, MIXED_RECOVERABLE }\n')

function fixture({ last, terminalRun }) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><style>${css}</style>
<style>body{margin:24px;background:#fff;font-family:sans-serif}</style>
</head>
<body>
  <div id="host"></div>
  <div id="toast" class="dk-toast" hidden></div>
  <script>
    ${stateSrc}
    const last = ${JSON.stringify(last)};
    const terminalRun = ${JSON.stringify(terminalRun)};
    const action = MixedPanel.pickActionRun({ last, terminalRun, liveRun: null });
    const b = action.run;
    const host = document.getElementById('host');
    const toastEl = document.getElementById('toast');
    function toast(msg) { toastEl.hidden = false; toastEl.textContent = msg; }
    let busy = null;
    let dismissed = false;
    function render() {
      if (dismissed || !b) { host.innerHTML = ''; return; }
      const resuming = !!b.pendingResume;
      const failed = b.status === 'blocked' || b.status === 'interrupted';
      host.innerHTML = \`
        <div class="dk-mixed-panel terminal err">
          <div class="dk-mixed-bar">
            <span class="dk-mixed-status s-\${b.status}">\${b.status}</span>
            <span class="dk-mixed-goal">\${b.goal || ''}</span>
            <span class="dk-muted dk-xs">\${resuming ? '恢复中…' : ''}</span>
            <span class="dk-mixed-bar-actions">
              \${failed ? '<button type="button" class="dk-btn sm" id="btn-rerun" ' + (busy === 'rerun' || resuming ? 'disabled' : '') + '>重跑</button>' : ''}
              \${failed ? '<button type="button" class="dk-btn sm" id="btn-continue" ' + (busy === MixedPanel.resumeBusyKey('continue') || resuming ? 'disabled' : '') + '>继续</button>' : ''}
              \${failed ? '<button type="button" class="dk-btn sm" id="btn-retry" ' + (busy === MixedPanel.resumeBusyKey('retry') || resuming ? 'disabled' : '') + '>重试</button>' : ''}
              <button type="button" class="dk-btn ghost sm" id="btn-dismiss">关闭</button>
            </span>
          </div>
          <div class="dk-mixed-detail">
            <div class="dk-mixed-err">错误：\${(b.error && (b.error.detail || b.error.code)) || ''}</div>
          </div>
        </div>\`;
      host.querySelector('#btn-retry')?.addEventListener('click', () => actResume('retry'));
      host.querySelector('#btn-continue')?.addEventListener('click', () => actResume('continue'));
      host.querySelector('#btn-rerun')?.addEventListener('click', actRerun);
      host.querySelector('#btn-dismiss')?.addEventListener('click', () => { dismissed = true; render(); });
    }
    async function actResume(choice) {
      busy = MixedPanel.resumeBusyKey(choice);
      render();
      try {
        const { runId, body } = MixedPanel.buildResumeRequest(choice, b);
        const r = await fetch('http://127.0.0.1/desk/api/mixed/runs/' + encodeURIComponent(runId) + '/resume', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        const json = await r.json();
        toast(json.resume?.started ? ('恢复已开始（' + (choice === 'retry' ? '重试该阶段' : '继续运行') + '）') : (json.error?.message || '已受理'));
      } catch (err) {
        toast(err.message);
      } finally {
        busy = null;
        render();
      }
    }
    async function actRerun() {
      busy = 'rerun';
      render();
      try {
        const id = MixedPanel.newRerunRequestId();
        await fetch('http://127.0.0.1/desk/api/mixed/runs/' + encodeURIComponent(b.runId) + '/rerun', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rerunRequestId: id }),
        });
        toast('重跑已排队');
      } catch (err) {
        toast(err.message);
      } finally {
        busy = null;
        render();
      }
    }
    render();
  </script>
</body>
</html>`
}

const failRun = {
  runId: 'run-fail',
  status: 'blocked',
  revision: 8,
  goal: '查仓库里昨天的订单数',
  error: { code: 'stage_failed', detail: 'planning 阶段未正常完成（stopReason=max_tokens）' },
}
const oldOk = { runId: 'run-old', status: 'succeeded', revision: 3, goal: '旧成功' }

test('浏览器：规划失败横幅点重试 → POST resume choice=retry，打当前失败 run 不是旧 last', async ({ page }) => {
  const posts = []
  await page.route('**/desk/api/mixed/runs/*/resume', async (route) => {
    posts.push({ url: route.request().url(), body: JSON.parse(route.request().postData() || '{}') })
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ resume: { started: true } }) })
  })
  await page.setContent(fixture({ last: oldOk, terminalRun: failRun }))
  await expect(page.locator('.dk-mixed-err')).toContainText('max_tokens')
  await page.locator('#btn-retry').click()
  await expect(page.locator('#toast')).toContainText('恢复已开始')
  expect(posts).toHaveLength(1)
  expect(posts[0].url).toContain('run-fail')
  expect(posts[0].url).not.toContain('run-old')
  expect(posts[0].body).toEqual({ choice: 'retry', expectedRevision: 8 })
  await page.screenshot({ path: path.resolve('e2e/artifacts/mixed/resume-retry.png'), fullPage: true })
})

test('浏览器：只有 last 是 blocked 时点继续 → 打 last，不能空点', async ({ page }) => {
  const posts = []
  await page.route('**/desk/api/mixed/runs/*/resume', async (route) => {
    posts.push({ url: route.request().url(), body: JSON.parse(route.request().postData() || '{}') })
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ resume: { started: false, reason: 'agent_not_live' } }) })
  })
  await page.setContent(fixture({ last: failRun, terminalRun: null }))
  await page.locator('#btn-continue').click()
  await expect(page.locator('#toast')).toContainText('已受理')
  expect(posts[0].url).toContain('run-fail')
  expect(posts[0].body.choice).toBe('continue')
})

test('浏览器：重跑带 rerunRequestId；关闭后横幅消失', async ({ page }) => {
  const posts = []
  await page.route('**/desk/api/mixed/runs/*/rerun', async (route) => {
    posts.push(JSON.parse(route.request().postData() || '{}'))
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ created: true }) })
  })
  await page.setContent(fixture({ last: null, terminalRun: failRun }))
  await page.locator('#btn-rerun').click()
  await expect(page.locator('#toast')).toContainText('重跑已排队')
  expect(posts[0].rerunRequestId, '重跑必须带幂等键').toBeTruthy()
  await page.locator('#btn-dismiss').click()
  await expect(page.locator('.dk-mixed-panel')).toHaveCount(0)
})
