import { spawnSync } from 'node:child_process'

/** 静态验证归档中的锁实现及其实际 Darwin 原生依赖；不在 Windows 加载 Mach-O。 */
export function verifyMacSessionLock({ lockSource, readEntry }) {
  const syntax = (source, label) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`${label} 语法错误：${r.stderr || r.error?.message}`)
  }
  syntax(lockSource, 'session lock')
  if (/from\s*["']fs-ext["']/.test(lockSource)) throw new Error('会话锁还在直接 import fs-ext')
  if (/import\s*\{\s*tryLockExclusive\s*\}\s*from\s*["']@deepseek-ai\/node-addon-system\/flock["']/.test(lockSource)) {
    const base = '@deepseek-ai/node-addon-system'
    const pkg = JSON.parse(readEntry(`${base}/package.json`).toString())
    if (pkg.exports?.['./flock']?.default !== './lib/flock.js') throw new Error('node-addon-system flock 导出路径变化')
    const source = readEntry(`${base}/lib/flock.js`).toString()
    syntax(source, 'node-addon-system/flock')
    for (const needle of ['export async function tryLockExclusive', 'loadBinding().tryLock', '@deepseek-ai/node-addon-system-${platform}-${arch}/package.json', "'system.node'", "'bin'"]) {
      if (!source.includes(needle)) throw new Error(`flock 原生加载路径变化：缺 ${needle}`)
    }
    const nativeName = `${base}-darwin-x64`
    const nativePkg = JSON.parse(readEntry(`${nativeName}/package.json`).toString())
    if (nativePkg.name !== nativeName || nativePkg.version !== pkg.optionalDependencies?.[nativeName] || !nativePkg.os?.includes('darwin') || !nativePkg.cpu?.includes('x64')) throw new Error('flock darwin 平台包版本/平台不匹配')
    const bytes = readEntry(`${nativeName}/bin/system.node`)
    const thin = bytes.length >= 8 && [0xfeedface, 0xfeedfacf].includes(bytes.readUInt32LE(0)) && bytes.readUInt32LE(4) === 0x01000007
    let fat = false
    if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0xcafebabe) {
      const count = bytes.readUInt32BE(4)
      for (let i = 0; i < count && 8 + (i + 1) * 20 <= bytes.length; i++) if (bytes.readUInt32BE(8 + i * 20) === 0x01000007) fat = true
    }
    if (!thin && !fat) throw new Error('flock bin/system.node 不是 x86_64 Mach-O')
    return 'node-addon-system'
  }
  for (const needle of ['company-session-lock-v2', 'companyPosixFlock', 'koffi.load']) {
    if (!lockSource.includes(needle)) throw new Error(`会话锁补丁没生效（缺 ${needle}）`)
  }
  return 'koffi'
}
