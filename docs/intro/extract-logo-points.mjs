import fs from 'node:fs'
import zlib from 'node:zlib'

const buf = fs.readFileSync(new URL('../../plugins/desk-ui/src/client/assets/valimart-mark.png', import.meta.url))
let off = 8, width = 0, height = 0, idats = []
while (off + 12 <= buf.length) {
  const len = buf.readUInt32BE(off)
  const type = buf.subarray(off + 4, off + 8).toString('ascii')
  const data = buf.subarray(off + 8, off + 8 + len)
  if (type === 'IHDR') {
    width = data.readUInt32BE(0)
    height = data.readUInt32BE(4)
  } else if (type === 'IDAT') idats.push(data)
  else if (type === 'IEND') break
  off += 12 + len
}
const raw = zlib.inflateSync(Buffer.concat(idats))
const bpp = 4, stride = width * bpp
const pixels = Buffer.alloc(height * stride)
let src = 0, prev = Buffer.alloc(stride)
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
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      x = (x + pr) & 255
    }
    out[i] = x
  }
  out.copy(pixels, y * stride)
  prev = out
}

let minX = width, minY = height, maxX = 0, maxY = 0
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4 + 3] < 40) continue
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
}
const cx = (minX + maxX) / 2
const cy = (minY + maxY) / 2
const rad = Math.max(maxX - minX, maxY - minY) / 2

const pts = []
const step = 2
for (let y = minY; y <= maxY; y += step) {
  for (let x = minX; x <= maxX; x += step) {
    if (pixels[(y * width + x) * 4 + 3] < 96) continue
    pts.push([+((x - cx) / rad).toFixed(4), +((y - cy) / rad).toFixed(4)])
  }
}
fs.writeFileSync(new URL('./logo-points.json', import.meta.url), JSON.stringify(pts))
fs.copyFileSync(
  new URL('../../plugins/desk-ui/src/client/assets/valimart-mark.png', import.meta.url),
  new URL('./mark.png', import.meta.url),
)
console.log('points', pts.length, 'bounds', minX, minY, maxX, maxY)
