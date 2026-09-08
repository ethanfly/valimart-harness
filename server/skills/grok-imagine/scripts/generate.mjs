#!/usr/bin/env node
/**
 * 生图 / 修图 —— 按「设置 → 生图」（desk-image 插件）的配置走公司网关。
 *
 *   node scripts/generate.mjs --prompt "..." [--out out.jpg] [--ratio 1:1] [--model gpt|qwen|grok|真实id]
 *   node scripts/generate.mjs --prompt "..." --edit ref.png --out edited.jpg
 *
 * 模型优先级：--model → 插件配置 resolvedDefault → 设置里的 defaultModel → 公司目录第一个生图模型。
 * 比例优先级：--ratio → 设置里的 aspectRatio → 1:1。
 * 配置来源：GET {DESK_IMAGE_CONFIG_URL} → ~/.dsh/settings.yaml 的 desk-image 段 → 内置兜底。
 * 令牌：DESK_GATEWAY_TOKEN，或 ~/.dsh/desk/desk-state.json 的 gatewayToken（不是 sessionToken）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4']
const DEFAULT_RATIO = '1:1'
const CONFIG_URL = process.env.DESK_IMAGE_CONFIG_URL || 'http://127.0.0.1:3470/desk/api/image/config'
const CONFIG_TIMEOUT_MS = Number(process.env.DESK_IMAGE_CONFIG_TIMEOUT_MS || 2000)
const SETTINGS_FILE = process.env.DSH_SETTINGS_FILE || path.join(os.homedir(), '.dsh', 'settings.yaml')
const PLUGIN_MODELS = process.env.DESK_IMAGE_MODELS_PATH || path.join(os.homedir(), '.company-desk', 'app', 'plugins', 'desk-image', 'lib', 'models.js')

/* ---------- 兜底解析器：读不到插件 models.js 时用这份最小副本（顺序与 desk-image/lib/models.js 一致） ---------- */
const IMAGE_MODEL_RE = /imagine-image|dall-e|gpt-image|flux|qwen-image|wanx|image-generation|imagen|stable-diffusion|sdxl/i
const VIDEO_MODEL_RE = /imagine-video|video-generation|text-to-video|image-to-video/i
const FAMILY_ALIASES = {
  grok: ['grok-imagine-image-2.0', 'grok-imagine-image', 'grok-2-image', 'grok-image'],
  gpt: ['gpt-image-1.5', 'gpt-image-1', 'gpt-image', 'dall-e-3', 'dall-e-2', 'dall-e-3-hd'],
  openai: ['gpt-image-1.5', 'gpt-image-1', 'dall-e-3', 'dall-e-2'],
  qwen: ['qwen-image-plus', 'qwen-image', 'qwen2-vl-image', 'wanx2.1-t2i-plus', 'wanx-v1'],
  wanxiang: ['wanx2.1-t2i-plus', 'wanx-v1', 'qwen-image'],
  flux: ['flux-1-pro', 'flux-pro', 'flux-1-schnell', 'flux-schnell'],
  'dall-e': ['dall-e-3', 'dall-e-2', 'gpt-image-1'],
  dalle: ['dall-e-3', 'dall-e-2', 'gpt-image-1'],
}

function isImageModel(id) {
  const s = String(id ?? '')
  if (!s || VIDEO_MODEL_RE.test(s)) return false
  return IMAGE_MODEL_RE.test(s) || (/\bimage\b/i.test(s) && !/vision/i.test(s))
}

function listImageModels(catalog = []) {
  const out = []
  const seen = new Set()
  for (const m of catalog) {
    const id = typeof m === 'string' ? m : m?.id
    if (!id || seen.has(id) || !isImageModel(id)) continue
    seen.add(id)
    out.push(typeof m === 'string' ? { id, name: id } : { id, name: m.name ?? id })
  }
  return out
}

function familyOf(requested) {
  const key = String(requested ?? '').trim().toLowerCase()
  if (!key) return ''
  if (FAMILY_ALIASES[key]) return key
  if (key === 'chatgpt' || key === 'openai' || key.startsWith('gpt') || key.startsWith('dall')) return key.startsWith('dall') || key === 'dalle' ? 'dall-e' : 'gpt'
  if (key.includes('qwen') || key.includes('wanx') || key.includes('通义') || key.includes('万相')) return 'qwen'
  if (key.includes('grok') || key.includes('imagine')) return 'grok'
  if (key.includes('flux')) return 'flux'
  return key
}

function resolveImageModel({ requested, defaultModel, aliases = {}, customModels = [], catalog = [] } = {}) {
  const listed = listImageModels(catalog)
  const ids = new Set([...listed.map((m) => m.id), ...customModels.filter(Boolean)])
  const pick = (id) => {
    if (!id) return null
    const raw = String(id).trim()
    if (!raw) return null
    if (ids.has(raw)) return raw
    const lower = raw.toLowerCase()
    const hit = [...ids].find((x) => x.toLowerCase() === lower)
    if (hit) return hit
    const family = familyOf(raw)
    const override = aliases[family] || aliases[raw] || aliases[lower]
    if (override && ids.has(override)) return override
    for (const c of FAMILY_ALIASES[family] ?? []) if (ids.has(c)) return c
    const fuzzy = listed.find((m) => {
      const idl = m.id.toLowerCase()
      const name = String(m.name ?? '').toLowerCase()
      return idl.includes(lower) || name.includes(lower) || (family && (idl.includes(family) || name.includes(family)))
    })
    return fuzzy?.id ?? null
  }
  if (requested != null && String(requested).trim()) return pick(requested)
  return pick(defaultModel) || pick('grok') || listed[0]?.id || null
}
/* -------------------------------------------------------------------------------------------------------- */

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return fallback
}

function unquote(v) {
  return String(v ?? '').trim().replace(/^['"]|['"]$/g, '')
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function loadDeskState() {
  try {
    return JSON.parse(readText(path.join(os.homedir(), '.dsh', 'desk', 'desk-state.json')) ?? '{}')
  } catch {
    return {}
  }
}

/** 只解析 settings.yaml 里指定的一段（两层：标量 + 子表 / 块列表），不引 YAML 依赖。 */
function parseSettingsBlock(text, block) {
  if (!text) return null
  const lines = String(text).split(/\r?\n/)
  const start = lines.findIndex((l) => new RegExp(`^${block}:\\s*$`).test(l))
  if (start < 0) return null
  const out = {}
  let listKey = null
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || /^\s*#/.test(line)) continue
    if (/^\S/.test(line)) break // 下一个顶层键
    const indent = /^\s*/.exec(line)[0].length
    const body = line.trim()
    if (body.startsWith('- ')) {
      if (!listKey) continue
      if (!Array.isArray(out[listKey])) out[listKey] = []
      out[listKey].push(unquote(body.slice(2)))
      continue
    }
    const m = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(body)
    if (!m) continue
    const [, key, rawVal] = m
    if (indent <= 2) {
      if (!rawVal.trim()) {
        out[key] = null
        listKey = key
      } else if (/^\[.*\]$/.test(rawVal.trim())) {
        out[key] = rawVal.trim().slice(1, -1).split(',').map(unquote).filter(Boolean)
        listKey = null
      } else {
        out[key] = unquote(rawVal.replace(/\s+#.*$/, ''))
        listKey = null
      }
    } else if (listKey) {
      if (Array.isArray(out[listKey]) || out[listKey] == null) out[listKey] = {}
      out[listKey][key] = unquote(rawVal.replace(/\s+#.*$/, ''))
    }
  }
  return out
}

function normalizeImageConfig(raw) {
  if (!raw || typeof raw !== 'object') return null
  const aliases = {}
  if (raw.aliases && typeof raw.aliases === 'object' && !Array.isArray(raw.aliases)) {
    for (const [k, v] of Object.entries(raw.aliases)) if (k && v) aliases[String(k).trim().toLowerCase()] = unquote(v)
  }
  return {
    defaultModel: raw.defaultModel ? unquote(raw.defaultModel) : null,
    aspectRatio: raw.aspectRatio ? unquote(raw.aspectRatio) : null,
    aliases,
    customModels: Array.isArray(raw.customModels) ? raw.customModels.map(unquote).filter(Boolean) : [],
  }
}

/** 插件接口（运行中的客户端）——最准，带 resolvedDefault 与目录里的生图模型。 */
async function fetchPluginConfig() {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), CONFIG_TIMEOUT_MS)
  try {
    const res = await fetch(CONFIG_URL, { signal: ac.signal })
    if (!res.ok) return null
    const j = await res.json()
    return {
      source: `插件 ${CONFIG_URL}`,
      defaultModel: j.defaultModel ?? null,
      aspectRatio: j.aspectRatio ?? null,
      aliases: j.aliases && typeof j.aliases === 'object' ? j.aliases : {},
      customModels: Array.isArray(j.customModels) ? j.customModels : [],
      resolvedDefault: j.resolvedDefault ?? null,
      catalog: Array.isArray(j.models) ? j.models : [],
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 优先用插件自己的解析器，保证和插件同一套短名规则。 */
async function loadPluginResolver() {
  try {
    if (!fs.existsSync(PLUGIN_MODELS)) return null
    const mod = await import(pathToFileURL(PLUGIN_MODELS).href)
    return typeof mod.resolveImageModel === 'function' ? mod : null
  } catch {
    return null
  }
}

function sniff(bytes) {
  if (!bytes || bytes.length < 12) return null
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { ext: '.png', mime: 'image/png' }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' }
  if (/^GIF8[79]a/.test(b.toString('ascii', 0, 6))) return { ext: '.gif', mime: 'image/gif' }
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { ext: '.webp', mime: 'image/webp' }
  return null
}

function stampName(now = new Date()) {
  const iso = now.toISOString()
  return `image-${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`
}

/** 扩展名按真实字节定：网关的 grok 通道会返回 JPEG 字节，写 .png 会导致预览报格式不符。 */
function destPath(out, index, total, ext) {
  const fallback = stampName() + (total > 1 ? `-${index + 1}` : '')
  let name = String(out ?? '').trim() || fallback
  if (total > 1 && out) name = name.replace(/(\.[A-Za-z0-9]+)?$/, (m) => `-${index + 1}${m || ''}`)
  const abs = path.resolve(name)
  const withExt = path.extname(abs) ? abs.replace(/\.[A-Za-z0-9]+$/, ext) : abs + ext
  if (!fs.existsSync(withExt)) return withExt
  const stem = withExt.slice(0, withExt.length - ext.length)
  for (let i = 2; ; i++) {
    const cand = `${stem} (${i})${ext}`
    if (!fs.existsSync(cand)) return cand
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

const plugin = await fetchPluginConfig()
const settings = plugin ? null : normalizeImageConfig(parseSettingsBlock(readText(SETTINGS_FILE), 'desk-image'))
const cfg = plugin ?? settings ?? {}
const catalog = plugin?.catalog?.length ? plugin.catalog : (Array.isArray(desk?.company?.models) ? desk.company.models : [])
const aliases = cfg.aliases ?? {}
const customModels = cfg.customModels ?? []
const source = cfg.source ?? (settings ? `settings.yaml ${SETTINGS_FILE}` : '内置兜底')

const pluginResolver = await loadPluginResolver()
const resolve = (requested) => (pluginResolver ?? { resolveImageModel }).resolveImageModel({
  requested,
  defaultModel: cfg.defaultModel,
  aliases,
  customModels,
  catalog,
})

const requestedModel = arg('--model')
let model = null
if (requestedModel) model = resolve(requestedModel) ?? (/[-_.]/.test(requestedModel) ? requestedModel : null)
else if (plugin?.resolvedDefault) model = plugin.resolvedDefault
else model = resolve(cfg.defaultModel)
if (!model) {
  console.error('公司目录里没有可用的生图模型：请在网关接入 GPT / Qwen / Grok 通道，或在设置 → 生图里填模型 id。')
  process.exit(2)
}

const requestedRatio = arg('--ratio', arg('--aspect-ratio'))
const ratio = RATIOS.includes(requestedRatio) ? requestedRatio : RATIOS.includes(cfg.aspectRatio) ? cfg.aspectRatio : DEFAULT_RATIO

const out = arg('--out', arg('--output'))
const edit = arg('--edit', arg('--image'))
const n = Math.max(1, Math.min(4, Number(arg('--n', '1')) || 1))

console.error(`模型=${model} 比例=${ratio} 张数=${n} 配置来源=${source}`)

const body = { model, prompt, n, aspect_ratio: ratio, response_format: 'b64_json' }
let apiPath = '/v1/images/generations'
if (edit) {
  apiPath = '/v1/images/edits'
  body.image = fs.readFileSync(edit).toString('base64')
}

let res
try {
  res = await fetch(base + apiPath, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
} catch (err) {
  console.error(`无法连接公司网关 ${base}：${err.message}`)
  process.exit(1)
}
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
  let bytes
  if (item.b64_json) {
    bytes = Buffer.from(parseDataUrl(item.b64_json), 'base64')
  } else if (item.url) {
    let img
    try {
      img = await fetch(item.url)
    } catch (err) {
      console.error('下载失败 ' + item.url + '：' + err.message)
      process.exit(1)
    }
    if (!img.ok) {
      console.error('下载失败 ' + item.url + ' HTTP ' + img.status)
      process.exit(1)
    }
    bytes = Buffer.from(await img.arrayBuffer())
  } else {
    console.error('条目缺少 b64_json / url')
    process.exit(1)
  }
  const dest = destPath(out, i, items.length, sniff(bytes)?.ext ?? '.jpg')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, bytes)
  written.push(path.resolve(dest))
}
console.log(written.join('\n'))
