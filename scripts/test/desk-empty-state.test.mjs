/**
 * 客户端空态：源码不硬编码演示人名；store 默认任务/同事为空数组。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEMO = /emp-a|mingan|马一南|马一敏|boss-b|员工A|联合创始人|Mock Echo|mock-echo/
const UI_SRC = [
  'plugins/desk-ui/src/client/store.js',
  'plugins/desk-ui/src/client/settings.jsx',
  'plugins/desk-ui/src/client/sidebar.jsx',
  'plugins/desk-ui/src/client/login.jsx',
  'plugins/desk-ui/src/client/tasks.jsx',
  'plugins/desk-ui/src/client/api.js',
  'plugins/desk-ui/src/client/version.js',
  'desktop/main.js',
  'desktop/preload.js',
]

test('desk-ui / desktop 源码不含演示账号或假模型名', () => {
  for (const rel of UI_SRC) {
    const text = fs.readFileSync(path.join(repo, rel), 'utf8')
    const hit = text.match(DEMO)
    assert.equal(hit, null, `${rel} 不应出现演示数据：${hit?.[0] ?? ''}`)
  }
})

test('deskStore 默认 tasks / people 为空，不预置假列表', () => {
  const store = fs.readFileSync(path.join(repo, 'plugins/desk-ui/src/client/store.js'), 'utf8')
  assert.match(store, /tasks:\s*\[\]/)
  assert.match(store, /people:\s*\[\]/)
  assert.doesNotMatch(store, /displayName:\s*['"]/)
})

test('侧栏任务空态文案存在，且不回退到假任务标题', () => {
  const sidebar = fs.readFileSync(path.join(repo, 'plugins/desk-ui/src/client/sidebar.jsx'), 'utf8')
  assert.match(sidebar, /暂无任务/)
  assert.doesNotMatch(sidebar, /学习agent|季度复盘|详情页/)
})

test('任务正文 textarea 绑定 onBlur 静默保存', () => {
  const tasks = fs.readFileSync(path.join(repo, 'plugins/desk-ui/src/client/tasks.jsx'), 'utf8')
  assert.match(tasks, /const onBlur = \(\) =>/)
  assert.match(tasks, /<textarea[\s\S]*onBlur=\{onBlur\}/)
})

test('安装版主进程会在启动时尝试应用已下载的客户端更新，并在起内核前自动检查内核/客户端更新', () => {
  const main = fs.readFileSync(path.join(repo, 'desktop/main.js'), 'utf8')
  assert.match(main, /maybeApplyPendingClient/)
  assert.match(main, /applyPendingClientUpdate/)
  assert.match(main, /DESK_PAYLOAD_DIR/)
  // 打开前检查：登录会话在手 → 客户端新包下载后立即套用（本进程退出，安装器拉起新版）；内核下载后本次 bootstrap 直接生效
  assert.match(main, /preOpenUpdateCheck/)
  assert.match(main, /fetchClientUpdate/)
  assert.match(main, /fetchKernelUpdate/)
  assert.match(main, /readDeskState/)
  assert.match(main, /relaunching \|\| quitting/)
  const host = fs.readFileSync(path.join(repo, 'plugins/desk-host/lib/index.js'), 'utf8')
  assert.match(host, /scheduleClientUpdate/)
})

test('登录下拉按网关实例列出，不把每个 IP 当成一台', () => {
  const login = fs.readFileSync(path.join(repo, 'plugins/desk-ui/src/client/login.jsx'), 'utf8')
  assert.doesNotMatch(login, /gateways\.flatMap/)
  assert.match(login, /gateways\.map/)
})

test('侧栏项目行展示 git 分支', () => {
  const sidebar = fs.readFileSync(path.join(repo, 'plugins/desk-ui/src/client/sidebar.jsx'), 'utf8')
  const css = fs.readFileSync(path.join(repo, 'plugins/desk-ui/src/client/styles.css'), 'utf8')
  assert.match(sidebar, /WorkspaceGitSync|applyGitBranchBadges/)
  assert.match(css, /\.dk-git-branch/)
})

test('Electron 侧栏品牌行有上内边距，避免 logo 顶到窗口边缘', () => {
  const css = fs.readFileSync(path.join(repo, 'plugins/desk-ui/src/client/styles.css'), 'utf8').replace(/\s+/g, ' ')
  assert.match(css, /html\.dk-desk-electron \.dk-brand \{[^}]*padding: 16px 14px 8px 12px/)
  assert.match(css, /html\.dk-desk-electron \.dk-rail \{ padding-top: 16px; \}/)
})

test('表单控件默认高度与按钮对齐', () => {
  const css = fs.readFileSync(path.join(repo, 'plugins/desk-ui/src/client/styles.css'), 'utf8').replace(/\s+/g, ' ')
  assert.match(css, /\.dk-input:not\(textarea\), \.dk-select \{[^}]*height: 30px/)
  assert.match(css, /\.dk-btn \{[^}]*height: 30px/)
  assert.match(css, /\.dk-input\.sm, \.dk-select\.sm \{[^}]*height: 26px/)
})
