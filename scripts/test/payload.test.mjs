import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { digestFiles, makeBuildId, patchGatewayUrl, shouldPrune, stripKernelPeerLinks } from '../lib/payload.mjs'

test('shouldPrune：只删类型声明、source map 与其他平台的 node-pty 预编译', () => {
  assert.equal(shouldPrune('node_modules/x/lib/index.d.ts'), true)
  assert.equal(shouldPrune('node_modules\\x\\lib\\index.d.ts.map'), true)
  assert.equal(shouldPrune('node_modules/x/lib/index.js.map'), true)
  assert.equal(shouldPrune('node_modules/x/lib/index.mjs.map'), true)
  // Windows 客户端目标
  assert.equal(shouldPrune('node_modules/@deepseek-ai/dsh/node_modules/node-pty/prebuilds/darwin-arm64/pty.node', 'win32', 'x64'), true)
  assert.equal(shouldPrune('node_modules/@deepseek-ai/dsh/node_modules/node-pty/prebuilds/win32-x64/conpty.node', 'win32', 'x64'), false)
  // macOS Intel 客户端目标：留 darwin-x64，删 win32 / linux / arm64
  assert.equal(shouldPrune('node_modules/node-pty/prebuilds/darwin-x64/pty.node', 'darwin', 'x64'), false)
  assert.equal(shouldPrune('node_modules/node-pty/prebuilds/win32-x64/pty.node', 'darwin', 'x64'), true)
  assert.equal(shouldPrune('node_modules/node-pty/prebuilds/darwin-arm64/pty.node', 'darwin', 'x64'), true)
  assert.equal(shouldPrune('node_modules/node-pty/build/Release/conpty/conpty.dll', 'darwin', 'x64'), true)
  assert.equal(shouldPrune('node_modules/node-pty/third_party/conpty/1.23.251008001/win10-x64/conpty.dll', 'darwin', 'x64'), true)
  assert.equal(shouldPrune('node_modules/x/lib/index.js'), false)
  assert.equal(shouldPrune('node_modules/x/LICENSE'), false)
  assert.equal(shouldPrune('node_modules/x/README.md'), false)
  assert.equal(shouldPrune('node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node'), false)
})

test('stripKernelPeerLinks：剥掉顶层 @deepseek-ai/*（保留 dsh），symlink 与已展开的真目录都删', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-payload-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const scope = path.join(dir, 'node_modules', '@deepseek-ai')
  fs.mkdirSync(path.join(scope, 'dsh'), { recursive: true })
  fs.mkdirSync(path.join(scope, 'dsh-tools'), { recursive: true })
  fs.writeFileSync(path.join(scope, 'dsh-tools', 'package.json'), '{}')
  fs.writeFileSync(path.join(scope, 'schemastery-link'), 'x') // 普通文件也当链接残留删掉
  assert.equal(stripKernelPeerLinks(dir), 2)
  assert.ok(fs.existsSync(path.join(scope, 'dsh')))
  assert.equal(fs.existsSync(path.join(scope, 'dsh-tools')), false)
  assert.equal(stripKernelPeerLinks(path.join(dir, 'nope')), 0)
})

test('patchGatewayUrl：替换 gatewayUrl、去尾斜杠；没给 url 原样返回；找不到键就抛', () => {
  const yml = "    - id: desk-host\n      config:\n        gatewayUrl: 'http://127.0.0.1:8790'\n        providerId: desk-gateway\n"
  assert.equal(patchGatewayUrl(yml, 'http://gw.company.local:8790/'), yml.replace("'http://127.0.0.1:8790'", "'http://gw.company.local:8790'"))
  assert.equal(patchGatewayUrl(yml, undefined), yml)
  assert.throws(() => patchGatewayUrl('- id: x\n', 'http://a'), /gatewayUrl/)
})

test('makeBuildId：版本+内核版本+时间戳+摘要前 8 位', () => {
  const id = makeBuildId({ version: '0.1.0', kernelVersion: '0.1.1-rc.2', digest: 'abcdef0123456789', now: new Date('2026-09-04T01:02:03Z') })
  assert.equal(id, '0.1.0+0.1.1-rc.2.20260904-0102.abcdef01')
})

test('客户端 payload 白名单含 git-head（desk-host 读工作区分支）', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build-payload.mjs'), 'utf8')
  assert.match(src, /scripts\/lib\/git-head\.mjs/)
  assert.match(src, /scripts\/lib\/client-update\.mjs/)
  assert.match(src, /scripts\/lib\/model-input\.mjs/)
})

test('digestFiles：内容相同摘要相同，顺序无关', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-payload-'))
  const a = path.join(dir, 'a.txt')
  const b = path.join(dir, 'b.txt')
  fs.writeFileSync(a, 'A')
  fs.writeFileSync(b, 'B')
  assert.equal(digestFiles([a, b]), digestFiles([b, a]))
  fs.writeFileSync(b, 'C')
  assert.notEqual(digestFiles([a, b]), digestFiles([a, a]))
  assert.match(digestFiles([a]), /^[0-9a-f]{40}$/)
})
