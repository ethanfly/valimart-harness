/**
 * 生成 macOS 图标 .icns（零依赖）。
 *
 * 现代 macOS（10.7+）的 icns 允许直接内嵌 PNG（ic07~ic14 这些类型就是 PNG 载荷），
 * 所以不需要 Apple 私有的 ARGB 编码器：把 sharp 缩放出来的各尺寸 PNG 按类型塞进去即可。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 类型 → 像素边长。同一个尺寸会被多个类型复用（1x / 2x）。 */
const TYPE_SIZES = [
  ['ic11', 32], // 16pt @2x
  ['ic12', 64], // 32pt @2x
  ['ic07', 128], // 128pt
  ['ic13', 256], // 128pt @2x
  ['ic08', 256], // 256pt
  ['ic14', 512], // 256pt @2x
  ['ic09', 512], // 512pt
  ['ic10', 1024], // 512pt @2x
]

/**
 * @param {Map<number, Buffer>|Record<number, Buffer>} pngs 边长 → PNG 字节
 * @returns {Buffer} .icns 内容
 */
export function buildIcns(pngs) {
  const get = (size) => (pngs instanceof Map ? pngs.get(size) : pngs[size])
  const chunks = []
  for (const [type, size] of TYPE_SIZES) {
    const png = get(size)
    if (png === undefined) continue
    if (!Buffer.isBuffer(png)) throw new Error(`buildIcns：${size}px 不是 Buffer（忘了 await sharp.toBuffer()？）`)
    const head = Buffer.alloc(8)
    head.write(type, 0, 4, 'ascii')
    head.writeUInt32BE(8 + png.length, 4)
    chunks.push(head, png)
  }
  if (!chunks.length) throw new Error('buildIcns：至少要有一个尺寸的 PNG')
  const body = Buffer.concat(chunks)
  const out = Buffer.alloc(8)
  out.write('icns', 0, 4, 'ascii')
  out.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([out, body])
}

export function writeIcns(file, pngs) {
  const buf = buildIcns(pngs)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buf)
  return buf
}
