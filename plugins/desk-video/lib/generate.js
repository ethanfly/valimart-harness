/**
 * 经公司网关调用 /v1/videos/generations，把视频写到会话工作目录。
 * 长视频按模型单段上限拆成多段，逐段生成后用 ffmpeg 拼接。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { MAX_DURATION, MAX_IMAGES, planSegments, segmentCap } from './models.js'

const DEFAULT_TIMEOUT_MS = 600_000
const POLL_MS = 4_000

export function parseDataUrl(s) {
  const m = /^data:(?:video|image)\/[^;]+;base64,(.+)$/i.exec(String(s ?? ''))
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
  return `video-${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`
}

export function destPath(cwd, out, now) {
  const requested = String(out ?? '').trim() || `${stampName(now)}.mp4`
  const abs = path.isAbsolute(requested) ? requested : path.resolve(cwd, requested)
  const ext = path.extname(abs) || '.mp4'
  const withExt = path.extname(abs) ? abs : abs + ext
  const dest = assertInside(cwd, withExt)
  if (!fs.existsSync(dest)) return dest
  const stem = dest.slice(0, dest.length - ext.length)
  for (let i = 2; ; i++) {
    const cand = `${stem} (${i})${ext}`
    if (!fs.existsSync(cand)) return cand
  }
}

function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, code })
}

async function readJsonResponse(res) {
  const raw = await res.text()
  let json
  try {
    json = JSON.parse(raw)
  } catch {
    fail(res.status || 502, `网关返回非 JSON HTTP ${res.status}：${raw.slice(0, 240)}`, 'bad_upstream')
  }
  if (!res.ok) {
    const msg = json.error?.message || json.error || raw.slice(0, 240)
    fail(res.status, typeof msg === 'string' ? msg : `生视频失败 HTTP ${res.status}`, json.error?.code ?? 'gateway_error')
  }
  return json
}

function pickItem(json) {
  if (Array.isArray(json?.data) && json.data.length) return json.data[0]
  if (json?.video && typeof json.video === 'object') return json.video
  return null
}

function isPending(json, item) {
  const status = String(json?.status ?? item?.status ?? '').toLowerCase()
  return status === 'queued' || status === 'pending' || status === 'processing' || status === 'running' || status === 'in_progress'
}

/**
 * 提交一次生成。同步上游直接给 url / b64；异步上游给 task id，再轮询到完成。
 * ponytail: 轮询固定间隔，没有指数退避；任务量大了再加。
 */
export async function callGatewayVideo({
  gatewayUrl,
  token,
  model,
  prompt,
  duration,
  aspectRatio,
  images,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = POLL_MS,
  signal,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const base = String(gatewayUrl ?? '').replace(/\/+$/, '')
  if (!base) fail(400, '未配置公司网关', 'no_gateway')
  if (!token) fail(401, '未登录公司网关', 'unauthenticated')
  const text = String(prompt ?? '').trim()
  if (!text) fail(400, '缺少 prompt', 'missing_prompt')
  if (!model) fail(404, '公司目录里没有可用的视频模型。请在网关接入万相 / MiniMax / Grok / Sora / Seedance，或在设置 → 生视频里填写模型 id。', 'model_not_found')

  const body = { model, prompt: text, duration, aspect_ratio: aspectRatio }
  const refs = (Array.isArray(images) ? images : []).filter(Boolean).slice(0, MAX_IMAGES)
  if (refs.length) {
    body.image = refs[0]
    body.images = refs
  }

  const deadline = Date.now() + timeoutMs
  const post = async (apiPath, payload) => {
    const ac = new AbortController()
    const left = Math.max(1_000, deadline - Date.now())
    const timer = setTimeout(() => ac.abort(), left)
    if (signal) {
      if (signal.aborted) ac.abort()
      else signal.addEventListener('abort', () => ac.abort(), { once: true })
    }
    let res
    try {
      res = await fetchImpl(`${base}${apiPath}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ac.signal,
      })
    } catch (err) {
      if (err?.name === 'AbortError') fail(504, '生视频超时，请稍后重试', 'timeout')
      fail(502, `无法连接公司网关：${err.message}`, 'unreachable')
    } finally {
      clearTimeout(timer)
    }
    return readJsonResponse(res)
  }

  let json = await post('/v1/videos/generations', body)
  let item = pickItem(json)
  const taskId = String(json?.id ?? item?.id ?? '')
  while ((!item || (!item.url && !item.b64_json)) && taskId && isPending(json, item) && Date.now() < deadline) {
    await sleep(pollMs)
    if (signal?.aborted) fail(504, '生视频已取消', 'timeout')
    json = await post('/v1/videos/retrieve', { model, id: taskId })
    item = pickItem(json)
  }
  if (!item || (!item.url && !item.b64_json)) fail(502, '上游没有返回视频', 'empty')
  return { json, item, model }
}

export async function writeVideoItem({ cwd, out, item, fetchImpl = globalThis.fetch }) {
  let bytes
  if (item.b64_json) bytes = Buffer.from(parseDataUrl(item.b64_json), 'base64')
  else if (item.url) {
    const vid = await fetchImpl(item.url)
    if (!vid.ok) fail(502, `下载失败 HTTP ${vid.status}`, 'download_failed')
    bytes = Buffer.from(await vid.arrayBuffer())
  } else {
    fail(502, '条目缺少 b64_json / url', 'empty')
  }
  const dest = destPath(cwd, out)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, bytes)
  return {
    path: dest,
    rel: path.relative(cwd, dest).replace(/\\/g, '/'),
    bytes: bytes.length,
    kind: 'video/mp4',
  }
}

/** 取一段视频的最后一帧，作为下一段的首帧。调用方传入 execFile 以便测试替换。 */
export function lastFrame(video, dest, exec = execFile, bin = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    exec(bin, ['-y', '-sseof', '-0.1', '-i', video, '-frames:v', '1', dest], (err, _stdout, stderr) => {
      if (err) {
        const missing = err.code === 'ENOENT'
        reject(Object.assign(new Error(missing ? '本机没有 ffmpeg' : String(stderr || err.message).slice(0, 200)), { status: 500, code: missing ? 'ffmpeg_missing' : 'frame_failed' }))
        return
      }
      resolve(dest)
    })
  })
}

/**
 * 本机没有 ffmpeg 时用 winget 装一个。装完写进进程 PATH，当前这次生成就能用。
 * ponytail: 只试 winget 官方 Gyan 包；装失败就保持各段分开，不重试。
 */
function ffmpegOnDisk() {
  const base = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages')
  if (!fs.existsSync(base)) return ''
  for (const dir of fs.readdirSync(base)) {
    if (!dir.startsWith('Gyan.FFmpeg')) continue
    const bin = path.join(base, dir)
    const hit = fs.readdirSync(bin, { recursive: true }).find((f) => String(f).endsWith(`${path.sep}ffmpeg.exe`) || String(f) === 'ffmpeg.exe')
    if (hit) return path.join(bin, hit)
  }
  return ''
}

export function ensureFfmpeg(exec = execFile) {
  return new Promise((resolve) => {
    const use = (bin) => { process.env.PATH = `${path.dirname(bin)};${process.env.PATH ?? ''}`; resolve(bin) }
    exec('ffmpeg', ['-version'], (err) => {
      if (!err) { resolve('ffmpeg'); return }
      const found = ffmpegOnDisk()
      if (found) { use(found); return }
      if (err.code !== 'ENOENT' || process.platform !== 'win32') { resolve(''); return }
      exec('winget', ['install', '--id', 'Gyan.FFmpeg', '-e', '--silent',
        '--accept-package-agreements', '--accept-source-agreements'], (installErr) => {
        const after = installErr ? '' : ffmpegOnDisk()
        if (after) use(after)
        else resolve('')
      })
    })
  })
}

/** ffmpeg concat demuxer。调用方传入 execFile 以便测试替换。 */
export function concatVideos(files, dest, exec = execFile, bin = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const list = path.join(path.dirname(files[0]), 'concat.txt')
    const body = files.map((f) => `file '${f.replace(/'/g, `'\\''`)}'`).join('\n')
    fs.writeFileSync(list, body)
    exec(bin, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', dest], (err, _stdout, stderr) => {
      fs.rmSync(list, { force: true })
      if (err) {
        const detail = String(stderr || err.message || err.code || '').trim().slice(0, 240)
        const missing = err.code === 'ENOENT'
        reject(Object.assign(new Error(missing ? '本机没有 ffmpeg，长视频各段已分别保存。' : `拼接失败：${detail}`), { status: 500, code: missing ? 'ffmpeg_missing' : 'concat_failed' }))
        return
      }
      resolve(dest)
    })
  })
}

/**
 * 一次完整生成：时长不超过单段上限就一发；否则逐段生成再拼接。
 * 第二段起用上一段的尾帧当首帧，用户的参考图继续作为参考。
 */
export async function generateVideo({
  gatewayUrl,
  token,
  model,
  prompt,
  duration,
  aspectRatio,
  images,
  cwd,
  out,
  longForm = true,
  fetchImpl,
  timeoutMs,
  signal,
  sleep,
  exec,
}) {
  const total = Math.max(1, Math.min(MAX_DURATION, Math.round(Number(duration) || 6)))
  const cap = segmentCap(model)
  const parts = longForm ? planSegments(total, cap) : [Math.min(total, cap)]
  const ffmpegBin = parts.length > 1 ? await ensureFfmpeg(exec) : ''
  const written = []
  let carry = null
  for (let i = 0; i < parts.length; i++) {
    const segPrompt = parts.length === 1
      ? prompt
      : `${prompt}\n（第 ${i + 1}/${parts.length} 段，第一张图是上一段的尾帧，从它继续，保持同一场景、同一主体。）`
    const segOut = parts.length === 1 ? (out || 'videos/video.mp4') : path.join('videos', `part-${i + 1}-${path.basename(out || 'video.mp4')}`)
    const segImages = [...(i === 0 ? [] : [carry]), ...(images ?? [])].filter(Boolean).slice(0, MAX_IMAGES)
    const { item, model: used } = await callGatewayVideo({
      gatewayUrl, token, model, prompt: segPrompt, duration: parts[i], aspectRatio,
      images: segImages, fetchImpl, timeoutMs, signal, sleep,
    })
    const file = await writeVideoItem({ cwd, out: segOut, item, fetchImpl })
    file.model = used
    written.push(file)
    if (i < parts.length - 1) {
      const frame = path.join(cwd, `.frame-${i + 1}.png`)
      try {
        await lastFrame(file.path, frame, exec, ffmpegBin || 'ffmpeg')
        carry = fs.readFileSync(frame).toString('base64')
      } catch { carry = null }
      fs.rmSync(frame, { force: true })
    }
  }
  if (written.length === 1) return { written, segments: parts, model }
  const final = destPath(cwd, out)
  try {
    await concatVideos(written.map((f) => f.path), final, exec, ffmpegBin || 'ffmpeg')
  } catch (err) {
    if (err.code !== 'ffmpeg_missing') throw err
    return { written, segments: parts, model, note: err.message }
  }
  for (const f of written) fs.rmSync(f.path, { force: true })
  fs.rmSync(path.dirname(written[0].path), { recursive: true, force: true })
  return {
    written: [{
      path: final,
      rel: path.relative(cwd, final).replace(/\\/g, '/'),
      bytes: fs.statSync(final).size,
      kind: 'video/mp4',
      model,
    }],
    segments: parts,
    model,
  }
}
