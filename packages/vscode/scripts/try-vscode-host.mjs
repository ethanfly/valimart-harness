/**
 * Launch the compiled extension in a VS Code / test-electron host twice.
 * If the host cannot start, write vscode-unavailable.log and exit 0 (compile + HTTP tests remain the bar).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = process.env.GROK_SCRATCH || path.join(os.tmpdir(), 'vh-vscode-scratch')
fs.mkdirSync(scratch, { recursive: true })

function whichCode() {
  const names = []
  if (process.platform === 'win32') {
    names.push(
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
      path.join(process.env.PROGRAMFILES || '', 'Microsoft VS Code', 'bin', 'code.cmd'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft VS Code', 'bin', 'code.cmd'),
    )
  } else {
    names.push('/usr/bin/code', '/usr/local/bin/code', '/snap/bin/code')
  }
  for (const p of names) if (p && fs.existsSync(p)) return p
  return null
}

function run(cmd, args, logFile, extraEnv = {}) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(logFile)
    const child = spawn(cmd, args, {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      shell: process.platform === 'win32',
    })
    child.stdout.on('data', (d) => {
      out.write(d)
      process.stdout.write(d)
    })
    child.stderr.on('data', (d) => {
      out.write(d)
      process.stderr.write(d)
    })
    child.on('close', (code) => {
      out.end()
      resolve(code ?? 1)
    })
    child.on('error', (err) => {
      out.write(String(err.stack || err))
      out.end()
      resolve(1)
    })
  })
}

const codeBin = whichCode()
const versionLog = path.join(scratch, 'code-version.log')
if (codeBin) {
  await run(codeBin, ['--version'], versionLog)
} else {
  fs.writeFileSync(versionLog, 'code CLI not found on PATH or common install locations\n')
}

const runner = path.join(root, 'scripts', 'run-test-electron.mjs')
const log1 = path.join(scratch, 'vscode-launch-1.log')
const log2 = path.join(scratch, 'vscode-launch-2.log')
const unavailable = path.join(scratch, 'vscode-unavailable.log')

const code1 = await run(process.execPath, [runner, '--run=1'], log1)
if (code1 !== 0) {
  const detail = [
    'VS Code extension host could not start in this environment.',
    `code binary: ${codeBin ?? '(none)'}`,
    `run 1 exit: ${code1}`,
    `see ${log1}`,
    fs.existsSync(log1) ? fs.readFileSync(log1, 'utf8').slice(0, 8000) : '',
  ].join('\n')
  fs.writeFileSync(unavailable, detail)
  console.error(detail)
  process.exit(0)
}

const code2 = await run(process.execPath, [runner, '--run=2'], log2)
if (code2 !== 0) {
  const detail = [
    'Second VS Code extension host launch failed.',
    `run 2 exit: ${code2}`,
    `see ${log2}`,
    fs.existsSync(log2) ? fs.readFileSync(log2, 'utf8').slice(0, 8000) : '',
  ].join('\n')
  fs.writeFileSync(unavailable, detail)
  console.error(detail)
  process.exit(0)
}

console.log('both extension host launches succeeded')
