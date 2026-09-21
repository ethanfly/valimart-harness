/**
 * 把惠利玛花标 PNG 压成小 RGBA 网格，给 TUI 半块渲染用。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const SRC = new URL('../assets/valimart-mark.png', import.meta.url)
const OUT = new URL('../assets/mark-grid.json', import.meta.url)
const TARGET = 24

function readPng(buf) {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not png')
  let off = 8
  let width = 0
  let height = 0
  const idats = []
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.subarray(off + 4, off + 8).toString('ascii')
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 6) throw new Error(`need 8-bit RGBA, got bit=${data[8]} ct=${data[9]}`)
    } else if (type === 'IDAT') idats.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idats))
  const bpp = 4
  const stride = width * bpp
  const pixels = Buffer.alloc(height * stride)
  let src = 0
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[src++]
    const row = raw.subarray(src, src + stride)
    src += stride
    const out = Buffer.alloc(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let x = row[i]
      if (filter === 1) x = (x + a) & 255
      else if (filter === 2) x = (x + b) & 255
      else if (filter === 3) x = (x + Math.floor((a + b) / 2)) & 255
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        x = (x + pr) & 255
      } else if (filter !== 0) throw new Error(`filter ${filter}`)
      out[i] = x
    }
    out.copy(pixels, y * stride)
    prev = out
  }
  return { width, height, pixels }
}

function opaqueBounds({ width, height, pixels }, minA = 40) {
  let x0 = width
  let y0 = height
  let x1 = 0
  let y1 = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] < minA) continue
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
  }
  if (x1 < x0) return { x0: 0, y0: 0, x1: width - 1, y1: height - 1 }
  const pad = 1
  return {
    x0: Math.max(0, x0 - pad),
    y0: Math.max(0, y0 - pad),
    x1: Math.min(width - 1, x1 + pad),
    y1: Math.min(height - 1, y1 + pad),
  }
}

/** 最近邻 + 透明度阈值：保住花瓣边缘，不要平均成一团。 */
function sample({ width, height, pixels }, size) {
  const b = opaqueBounds({ width, height, pixels })
  const bw = b.x1 - b.x0 + 1
  const bh = b.y1 - b.y0 + 1
  const out = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = b.x0 + Math.min(bw - 1, Math.floor(((x + 0.5) * bw) / size))
      const sy = b.y0 + Math.min(bh - 1, Math.floor(((y + 0.5) * bh) / size))
      const i = (sy * width + sx) * 4
      const a = pixels[i + 3]
      if (a < 96) {
        out.push(0, 0, 0, 0)
        continue
      }
      out.push(pixels[i], pixels[i + 1], pixels[i + 2], a)
    }
  }
  return Buffer.from(out)
}

const png = readPng(fs.readFileSync(SRC))
const grid = sample(png, TARGET)
const json = {
  w: TARGET,
  h: TARGET,
  rgba: grid.toString('base64'),
}
const outPath = fileURLToPath(OUT)
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(json))
console.log(`wrote ${outPath} ${TARGET}x${TARGET} from ${png.width}x${png.height}`)
