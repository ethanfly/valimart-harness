#!/usr/bin/env node
/**
 * 生视频 —— 公司网关 /v1/videos/generations，模型固定 grok-imagine-video-1.5。
 * 生图/修图走 image_generate / image_edit（desk-image 插件，按「设置 → 生图」），或本目录 generate.mjs。
 *
 *   node scripts/generate-video.mjs --prompt "..." [--out out.mp4] [--duration 6] [--ratio 16:9]
 *   node scripts/generate-video.mjs --prompt "..." --image first.png --out shot.mp4
 *
 * 令牌：DESK_GATEWAY_TOKEN 或 ~/.dsh/desk/desk-state.json 的 gatewayToken。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const VIDEO_MODEL = 'grok-imagine-video-1.5'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return fallback
}

function loadDeskState() {
  const p = path.join(os.homedir(), '.dsh', 'desk', 'desk-state.json')
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return {}
  }
}

function parseDataUrl(s) {
  const m = /^data:(?:video|image)\/[^;]+;base64,(.+)$/i.exec(String(s))
  return m ? m[1] : String(s)
}

function stampName(now = new Date()) {
  const iso = now.toISOString()
  return `video-${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`
}

const prompt = arg('--prompt')
if (!prompt) {
  console.error('缺少 --prompt')
  process.exit(2)
}

const desk = loadDeskState()
const token = process.env.DESK_GATEWAY_TOKEN || desk.gatewayToken
const base = (process.env.DESK_GATEWAY_URL || desk.gatewayUrl || 'http://127.0.0.1:8790').replace(/\/+$/, '')
if (!token) {
  console.error('找不到网关令牌：请登录工作台，或设置 DESK_GATEWAY_TOKEN')
  process.exit(2)
}

const model = arg('--model', VIDEO_MODEL)
const ratio = arg('--ratio', '16:9')
const out = path.resolve(arg('--out', `${stampName()}.mp4`))
const image = arg('--image')
let duration = Number(arg('--duration', '6')) || 6
if (duration <= 8) duration = 6
else duration = 10

console.error(`模型=${model} 比例=${ratio} 时长=${duration}s`)

const body = { model, prompt, duration, aspect_ratio: ratio }
if (image) body.image = fs.readFileSync(image).toString('base64')

const res = await fetch(base + '/v1/videos/generations', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const text = await res.text()
let json
try {
  json = JSON.parse(text)
} catch {
  console.error('网关返回非 JSON HTTP ' + res.status + ': ' + text.slice(0, 400))
  process.exit(1)
}
if (!res.ok) {
  console.error('视频生成失败 HTTP ' + res.status + ': ' + (json.error?.message || json.error || text.slice(0, 400)))
  process.exit(1)
}

const items = Array.isArray(json.data) ? json.data : json.video ? [json.video] : []
if (!items.length) {
  console.error('上游没有返回视频：' + text.slice(0, 400))
  process.exit(1)
}

const item = items[0]
fs.mkdirSync(path.dirname(out), { recursive: true })
if (item.b64_json) {
  fs.writeFileSync(out, Buffer.from(parseDataUrl(item.b64_json), 'base64'))
} else if (item.url) {
  const vid = await fetch(item.url)
  if (!vid.ok) {
    console.error('下载失败 ' + item.url + ' HTTP ' + vid.status)
    process.exit(1)
  }
  fs.writeFileSync(out, Buffer.from(await vid.arrayBuffer()))
} else {
  console.error('条目缺少 b64_json / url')
  process.exit(1)
}
console.log(out)
