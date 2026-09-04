/**
 * 生成应用图标：用公司原花标（心尖朝内），不重画形状。
 * 原图先最近邻放大再面积采样，边缘有抗锯齿，轮廓仍是原 logo。
 *   node scripts/make-icon.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'desktop', 'build')
const srcMark = path.join(root, 'plugins', 'desk-ui', 'src', 'client', 'assets', 'valimart-mark.png')
const srcWord = path.join(root, 'plugins', 'desk-ui', 'src', 'client', 'assets', 'valimart-wordmark.png')
fs.mkdirSync(outDir, { recursive: true })

const MASTER = 2048
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const ICON_FILL = '#111114'
const VIEW = 256

function bgSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEW}" height="${VIEW}" viewBox="0 0 ${VIEW} ${VIEW}">
  <rect x="8" y="8" width="240" height="240" rx="52" ry="52" fill="${ICON_FILL}"/>
</svg>`
}

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

function renderSvg(svg, size, outPng) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-icon-'))
  try {
    const html = path.join(tmp, 'icon.html')
    fs.writeFileSync(
      html,
      `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:transparent">${svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</body></html>`,
    )
    const r = spawnSync(
      findBrowser(),
      [
        '--headless=new',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--default-background-color=00000000',
        `--window-size=${size},${size}`,
        `--screenshot=${outPng}`,
        `--user-data-dir=${path.join(tmp, 'ud')}`,
        pathToFileURL(html).href,
      ],
      { stdio: 'pipe', encoding: 'utf8', timeout: 60000 },
    )
    if (!fs.existsSync(outPng)) throw new Error(`截图失败：${r.error?.message ?? ''}${r.stderr ?? ''}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function decodePng(buf) {
  if (buf[0] !== 137 || buf.toString('ascii', 1, 4) !== 'PNG') throw new Error('不是 PNG')
  let off = 8
  let w
  let h
  let depth
  let ctype
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      depth = data[8]
      ctype = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (depth !== 8 || ctype !== 6) throw new Error(`需要 8-bit RGBA PNG，实际 depth=${depth} ctype=${ctype}`)
  const inflated = zlib.inflateSync(Buffer.concat(idat))
  const stride = 1 + w * 4
  const rgba = Buffer.alloc(w * h * 4)
  const bpp = 4
  let prev = Buffer.alloc(w * 4)
  for (let y = 0; y < h; y++) {
    const filter = inflated[y * stride]
    const row = Buffer.from(inflated.subarray(y * stride + 1, y * stride + 1 + w * 4))
    if (filter === 1) {
      for (let i = bpp; i < row.length; i++) row[i] = (row[i] + row[i - bpp]) & 255
    } else if (filter === 2) {
      for (let i = 0; i < row.length; i++) row[i] = (row[i] + prev[i]) & 255
    } else if (filter === 3) {
      for (let i = 0; i < row.length; i++) {
        const a = i >= bpp ? row[i - bpp] : 0
        row[i] = (row[i] + ((a + prev[i]) >> 1)) & 255
      }
    } else if (filter === 4) {
      for (let i = 0; i < row.length; i++) {
        const a = i >= bpp ? row[i - bpp] : 0
        const b = prev[i]
        const c = i >= bpp ? prev[i - bpp] : 0
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
    } else if (filter !== 0) {
      throw new Error(`不支持的 PNG filter ${filter}`)
    }
    row.copy(rgba, y * w * 4)
    prev = row
  }
  return { w, h, rgba }
}

/** 面积采样（盒滤波）+ 预乘 alpha，任意尺寸缩小都保持边缘抗锯齿。 */
function resizeRgba(src, sw, sh, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 4)
  const xRatio = sw / dw
  const yRatio = sh / dh
  for (let dy = 0; dy < dh; dy++) {
    const y0 = dy * yRatio
    const y1 = Math.min(sh, (dy + 1) * yRatio)
    const sy0 = Math.floor(y0)
    const sy1 = Math.min(sh, Math.ceil(y1))
    for (let dx = 0; dx < dw; dx++) {
      const x0 = dx * xRatio
      const x1 = Math.min(sw, (dx + 1) * xRatio)
      const sx0 = Math.floor(x0)
      const sx1 = Math.min(sw, Math.ceil(x1))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let area = 0
      for (let sy = sy0; sy < sy1; sy++) {
        const yOverlap = Math.min(y1, sy + 1) - Math.max(y0, sy)
        if (yOverlap <= 0) continue
        for (let sx = sx0; sx < sx1; sx++) {
          const xOverlap = Math.min(x1, sx + 1) - Math.max(x0, sx)
          if (xOverlap <= 0) continue
          const wgt = xOverlap * yOverlap
          const i = (sy * sw + sx) * 4
          const alpha = src[i + 3]
          r += src[i] * alpha * wgt
          g += src[i + 1] * alpha * wgt
          b += src[i + 2] * alpha * wgt
          a += alpha * wgt
          area += wgt
        }
      }
      const o = (dy * dw + dx) * 4
      if (a > 0 && area > 0) {
        dst[o] = Math.round(r / a)
        dst[o + 1] = Math.round(g / a)
        dst[o + 2] = Math.round(b / a)
        dst[o + 3] = Math.round(a / area)
      }
    }
  }
  return dst
}

function pngsToIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const dir = []
  const images = []
  let offset = 6 + 16 * entries.length
  for (const { size, png } of entries) {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size
    entry[1] = size >= 256 ? 0 : size
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    dir.push(entry)
    images.push(png)
    offset += png.length
  }
  return Buffer.concat([header, ...dir, ...images])
}

function writeResized(rgba, sw, sh, size, dest) {
  const out = sw === size && sh === size ? rgba : resizeRgba(rgba, sw, sh, size, size)
  const png = encodePng(size, size, out)
  fs.writeFileSync(dest, png)
  return png
}

function nearestScale(src, sw, sh, scale) {
  const dw = sw * scale
  const dh = sh * scale
  const dst = Buffer.alloc(dw * dh * 4)
  for (let y = 0; y < dh; y++) {
    const sy = Math.floor(y / scale) * sw
    for (let x = 0; x < dw; x++) {
      const si = (sy + Math.floor(x / scale)) * 4
      const di = (y * dw + x) * 4
      dst[di] = src[si]
      dst[di + 1] = src[si + 1]
      dst[di + 2] = src[si + 2]
      dst[di + 3] = src[si + 3]
    }
  }
  return { w: dw, h: dh, rgba: dst }
}

function fitRgba(src, sw, sh, maxSide) {
  const scale = maxSide / Math.max(sw, sh)
  const dw = Math.max(1, Math.round(sw * scale))
  const dh = Math.max(1, Math.round(sh * scale))
  return { w: dw, h: dh, rgba: resizeRgba(src, sw, sh, dw, dh) }
}

function alphaOver(dst, dw, dh, src, sw, sh, ox, oy) {
  for (let y = 0; y < sh; y++) {
    const ty = oy + y
    if (ty < 0 || ty >= dh) continue
    for (let x = 0; x < sw; x++) {
      const tx = ox + x
      if (tx < 0 || tx >= dw) continue
      const si = (y * sw + x) * 4
      const di = (ty * dw + tx) * 4
      const sa = src[si + 3] / 255
      if (sa <= 0) continue
      const da = dst[di + 3] / 255
      const outA = sa + da * (1 - sa)
      for (let c = 0; c < 3; c++) {
        dst[di + c] = Math.round((src[si + c] * sa + dst[di + c] * da * (1 - sa)) / (outA || 1))
      }
      dst[di + 3] = Math.round(outA * 255)
    }
  }
}

if (!fs.existsSync(srcMark)) throw new Error(`缺少原花标 ${srcMark}`)

const masterBg = path.join(os.tmpdir(), `vh-icon-bg-${process.pid}.png`)
try {
  renderSvg(bgSvg(), MASTER, masterBg)
  const bg = decodePng(fs.readFileSync(masterBg))
  const mark = decodePng(fs.readFileSync(srcMark))
  const hi = nearestScale(mark.rgba, mark.w, mark.h, 16)
  const flowerBox = Math.round(MASTER * (192 / 256))
  const fitted = fitRgba(hi.rgba, hi.w, hi.h, flowerBox)
  const canvas = Buffer.from(bg.rgba)
  const ox = Math.round((bg.w - fitted.w) / 2)
  const oy = Math.round((bg.h - fitted.h) / 2)
  alphaOver(canvas, bg.w, bg.h, fitted.rgba, fitted.w, fitted.h, ox, oy)

  writeResized(canvas, bg.w, bg.h, 1024, path.join(outDir, 'icon.png'))
  writeResized(canvas, bg.w, bg.h, 512, path.join(outDir, 'icon-512.png'))

  const icoEntries = ICO_SIZES.map((size) => ({
    size,
    png: writeResized(canvas, bg.w, bg.h, size, path.join(os.tmpdir(), `vh-ico-${size}-${process.pid}.png`)),
  }))
  fs.writeFileSync(path.join(outDir, 'icon.ico'), pngsToIco(icoEntries))
  for (const { size } of icoEntries) {
    try {
      fs.unlinkSync(path.join(os.tmpdir(), `vh-ico-${size}-${process.pid}.png`))
    } catch {
      /* ignore */
    }
  }

  const markHi = fitRgba(hi.rgba, hi.w, hi.h, 512)
  const markCanvas = Buffer.alloc(512 * 512 * 4)
  alphaOver(markCanvas, 512, 512, markHi.rgba, markHi.w, markHi.h, Math.round((512 - markHi.w) / 2), Math.round((512 - markHi.h) / 2))
  fs.writeFileSync(path.join(outDir, 'valimart-mark.png'), encodePng(512, 512, markCanvas))
  if (fs.existsSync(srcWord)) fs.copyFileSync(srcWord, path.join(outDir, 'valimart-wordmark.png'))

  const iconStat = fs.statSync(path.join(outDir, 'icon.png'))
  const icoStat = fs.statSync(path.join(outDir, 'icon.ico'))
  console.log(
    `[icon] 原花标 ${mark.w}×${mark.h} → icon.png 1024 (${iconStat.size} B), icon.ico ${ICO_SIZES.join('/')} (${icoStat.size} B)`,
  )
} finally {
  try {
    fs.unlinkSync(masterBg)
  } catch {
    /* ignore */
  }
}
