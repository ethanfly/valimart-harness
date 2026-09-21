/**
 * 把惠利玛花标 PNG 压成小 RGBA 网格，给 TUI 半块渲染用。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const SRC = new URL('../assets/valimart-mark.png', import.meta.url)
const OUT = new URL('../assets/mark-grid.json', import.meta.url)
const TARGET = 10

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

function sample({ width, height, pixels }, size) {
  const out = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor((x * width) / size)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / size))
      const y0 = Math.floor((y * height) / size)
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / size))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * width + xx) * 4
          const aa = pixels[i + 3]
          r += pixels[i] * aa
          g += pixels[i + 1] * aa
          b += pixels[i + 2] * aa
          a += aa
          n++
        }
      }
      if (!n || a < 8 * n) {
        out.push(0, 0, 0, 0)
        continue
      }
      out.push(Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / n))
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
