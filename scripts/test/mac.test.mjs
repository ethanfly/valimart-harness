import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ZipWriter, openZip, crc32, toDosTime, isSymlinkMode } from '../lib/zip.mjs'
import { buildIcns } from '../lib/icns.mjs'
import { mapElectronName, patchMainPlist, patchHelperPlist, plistSet } from '../lib/mac-app.mjs'
import { findPackageDirs } from '../lib/mac-kernel.mjs'
import { shouldExecKernelFile } from '../lib/bootstrap.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'diva-mac-'))

test('zip：写出的 unix 权限位、符号链接、目录都能原样读回', (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'a.zip')
  const { dosTime, dosDate } = toDosTime(new Date('2026-09-10T12:34:56'))
  new ZipWriter(file)
    .addDir('App.app/')
    .addFile('App.app/exe', Buffer.from('#!/bin/sh\n'), { mode: 0o100755, dosTime, dosDate })
    .addFile('App.app/data.txt', Buffer.from('hello 世界'), { mode: 0o100644 })
    .addFile('App.app/big.txt', Buffer.from('a'.repeat(4096)), { mode: 0o100644 })
    .addSymlink('App.app/current', 'Versions/A')
    .finalize()

  const z = openZip(file)
  assert.equal(z.entries.length, 5)
  const exe = z.byName.get('App.app/exe')
  assert.equal(exe.mode & 0o777, 0o755)
  assert.equal(exe.modeInferred, false)
  assert.equal(z.read(exe).toString(), '#!/bin/sh\n')
  assert.equal(exe.dosTime, dosTime)
  assert.equal(exe.dosDate, dosDate)
  const link = z.byName.get('App.app/current')
  assert.ok(isSymlinkMode(link.mode))
  assert.equal(z.read(link).toString(), 'Versions/A')
  const data = z.byName.get('App.app/data.txt')
  assert.equal(z.read(data).toString('utf8'), 'hello 世界')
  assert.equal(data.method, 0, '太短的内容不值得 deflate')
  const big = z.byName.get('App.app/big.txt')
  assert.equal(big.method, 8, '可压缩的文本应该走 deflate')
  assert.equal(z.read(big).toString(), 'a'.repeat(4096))
  assert.ok(z.byName.get('App.app/').isDir)
  assert.equal(crc32(Buffer.from('abc')), 0x352441c2)
})

test('mapElectronName：主 app / Helper / 图标 / 根文件的重命名', () => {
  assert.equal(mapElectronName('Electron.app/', 'valimart harness'), 'valimart harness.app/')
  assert.equal(mapElectronName('Electron.app/Contents/MacOS/Electron', 'valimart harness'), 'valimart harness.app/Contents/MacOS/valimart harness')
  assert.equal(
    mapElectronName('Electron.app/Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)', 'valimart harness'),
    'valimart harness.app/Contents/Frameworks/valimart harness Helper (GPU).app/Contents/MacOS/valimart harness Helper (GPU)',
  )
  assert.equal(
    mapElectronName('Electron.app/Contents/Frameworks/Electron Helper.app/Contents/Info.plist', 'valimart harness'),
    'valimart harness.app/Contents/Frameworks/valimart harness Helper.app/Contents/Info.plist',
  )
  assert.equal(
    mapElectronName('Electron.app/Contents/Frameworks/Electron Helper.app/Contents/PkgInfo', 'valimart harness'),
    'valimart harness.app/Contents/Frameworks/valimart harness Helper.app/Contents/PkgInfo',
  )
  assert.equal(mapElectronName('Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/Current', 'valimart harness'), 'valimart harness.app/Contents/Frameworks/Electron Framework.framework/Versions/Current')
  assert.equal(mapElectronName('Electron.app/Contents/Resources/electron.icns', 'valimart harness'), null)
  assert.equal(mapElectronName('Electron.app/Contents/Resources/default_app.asar', 'valimart harness'), 'valimart harness.app/Contents/Resources/default_app.asar')
  assert.equal(mapElectronName('LICENSES.chromium.html', 'valimart harness'), 'valimart harness.app/Contents/Resources/LICENSES.chromium.html')
  assert.equal(mapElectronName('LICENSE', 'valimart harness'), 'valimart harness.app/Contents/Resources/LICENSE.electron')
  assert.equal(mapElectronName('version', 'valimart harness'), null)
  assert.equal(mapElectronName('something-else.txt', 'valimart harness'), null)
})

test('plist：替换已有键、缺键时插入', () => {
  const plist = '<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleName</key>\n\t<string>Electron</string>\n</dict>\n</plist>\n'
  const out = plistSet(plist, 'CFBundleName', 'valimart harness')
  assert.match(out, /<key>CFBundleName<\/key>\s*<string>valimart harness<\/string>/)
  const added = plistSet(plist, 'CFBundleIconFile', 'icon.icns')
  assert.match(added, /<key>CFBundleIconFile<\/key>\n\t<string>icon\.icns<\/string>/)
  assert.match(added, /<key>CFBundleName<\/key>/)

  const main = patchMainPlist(plist, { appName: 'valimart harness', appId: 'team.ethan.valimart-harness', version: '0.1.0', copyright: 'VMBUILD x' })
  assert.match(main, /team\.ethan\.valimart-harness/)
  assert.match(main, /<string>0\.1\.0<\/string>/)
  const helper = patchHelperPlist(plist, { appName: 'valimart harness', appId: 'team.ethan.valimart-harness', suffix: ' (GPU)' })
  assert.match(helper, /team\.ethan\.valimart-harness\.helper\.GPU/)
  assert.match(helper, /valimart harness Helper \(GPU\)/)
})

test('icns：结构合法、含各尺寸 PNG 块', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  const icns = buildIcns(new Map([[32, png], [128, png], [1024, png]]))
  assert.equal(icns.toString('ascii', 0, 4), 'icns')
  assert.equal(icns.readUInt32BE(4), icns.length)
  const types = []
  let off = 8
  while (off < icns.length) {
    const type = icns.toString('ascii', off, off + 4)
    const len = icns.readUInt32BE(off + 4)
    types.push(type)
    assert.ok(len > 8)
    off += len
  }
  assert.deepEqual(types, ['ic11', 'ic07', 'ic10'])
})

test('shouldExecKernelFile：mac 上要能被 exec 的内核文件', () => {
  // 必须有 +x，否则 ripgrep / 终端直接 EACCES
  assert.equal(shouldExecKernelFile('node_modules/@deepseek-ai/dsh/node_modules/@vscode/ripgrep-darwin-x64/bin/rg'), true)
  assert.equal(shouldExecKernelFile('node_modules/node-pty/prebuilds/darwin-x64/spawn-helper'), true)
  assert.equal(shouldExecKernelFile('node_modules/.bin/dsh'), true)
  assert.equal(shouldExecKernelFile('scripts/foo.sh'), true)
  assert.equal(shouldExecKernelFile('App.app/Contents/MacOS/App.command'), true)
  // 不该动的
  assert.equal(shouldExecKernelFile('node_modules/node-pty/prebuilds/darwin-x64/pty.node'), false)
  assert.equal(shouldExecKernelFile('node_modules/@img/sharp-libvips-darwin-x64/lib/libvips-cpp.8.18.6.dylib'), false)
  assert.equal(shouldExecKernelFile('node_modules/@koromix/koffi-darwin-x64/darwin_x64/koffi.node'), false)
  assert.equal(shouldExecKernelFile('node_modules/@deepseek-ai/dsh/lib/bin.js'), false)
})

test('findPackageDirs：能在嵌套 node_modules 里定位平台包', (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const mk = (rel) => {
    const p = path.join(dir, rel)
    fs.mkdirSync(p, { recursive: true })
    fs.writeFileSync(path.join(p, 'package.json'), '{}')
    return p
  }
  const want = mk('node_modules/@deepseek-ai/dsh/node_modules/@img/sharp-win32-x64')
  mk('node_modules/@deepseek-ai/dsh/node_modules/@img/other')
  const pty = mk('node_modules/@deepseek-ai/dsh/node_modules/node-pty')
  mk('node_modules/node-pty')
  assert.deepEqual(findPackageDirs(dir, '@img/sharp-win32-x64'), [want])
  assert.equal(findPackageDirs(dir, 'node-pty').length, 2)
  assert.deepEqual(findPackageDirs(dir, 'nope'), [])
  assert.ok(fs.existsSync(pty))
})
