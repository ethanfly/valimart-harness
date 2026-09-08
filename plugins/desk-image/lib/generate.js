/**
 * 经公司网关调用 OpenAI 兼容 /v1/images/generations|edits，把图片写到会话工作目录。
 */
import fs from 'node:fs'
import path from 'node:path'

const MAX_N = 4
const DEFAULT_TIMEOUT_MS = 180_000

export function sniffImage(bytes) {
  if (!bytes || bytes.length < 12) return null
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { mime: 'image/png', ext: '.png' }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' }
  if (/^GIF8[79]a/.test(buf.toString('ascii', 0, 6))) return { mime: 'image/gif', ext: '.gif' }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp' }
  return null
}

export function parseDataUrl(s) {
  const m = /^data:image\/[^;]+;base64,(.+)$/i.exec(String(s ?? ''))
  return m ? m[1] : String(s ?? '')
}

export function readImageB64(source) {
  if (source == null || source === '') throw Object.assign(new Error('缺少参考图'), { status: 400, code: 'missing_image' })
  if (typeof source !== 'string') throw Object.assign(new Error('参考图必须是路径或 base64'), { status: 400, code: 'bad_image' })
  if (/^data:image\//i.test(source) || (source.length > 200 && !/[/\\]/.test(source) && !/\.(png|jpe?g|gif|webp)$/i.test(source))) {
    return parseDataUrl(source)
  }
  const file = path.resolve(source)
  if (!fs.existsSync(file)) throw Object.assign(new Error(`参考图不存在：${source}`), { status: 404, code: 'missing_image' })
  return fs.readFileSync(file).toString('base64')
}

export function assertInside(root, target) {
  const base = path.resolve(root)
  const file = path.resolve(target)
  const rel = path.relative(base, file)
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw Object.assign(new Error('路径不在当前会话工作目录内'), { status: 403, code: 'path_escape' })
  }
  return file
}

export function stampName(now = new Date()) {
  const iso = now.toISOString()
  return `image-${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`
}

export function destPath(cwd, out, index, total, bytes, now) {
  const fallback = stampName(now) + (total > 1 ? `-${index + 1}` : '')
  let requested = String(out ?? '').trim() || fallback
  if (total > 1 && out) requested = requested.replace(/(\.[A-Za-z0-9]+)?$/, (m) => `-${index + 1}${m || ''}`)
  const abs = path.isAbsolute(requested) ? requested : path.resolve(cwd, requested)
  const sniffed = sniffImage(bytes)
  const ext = sniffed?.ext || path.extname(abs) || '.png'
  const withExt = path.extname(abs) ? abs.replace(/\.[A-Za-z0-9]+$/, ext) : abs + ext
  const dest = assertInside(cwd, withExt)
  if (!fs.existsSync(dest)) return dest
  const stem = dest.slice(0, dest.length - ext.length)
  for (let i = 2; ; i++) {
    const cand = `${stem} (${i})${ext}`
    if (!fs.existsSync(cand)) return cand
  }
}

export async function callGatewayImages({
  gatewayUrl,
  token,
  model,
  prompt,
  n = 1,
  aspectRatio = '1:1',
  image,
  images,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
}) {
  const base = String(gatewayUrl ?? '').replace(/\/+$/, '')
  if (!base) throw Object.assign(new Error('未配置公司网关'), { status: 400, code: 'no_gateway' })
  if (!token) throw Object.assign(new Error('未登录公司网关'), { status: 401, code: 'unauthenticated' })
  const text = String(prompt ?? '').trim()
  if (!text) throw Object.assign(new Error('缺少 prompt'), { status: 400, code: 'missing_prompt' })
  if (!model) throw Object.assign(new Error('公司目录里没有可用的生图模型。请在网关接入 GPT / Qwen / Grok 等通道，或在设置 → 生图里填写模型 id。'), { status: 404, code: 'model_not_found' })

  const count = Math.max(1, Math.min(MAX_N, Number(n) || 1))
  const edit = image != null || (Array.isArray(images) && images.length)
  const apiPath = edit ? '/v1/images/edits' : '/v1/images/generations'
  const body = { model, prompt: text, n: count, aspect_ratio: aspectRatio, response_format: 'b64_json' }
  if (edit) {
    if (image != null) body.image = typeof image === 'string' && image.length > 64 && !/[/\\]/.test(image) ? parseDataUrl(image) : image
    if (Array.isArray(images) && images.length) body.images = images
  }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  if (signal) {
    if (signal.aborted) ac.abort()
    else signal.addEventListener('abort', () => ac.abort(), { once: true })
  }
  let res
  try {
    res = await fetchImpl(`${base}${apiPath}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw Object.assign(new Error('生图超时，请稍后重试'), { status: 504, code: 'timeout' })
    throw Object.assign(new Error(`无法连接公司网关：${err.message}`), { status: 502, code: 'unreachable' })
  } finally {
    clearTimeout(timer)
  }

  const raw = await res.text()
  let json
  try {
    json = JSON.parse(raw)
  } catch {
    throw Object.assign(new Error(`网关返回非 JSON HTTP ${res.status}：${raw.slice(0, 240)}`), { status: res.status || 502, code: 'bad_upstream' })
  }
  if (!res.ok) {
    const msg = json.error?.message || json.error || raw.slice(0, 240)
    throw Object.assign(new Error(typeof msg === 'string' ? msg : `生图失败 HTTP ${res.status}`), { status: res.status, code: json.error?.code ?? 'gateway_error' })
  }
  const items = Array.isArray(json.data) ? json.data : []
  if (!items.length) throw Object.assign(new Error('上游没有返回图片'), { status: 502, code: 'empty' })
  return { json, items, model, edit }
}

export async function writeImageItems({ cwd, out, items, fetchImpl = globalThis.fetch }) {
  const written = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    let bytes
    if (item.b64_json) bytes = Buffer.from(parseDataUrl(item.b64_json), 'base64')
    else if (item.url) {
      const img = await fetchImpl(item.url)
      if (!img.ok) throw Object.assign(new Error(`下载失败 HTTP ${img.status}`), { status: 502, code: 'download_failed' })
      bytes = Buffer.from(await img.arrayBuffer())
    } else {
      throw Object.assign(new Error('条目缺少 b64_json / url'), { status: 502, code: 'empty' })
    }
    const dest = destPath(cwd, out, i, items.length, bytes)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, bytes)
    written.push({
      path: dest,
      rel: path.relative(cwd, dest).replace(/\\/g, '/'),
      bytes: bytes.length,
      kind: sniffImage(bytes)?.mime ?? 'application/octet-stream',
    })
  }
  return written
}
