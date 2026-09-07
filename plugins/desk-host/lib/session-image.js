import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_BYTES = 32 * 1024 * 1024
const fail = (status, message) => Object.assign(new Error(message), { status, code: 'session_image' })

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return 'image/gif'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.toString('ascii', 0, 2) === 'BM') return 'image/bmp'
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && /^(avif|avis)$/.test(bytes.toString('ascii', 8, 12))) return 'image/avif'
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(bytes.toString('utf8', 0, 4096).replace(/^\uFEFF/, ''))) return 'image/svg+xml'
  throw fail(415, '文件不是支持的图片（PNG、JPEG、GIF、WebP、BMP、AVIF、SVG）')
}

/** Read only images inside this session's real workspace; resolve symlinks before authorizing. */
export async function readSessionImage(session, source) {
  if (!session?.header?.cwd) throw fail(404, '会话不存在或没有工作目录')
  if (typeof source !== 'string' || !source || source.includes('\0')) throw fail(400, '缺少有效图片路径')
  let local = source
  if (/^file:/i.test(local)) {
    try { local = fileURLToPath(local) } catch { throw fail(400, '图片文件地址无效') }
  } else {
    try { local = decodeURIComponent(local) } catch { /* literal percent in file name */ }
    if (/^[a-z][a-z\d+.-]*:/i.test(local) && !/^[a-z]:[\\/]/i.test(local)) throw fail(400, '只接受本地图片路径')
  }
  try {
    const root = await fs.realpath(session.header.cwd)
    const file = await fs.realpath(path.resolve(root, local))
    const rel = path.relative(root, file)
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw fail(403, '图片不在当前会话工作目录内')
    const handle = await fs.open(file, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw fail(415, '图片路径不是文件')
      if (stat.size > MAX_BYTES) throw fail(413, '图片超过 32MB')
      const buffer = Buffer.alloc(stat.size + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > stat.size) throw fail(409, '图片正在写入，请稍后重试')
      const bytes = buffer.subarray(0, length)
      return { bytes, contentType: imageType(bytes), file }
    } finally { await handle.close() }
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw fail(404, '图片文件不存在')
    if (err.code === 'EACCES' || err.code === 'EPERM') throw fail(403, '没有权限读取图片')
    throw err
  }
}

export async function serveSessionImage(req, res, { loggedIn, session, source, info = false }) {
  // Unlike general desk endpoints, image reads require an explicit same-origin browser request.
  if (!loggedIn) throw fail(401, '请先登录')
  if (req.headers['sec-fetch-site'] !== 'same-origin') throw fail(403, '图片只允许当前工作台读取')
  const { bytes, contentType, file } = await readSessionImage(session, source)
  if (info) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    return res.end(JSON.stringify({ file }))
  }
  res.writeHead(200, {
    'content-type': contentType, 'content-length': bytes.length,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
  })
  res.end(bytes)
}
