import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const nsis = path.join(repo, 'desktop/node_modules/app-builder-lib/templates/nsis')
const cache = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'electron-builder/Cache')
function findFile(dir, matches) {
  if (!fs.existsSync(dir)) return undefined
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) { const found = findFile(file, matches); if (found) return found }
    else if (matches(file)) return file
  }
}

test('NSIS 静默更新：旧版 /S、新版 --force-run 各启动一次，安装失败不启动', { skip: process.platform !== 'win32' }, (t) => {
  const compiler = process.env.MAKENSIS ?? findFile(cache, (p) => /[\\/]Bin[\\/]makensis\.exe$/i.test(p))
  const plugin = findFile(cache, (p) => /[\\/]x86-unicode[\\/]StdUtils\.dll$/i.test(p))
  if (!compiler || !plugin || !fs.existsSync(nsis)) return t.skip('需要 desktop 依赖与 electron-builder NSIS 缓存')
  const { NsisScriptGenerator, nsisEscapeString } = createRequire(import.meta.url)(path.join(repo, 'desktop/node_modules/app-builder-lib/out/targets/nsis/nsisScriptGenerator.js'))
  const generator = new NsisScriptGenerator()
  generator.flags(['force-run', 'fail-install', 'updated'])
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-relaunch-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const exe = path.join(dir, 'probe.exe')
  const launches = path.join(dir, 'launches.txt')
  // Run the production customInstall together with the actual builder finish
  // branch and StartApp macro. Only the OS launch primitive is replaced with
  // a recorder; no real app is installed.
  const stock = fs.readFileSync(path.join(nsis, 'installSection.nsh'), 'utf8')
  const start = stock.indexOf('!ifmacrodef customInstall')
  assert.ok(start >= 0)
  const common = fs.readFileSync(path.join(nsis, 'common.nsh'), 'utf8')
  const startApp = common.match(/!macro StartApp\r?\n[\s\S]*?!macroend/)
  assert.ok(startApp)
  const script = `
Unicode True
RequestExecutionLevel user
SilentInstall silent
OutFile "${nsisEscapeString(exe)}"
!include "LogicLib.nsh"
!addincludedir "${nsisEscapeString(path.join(nsis, 'include'))}"
!addplugindir /x86-unicode "${nsisEscapeString(path.dirname(plugin))}"
!include "StdUtils.nsh"
!undef StdUtils.ExecShellAsUser
!define StdUtils.ExecShellAsUser '!insertmacro recordLaunch'
${generator.build()}
!define ONE_CLICK
!define RUN_AFTER_FINISH
Var launchLink
!macro recordLaunch result file verb args
  FileOpen \${result} "${nsisEscapeString(launches)}" a
  FileWrite \${result} "launch$\\r$\\n"
  FileClose \${result}
!macroend
${startApp[0]}
!macro quitSuccess
  SetErrorLevel 0
  Quit
!macroend
!include "${nsisEscapeString(path.join(repo, 'desktop/build/installer.nsh'))}"
Section
  \${if} \${isFailInstall}
    SetErrorLevel 2
    Quit
  \${endIf}
  ${stock.slice(start)}
SectionEnd
`
  const source = path.join(dir, 'probe.nsi')
  fs.writeFileSync(source, script)
  const compiled = spawnSync(compiler, ['/INPUTCHARSET', 'UTF8', source], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
  for (const [args, expectedExit, expectedStarts] of [
    [['/S'], 0, 1],
    [['/S', '--updated'], 0, 1],
    [['/S', '--force-run'], 0, 1],
    [['/S', '--force-run', '--fail-install'], 2, 0],
  ]) {
    fs.writeFileSync(launches, '')
    const result = spawnSync(exe, args, { windowsHide: true, timeout: 30_000 })
    assert.equal(result.status, expectedExit, args.join(' '))
    assert.equal(fs.readFileSync(launches, 'utf8').split('launch').length - 1, expectedStarts, args.join(' '))
  }
})
