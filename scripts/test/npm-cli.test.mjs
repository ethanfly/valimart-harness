import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { npmEnvironment, npmInvocation } from '../lib/npm-cli.mjs'

test('npmEnvironment：Windows 合并 PATH 大小写，保留系统路径且不修改父环境', () => {
  const env = { Path: 'C:\\Windows\\System32', PATH: 'C:\\Tools', TEMP: 'C:\\Temp' }
  const result = npmEnvironment({ env, execPath: 'C:\\Program Files\\Gateway\\runtime\\node.exe', platform: 'win32' })
  assert.deepEqual(result, { PATH: 'C:\\Program Files\\Gateway\\runtime;C:\\Tools', TEMP: 'C:\\Temp' })
  assert.equal(env.Path, 'C:\\Windows\\System32')
  assert.equal(env.PATH, 'C:\\Tools')
  assert.equal(npmEnvironment({ env: { Path: 'C:\\Windows' }, execPath: 'D:\\runtime\\node.exe', platform: 'win32' }).Path, 'D:\\runtime;C:\\Windows')
})

test('npmEnvironment：无 PATH 也可使用捆绑 Node；Unix 保留区分大小写的变量', () => {
  assert.equal(npmEnvironment({ env: {}, execPath: 'D:\\runtime\\node.exe', platform: 'win32' }).PATH, 'D:\\runtime')
  assert.deepEqual(npmEnvironment({ env: { PATH: '/usr/bin', Path: 'unrelated' }, execPath: '/opt/gateway/bin/node', platform: 'linux' }), {
    PATH: '/opt/gateway/bin:/usr/bin', Path: 'unrelated',
  })
})

test('npm install：服务 PATH 没有 Node 时复现失败，补入 runtime 后安装脚本和孙进程成功', (t) => {
  const npm = npmInvocation()
  if (!npm.pre.length) return t.skip('需要与当前 Node 配套的 npm-cli.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway npm lifecycle '))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'gateway-lifecycle-test', version: '1.0.0', private: true,
    scripts: { install: 'node install.cjs' },
  }))
  fs.writeFileSync(path.join(dir, 'install.cjs'), `
    const { execFileSync } = require('node:child_process');
    const fs = require('node:fs');
    const nested = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8', windowsHide: true }).trim();
    fs.writeFileSync('installed.json', JSON.stringify({ node: process.execPath, nested }));
  `)
  const env = {
    PATH: process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32') : '',
    npm_config_cache: path.join(dir, 'cache'),
    npm_config_userconfig: path.join(dir, 'empty.npmrc'),
    npm_config_globalconfig: path.join(dir, 'global.npmrc'),
  }
  for (const key of ['SystemRoot', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'HOME']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  const install = (childEnv) => spawnSync(npm.cmd, [...npm.pre, 'install', '--offline', '--no-audit', '--no-fund', '--no-package-lock', '--ignore-scripts=false'], {
    cwd: dir, env: childEnv, encoding: 'utf8', shell: npm.shell, windowsHide: true, timeout: 30_000,
  })
  const failed = install(env)
  assert.equal(failed.status, 1, failed.stderr || failed.error?.message)
  assert.equal(fs.existsSync(path.join(dir, 'installed.json')), false)
  const installed = install(npmEnvironment({ env }))
  assert.equal(installed.status, 0, installed.stderr || installed.error?.message)
  const marker = JSON.parse(fs.readFileSync(path.join(dir, 'installed.json'), 'utf8'))
  assert.equal(marker.node, process.execPath)
  assert.equal(marker.nested, process.execPath)
})
