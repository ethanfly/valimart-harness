#!/usr/bin/env node
/**
 * 通过公司网关调用 Grok Imagine 生图 / 修图，把 PNG 写到磁盘。
 *
 *   node scripts/generate.mjs --prompt "..." [--out out.png] [--ratio 1:1] [--model grok-imagine-image-2.0]
 *   node scripts/generate.mjs --prompt "..." --edit ref.png --out edited.png
 *
 * 令牌：环境变量 DESK_GATEWAY_TOKEN，或 ~/.dsh/desk/desk-state.json 的 gatewayToken。
 * 基址：DESK_GATEWAY_URL，或 desk-state.json 的 gatewayUrl，默认 http://127.0.0.1:8790。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  const m = /^data:image\/[^;]+;base64,(.+)$/i.exec(String(s))
  return m ? m[1] : String(s)
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

const model = arg('--model', 'grok-imagine-image-2.0')
const ratio = arg('--ratio', '1:1')
const out = arg('--out', 'grok-imagine.png')
const edit = arg('--edit')
const n = Number(arg('--n', '1')) || 1

const body = { model, prompt, n, aspect_ratio: ratio, response_format: 'b64_json' }
let apiPath = '/v1/images/generations'
if (edit) {
  apiPath = '/v1/images/edits'
  body.image = fs.readFileSync(edit).toString('base64')
}

const res = await fetch(base + apiPath, {
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
  console.error('生图失败 HTTP ' + res.status + ': ' + (json.error?.message || json.error || text.slice(0, 400)))
  process.exit(1)
}

const items = Array.isArray(json.data) ? json.data : []
if (!items.length) {
  console.error('上游没有返回图片：' + text.slice(0, 400))
  process.exit(1)
}

const written = []
for (let i = 0; i < items.length; i++) {
  const item = items[i]
  const dest = items.length === 1 ? out : out.replace(/(\.[A-Za-z0-9]+)$/, '-' + (i + 1) + '$1')
  if (item.b64_json) {
    fs.writeFileSync(dest, Buffer.from(parseDataUrl(item.b64_json), 'base64'))
  } else if (item.url) {
    const img = await fetch(item.url)
    if (!img.ok) {
      console.error('下载失败 ' + item.url + ' HTTP ' + img.status)
      process.exit(1)
    }
    fs.writeFileSync(dest, Buffer.from(await img.arrayBuffer()))
  } else {
    console.error('条目缺少 b64_json / url')
    process.exit(1)
  }
  written.push(path.resolve(dest))
}
console.log(written.join('\n'))
