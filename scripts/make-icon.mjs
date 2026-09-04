/**
 * 一次性生成应用图标（提交进仓库）：用本机 Edge/Chrome 无头截图把 SVG 渲成 PNG，再把 256px 的 PNG 封进 ICO。
 *   node scripts/make-icon.mjs
 * 产物：desktop/build/icon.png（512×512，electron-builder 用）、desktop/build/icon.ico（256×256 PNG 封装，NSIS 用）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'desktop', 'build')
fs.mkdirSync(outDir, { recursive: true })

const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <rect x="8" y="8" width="240" height="240" rx="52" fill="#1b1b1f"/>
  <rect x="8" y="8" width="240" height="240" rx="52" fill="none" stroke="#4d6bfe" stroke-width="6" opacity="0.9"/>
  <text x="128" y="172" text-anchor="middle" font-family="Georgia, 'Times New Roman', 'Songti SC', serif" font-size="150" font-weight="700" fill="#f6f1e7" letter-spacing="-4">D</text>
  <text x="128" y="222" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="22" fill="#9aa8ff" letter-spacing="6">THE DIVA</text>
</svg>`

function findBrowser() {
  const c = [
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  const hit = c.find((p) => fs.existsSync(p))
  if (!hit) throw new Error('找不到 Edge/Chrome，无法渲染图标')
  return hit
}

function render(size, outPng) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-icon-'))
  try {
    const html = path.join(tmp, 'icon.html')
    fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent">${svg(size)}</body></html>`)
    const r = spawnSync(findBrowser(), ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000', `--window-size=${size},${size}`, `--screenshot=${outPng}`, `--user-data-dir=${path.join(tmp, 'ud')}`, pathToFileURL(html).href], { stdio: 'pipe', encoding: 'utf8', timeout: 60000 })
    if (!fs.existsSync(outPng)) throw new Error(`截图失败：${r.error?.message ?? ''}${r.stderr ?? ''}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** ICO 容器里放一张 PNG（Vista+ 支持；256 在目录项里写 0）。 */
function pngToIco(png, size) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  const entry = Buffer.alloc(16)
  entry[0] = size >= 256 ? 0 : size
  entry[1] = size >= 256 ? 0 : size
  entry[2] = 0
  entry[3] = 0
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12)
  return Buffer.concat([header, entry, png])
}

const png512 = path.join(outDir, 'icon.png')
const png256 = path.join(os.tmpdir(), `diva-icon-256-${process.pid}.png`)
render(512, png512)
render(256, png256)
fs.writeFileSync(path.join(outDir, 'icon.ico'), pngToIco(fs.readFileSync(png256), 256))
fs.unlinkSync(png256)
console.log(`[icon] ${png512} (${fs.statSync(png512).size} B), icon.ico`)
