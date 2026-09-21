const assert = require('node:assert/strict')
const vscode = require('vscode')

exports.run = async function run() {
  const id = 'valimart.valimart-harness'
  const ext = vscode.extensions.getExtension(id)
  if (!ext) {
    const ids = vscode.extensions.all.map((e) => e.id).join(', ')
    throw new Error(`extension ${id} not found. loaded: ${ids}`)
  }
  await ext.activate()
  assert.equal(ext.isActive, true, 'extension did not activate')
  const cmds = await vscode.commands.getCommands(true)
  assert.ok(cmds.includes('valimartHarness.openChat'), 'valimartHarness.openChat is not registered')
  assert.ok(cmds.includes('valimartHarness.openChatWindow'), 'valimartHarness.openChatWindow is not registered')
  assert.ok(cmds.includes('valimartHarness.showLogs'), 'valimartHarness.showLogs is not registered')
  const views = vscode.window
  assert.ok(views, 'vscode.window missing')
  console.log('ACTIVATED viewId=valimartHarness.chat command=valimartHarness.openChat')
}
