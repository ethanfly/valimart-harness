/**
 * 在 Windows 上组装 macOS 的 .app 并打成 zip（不依赖 electron-builder，见 lib/zip.mjs 里的原因）。
 *
 * 做四件事：
 *   1) 读 Electron 官方 darwin-x64 zip 的中央目录，按 unix mode / symlink 原样搬进目标 zip；
 *   2) 把 Electron.app 改名成 <productName>.app：主可执行、四个 Helper.app、各自的 Info.plist 一起改名，
 *      不然 Electron 运行时按「主 bundle 名 + " Helper"」找 GPU / Renderer 子进程，名字对不上直接起不来；
 *   3) 写入 Contents/Resources/{app,payload,icon.icns}；
 *   4) 用 lib/zip.mjs 写出带权限位与符号链接的 zip（macOS 解压后可直接双击运行）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ZipWriter, openZip } from './zip.mjs'
import { buildIcns } from './icns.mjs'

/** Electron 的四个子进程 Helper 后缀（主 app 之外）。 */
const HELPER_SUFFIXES = ['', ' (GPU)', ' (Plugin)', ' (Renderer)']
/** Helper 的 bundle id 后缀，与 electron-builder 一致。 */
const HELPER_ID_SUFFIX = { '': 'helper', ' (GPU)': 'helper.GPU', ' (Plugin)': 'helper.Plugin', ' (Renderer)': 'helper.Renderer' }

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** plist 里设置 <key>k</key><string>v</string>；键不存在则插到第一个 <dict> 后。 */
export function plistSet(text, key, value) {
  const re = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`)
  if (re.test(text)) return text.replace(re, `$1${xmlEscape(value)}$2`)
  return text.replace(/<dict>\r?\n/, (m) => `${m}\t<key>${key}</key>\n\t<string>${xmlEscape(value)}</string>\n`)
}

export function patchMainPlist(text, { appName, appId, version, copyright }) {
  let out = text
  out = plistSet(out, 'CFBundleExecutable', appName)
  out = plistSet(out, 'CFBundleName', appName)
  out = plistSet(out, 'CFBundleDisplayName', appName)
  out = plistSet(out, 'CFBundleIdentifier', appId)
  out = plistSet(out, 'CFBundleShortVersionString', version)
  out = plistSet(out, 'CFBundleVersion', version)
  out = plistSet(out, 'CFBundleIconFile', 'icon.icns')
  out = plistSet(out, 'LSApplicationCategoryType', 'public.app-category.productivity')
  out = plistSet(out, 'NSHumanReadableCopyright', copyright ? `Valimart ${copyright}` : 'Valimart')
  return out
}

export function patchHelperPlist(text, { appName, appId, suffix }) {
  let out = text
  out = plistSet(out, 'CFBundleIdentifier', `${appId}.${HELPER_ID_SUFFIX[suffix]}`)
  out = plistSet(out, 'CFBundleName', `${appName} Helper${suffix}`)
  out = plistSet(out, 'CFBundleExecutable', `${appName} Helper${suffix}`)
  return out
}

/**
 * Electron zip 里的路径 → 目标 zip 里的路径。返回 null = 丢掉。
 * 根目录的 LICENSE / LICENSES.chromium.html 会被搬到 Contents/Resources/ 下（保留许可证声明）。
 */
export function mapElectronName(name, appName) {
  if (name === 'Electron.app' || name === 'Electron.app/') return `${appName}.app/`
  if (name === 'LICENSE') return `${appName}.app/Contents/Resources/LICENSE.electron`
  if (name === 'LICENSES.chromium.html') return `${appName}.app/Contents/Resources/LICENSES.chromium.html`
  if (name === 'version') return null
  if (!name.startsWith('Electron.app/')) return null

  let rest = name.slice('Electron.app/'.length)
  let helperSuffix = null
  for (const suffix of HELPER_SUFFIXES) {
    const from = `Contents/Frameworks/Electron Helper${suffix}.app`
    if (rest === from || rest.startsWith(`${from}/`)) {
      helperSuffix = suffix
      rest = `Contents/Frameworks/${appName} Helper${suffix}.app${rest.slice(from.length)}`
      break
    }
  }
  if (rest === 'Contents/MacOS/Electron') rest = `Contents/MacOS/${appName}`
  if (helperSuffix !== null && /\/Contents\/MacOS\/Electron Helper( \(GPU\)| \(Plugin\)| \(Renderer\))?$/.test(rest)) {
    rest = rest.replace(/\/Contents\/MacOS\/Electron Helper( \(GPU\)| \(Plugin\)| \(Renderer\))?$/, `/Contents/MacOS/${appName} Helper${helperSuffix}`)
  }
  // 换成我们自己的 icon.icns（Info.plist 的 CFBundleIconFile 同步改）
  if (rest === 'Contents/Resources/electron.icns') return null
  return `${appName}.app/${rest}`
}

/** 把一个目录树写进 zip（保留符号链接；mode 由 modeFor 决定）。 */
export function addTree(writer, zipBase, absDir, modeFor = () => 0o100644) {
  let files = 0
  let bytes = 0
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name)
      const zipRel = rel ? `${rel}/${e.name}` : e.name
      const zipPath = `${zipBase}/${zipRel}`
      const st = fs.lstatSync(abs)
      if (st.isSymbolicLink()) {
        writer.addSymlink(zipPath, fs.readlinkSync(abs))
        continue
      }
      if (st.isDirectory()) {
        writer.addDir(zipPath)
        walk(abs, zipRel)
        continue
      }
      const data = fs.readFileSync(abs)
      writer.addFile(zipPath, data, { mode: modeFor(zipRel, abs) })
      files++
      bytes += data.length
    }
  }
  if (fs.existsSync(absDir)) walk(absDir, '')
  return { files, bytes }
}

/**
 * @param {{
 *   electronZip: string, outFile: string, appName: string, appId: string, version: string,
 *   copyright?: string, iconPngs: Map<number, Buffer>, appSourceDir: string, appFiles: string[],
 *   payloadDir: string, log?: Function
 * }} opts
 */
export function buildMacAppZip(opts) {
  const { electronZip, outFile, appName, appId, version, copyright = '', iconPngs, appSourceDir, appFiles, payloadDir, log = () => {} } = opts
  const src = openZip(electronZip)
  const writer = new ZipWriter(outFile)
  const appRoot = `${appName}.app`
  let copied = 0
  let skipped = 0
  let symlinks = 0

  for (const entry of src.entries) {
    const name = mapElectronName(entry.name, appName)
    if (!name) {
      skipped++
      continue
    }
    const isMainPlist = entry.name === 'Electron.app/Contents/Info.plist'
    const helperMatch = /^Electron\.app\/Contents\/Frameworks\/Electron Helper( \(GPU\)| \(Plugin\)| \(Renderer\))?\.app\/Contents\/Info\.plist$/.exec(entry.name)
    if (entry.isSymlink) {
      writer.addSymlink(name, src.read(entry).toString('utf8'), { dosTime: entry.dosTime, dosDate: entry.dosDate })
      symlinks++
      continue
    }
    if (entry.isDir) {
      writer.addDir(name, { mode: 0o40755, dosTime: entry.dosTime, dosDate: entry.dosDate })
      continue
    }
    let data = src.read(entry)
    if (isMainPlist) data = Buffer.from(patchMainPlist(data.toString('utf8'), { appName, appId, version, copyright }), 'utf8')
    else if (helperMatch) data = Buffer.from(patchHelperPlist(data.toString('utf8'), { appName, appId, suffix: helperMatch[1] ?? '' }), 'utf8')
    writer.addFile(name, data, { mode: entry.mode & 0o7777 || 0o100644, dosTime: entry.dosTime, dosDate: entry.dosDate })
    copied++
  }
  log(`Electron 条目：搬运 ${copied}，符号链接 ${symlinks}，丢弃 ${skipped}`)

  // 图标
  const icns = buildIcns(iconPngs)
  writer.addFile(`${appRoot}/Contents/Resources/icon.icns`, icns, { mode: 0o100644 })
  log(`icon.icns ${(icns.length / 1024).toFixed(0)} KB（${[...iconPngs.keys()].sort((a, b) => a - b).join('/')} px）`)

  // 桌面端代码 → Contents/Resources/app
  const missing = []
  for (const rel of appFiles) {
    const abs = path.join(appSourceDir, rel)
    if (!fs.existsSync(abs)) {
      missing.push(rel)
      continue
    }
    const st = fs.statSync(abs)
    writer.addFile(`${appRoot}/Contents/Resources/app/${rel}`, fs.readFileSync(abs), { mode: st.mode & 0o111 ? 0o100755 : 0o100644 })
  }
  if (missing.length) throw new Error(`desktop 里缺文件：${missing.join(', ')}`)
  log(`Resources/app：${appFiles.length} 个文件`)

  // payload → Contents/Resources/payload
  // payload → Contents/Resources/payload
  // 可执行位：构建机是 Windows（没有 unix mode），按路径规则补。
  // kernel.tar 内部的 spawn-helper / bin/rg 由 bootstrap.mjs 解压后 chmod 负责，这里只管直接进包的文件。
  const modeFor = (rel) =>
    rel === 'runtime/node' || /(^|\/)(bin|\.bin)\/[^/]+$/.test(rel) || /(^|\/)spawn-helper$/.test(rel) || /\.(sh|command)$/.test(rel) ? 0o100755 : 0o100644
  const payloadStats = addTree(writer, `${appRoot}/Contents/Resources/payload`, payloadDir, modeFor)
  log(`Resources/payload：${payloadStats.files} 个文件，${(payloadStats.bytes / 1024 / 1024).toFixed(1)} MB`)

  writer.finalize()
  return { outFile, entries: writer.central.length, payloadFiles: payloadStats.files }
}
