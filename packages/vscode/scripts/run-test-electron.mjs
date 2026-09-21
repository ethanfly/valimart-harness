import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { runTests } = await import('@vscode/test-electron')

await runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, 'test', 'vscode-host', 'suite.cjs'),
  launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes'],
})
