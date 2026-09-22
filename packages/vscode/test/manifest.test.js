import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('package.json declares engines.vscode, chat view, and open command', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.ok(pkg.engines?.vscode)
  assert.equal(pkg.main, './out/extension.js')
  const containers = pkg.contributes?.viewsContainers?.activitybar ?? []
  assert.ok(containers.some((c) => c.id === 'valimartHarness'))
  const views = pkg.contributes?.views?.valimartHarness ?? []
  assert.ok(views.some((v) => v.id === 'valimartHarness.chat' && v.type === 'webview'))
  const cmds = pkg.contributes?.commands ?? []
  assert.ok(cmds.some((c) => c.command === 'valimartHarness.openChat'))
  assert.ok(cmds.some((c) => c.command === 'valimartHarness.openChatWindow'))
  assert.ok(cmds.some((c) => c.command === 'valimartHarness.showLogs'))
  assert.ok(cmds.some((c) => c.command === 'valimartHarness.cancel'))
  assert.ok(cmds.some((c) => c.command === 'valimartHarness.syncDrive'))
  assert.ok(cmds.some((c) => c.command === 'valimartHarness.openDrive'))
  assert.equal(pkg.version, '0.3.1')
})

test('webview markup has a prompt box and message list', () => {
  const html = fs.readFileSync(path.join(root, 'media', 'chat.html'), 'utf8')
  assert.match(html, /id="prompt"/)
  assert.match(html, /id="transcript"/)
  assert.match(html, /id="loginForm"/)
  assert.match(html, /id="gatewayUrl"/)
  assert.match(html, /id="username"/)
  assert.match(html, /id="password"/)
})

test('webview has thinking animation, image attach, slash palette, 四格验收', () => {
  const html = fs.readFileSync(path.join(root, 'media', 'chat.html'), 'utf8')
  const css = fs.readFileSync(path.join(root, 'media', 'chat.css'), 'utf8')
  const js = fs.readFileSync(path.join(root, 'media', 'chat.js'), 'utf8')
  assert.match(html, /id="thinking"/)
  assert.match(css, /@keyframes/)
  assert.match(html, /id="imageInput"/)
  assert.match(js, /createElement\('img'\)|<img/)
  assert.match(html, /id="slashPalette"/)
  assert.match(html, /提交验收/)
  assert.match(html, /待审/)
  assert.match(html, /待终审/)
  assert.match(html, /通过\/驳回|通过|驳回/)
  assert.match(html, /提交信息/)
  assert.match(html, /任务内容/)
  assert.match(html, /提交内容/)
  assert.match(html, /交付物/)
  assert.match(html, /id="sessionSelect"/)
  assert.match(html, /id="stopBtn"/)
  assert.match(html, /id="detachBtn"/)
  assert.match(html, /id="driveSync"/)
  assert.match(html, /id="driveOpen"/)
})
