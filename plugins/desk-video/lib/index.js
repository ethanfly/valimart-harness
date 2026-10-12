/**
 * @company-desk/desk-video —— 企业交付工作台的生视频插件。
 *
 *   - 注册 video_generate，经公司网关 /v1/videos/generations（密钥不落本机）
 *   - 设置页从公司目录选默认模型（wan / minimax / grok / gpt / qwen / seedance 短名或真实 id）
 *   - 多张参考图 + 提示词；时长超过模型单段上限时分段生成，再用 ffmpeg 拼成长视频
 *   - 输入框「生视频」芯片：不切会话模型
 */
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ASPECT_RATIOS, MAX_DURATION, MAX_IMAGES, listVideoModels, normalizeVideoConfig, resolveVideoModel, segmentCap } from './models.js'
import { assertInside, generateVideo, readImageB64 } from './generate.js'
import { appendHistory } from '../../desk-image/lib/history.js'

export const name = 'desk-video'
export const inject = ['webServer', 'tools', 'systemPrompt', 'sessions', 'deskHost', 'settings']

export const Config = z.object({
  defaultModel: z.string().default('grok'),
  aspectRatio: z.string().default('16:9'),
  duration: z.number().default(6),
  longForm: z.boolean().default(true),
  aliases: z.dict(z.string()).default({}),
  customModels: z.array(z.string()).default([]),
})

const SCOPE = 'desk-video'
const textOut = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }

function sessionOf(ctx, exec) {
  const agent = exec?.agent
  const sid = agent?.session?.id ?? agent?.id
  return sid ? ctx.sessions.get?.(sid) : null
}

function cwdOf(session) {
  const cwd = session?.header?.cwd
  if (!cwd) throw Object.assign(new Error('会话还没有工作目录，先选一个工作区'), { status: 400, code: 'no_cwd' })
  return cwd
}

export function apply(ctx, config) {
  const log = (msg) => console.log(`[desk-video] ${msg}`)
  const host = ctx.deskHost
  let resolveCfg = () => normalizeVideoConfig(config)
  if (typeof ctx.settings?.register === 'function') {
    const scope = ctx.settings.register(SCOPE, Config, { base: config, applies: 'live' })
    resolveCfg = () => normalizeVideoConfig({ ...config, ...scope.get() })
  }

  function catalog() {
    return host?.state?.data?.company?.models ?? []
  }

  function gatewayAuth() {
    const state = host?.state
    if (!state?.loggedIn) throw Object.assign(new Error('未登录公司网关'), { status: 401, code: 'unauthenticated' })
    return {
      gatewayUrl: state.data.gatewayUrl,
      token: state.data.gatewayToken,
      catalog: state.data.company?.models ?? [],
    }
  }

  async function runGenerate({ prompt, model, aspectRatio, duration, out, images, cwd, signal }) {
    const cfg = resolveCfg()
    const auth = gatewayAuth()
    const resolved = resolveVideoModel({
      requested: model,
      defaultModel: cfg.defaultModel,
      aliases: cfg.aliases,
      customModels: cfg.customModels,
      catalog: auth.catalog,
    })
    const ratio = ASPECT_RATIOS.includes(String(aspectRatio ?? '')) ? String(aspectRatio) : cfg.aspectRatio
    const seconds = Math.max(1, Math.min(MAX_DURATION, Math.round(Number(duration) || cfg.duration)))
    const refs = (Array.isArray(images) ? images : []).filter(Boolean).slice(0, MAX_IMAGES)
    const imagesB64 = refs.map((p) => readImageB64(assertInside(cwd, path.isAbsolute(p) ? p : path.resolve(cwd, p))))
    const result = await generateVideo({
      gatewayUrl: auth.gatewayUrl,
      token: auth.token,
      model: resolved,
      prompt,
      duration: seconds,
      aspectRatio: ratio,
      images: imagesB64,
      cwd,
      out,
      longForm: cfg.longForm,
      signal,
    })
    appendHistory(cwd, 'video', {
      prompt, model: result.model, aspectRatio: ratio, duration: seconds, segments: result.segments,
      files: (result.written ?? []).map((f) => ({ rel: f.rel, bytes: f.bytes })),
    })
    return { ...result, ratio, seconds }
  }

  function formatResult({ written, model, ratio, seconds, segments }) {
    const file = written[0]
    const seg = segments?.length > 1 ? `，分 ${segments.length} 段（${segments.join('+')} 秒）拼接` : ''
    return [
      `生视频完成：模型 ${model}，比例 ${ratio}，${seconds} 秒${seg}。`,
      `- ${file.rel}（${file.bytes} 字节）`,
      '',
      '请在最终回复里用 Markdown 直接展示：',
      `[${path.basename(file.rel)}](${file.rel})`,
    ].join('\n')
  }

  ctx.tools.register(
    defineTool({
      name: 'video_generate',
      description:
        '通过公司网关生视频（文生视频 / 多参考图生视频），不要切会话模型、不要 chat/completions、不要直连上游。model 可写 wan / minimax / grok / gpt / qwen / seedance 短名，或公司目录里的真实 id。images 是工作目录里的参考图（最多 5 张）。duration 超过该模型单段上限时自动分段再拼接成长视频。视频写到当前会话工作目录。',
      parameters: {
        prompt: { type: 'string', required: true, description: '视频提示词。用户给了完整提示词就原文用。' },
        model: { type: 'string', description: '短名 wan / minimax / grok / gpt / qwen / seedance，或公司目录里的模型 id；缺省用设置里的默认视频模型' },
        aspect_ratio: { type: 'string', enum: ASPECT_RATIOS, description: '画幅：16:9 横屏、9:16 竖屏、1:1、4:3、3:4' },
        duration: { type: 'number', description: `时长（秒），1–${MAX_DURATION}。超过模型单段上限会分段生成再拼接` },
        images: { type: 'array', items: { type: 'string' }, description: '参考图路径（相对当前工作目录），最多 5 张。第一张作首帧' },
        out: { type: 'string', description: '相对当前工作目录的输出文件名，缺省自动命名 video-YYYYMMDD-HHMMSS.mp4' },
      },
      output: textOut,
      timeoutMs: 900_000,
      async execute(args, exec) {
        const cwd = cwdOf(sessionOf(ctx, exec))
        const r = await runGenerate({
          prompt: args.prompt,
          model: args.model,
          aspectRatio: args.aspect_ratio,
          duration: args.duration,
          images: args.images,
          out: args.out,
          cwd,
          signal: exec?.signal,
        })
        return formatResult(r)
      },
      presentCall: (args) => ({ card: 'generic', title: `生视频 ${args.model ?? ''}`.trim(), kind: 'other', rawInput: args }),
    }),
  )

  ctx.systemPrompt.section({
    name: 'desk:video',
    order: 62,
    text: () => {
      const cfg = resolveCfg()
      const models = listVideoModels(catalog())
      const ids = models.map((m) => m.id)
      const extras = cfg.customModels.filter((id) => !ids.includes(id))
      const available = [...ids, ...extras]
      const line = available.length ? available.join('、') : '（公司目录里还没有视频模型，请管理员在网关接入万相 / MiniMax / Grok / Sora / Seedance）'
      return [
        '## 生视频',
        '用户说生视频、做视频、图生视频、长视频时，调用 video_generate，不要切会话模型，不要 chat/completions，不要直连上游。',
        `默认模型短名：${cfg.defaultModel}（设置 → 生视频 可改）。可用模型：${line}。`,
        '短名对照：wan / qwen → 通义万相；minimax → 海螺 Hailuo；grok → Grok Imagine Video；gpt → Sora；seedance → 豆包 Seedance。',
        `参考图放 images（最多 ${MAX_IMAGES} 张）。时长超过单段上限（当前默认模型约 ${segmentCap(cfg.defaultModel)} 秒）且开启长视频时自动分段拼接。`,
        '完成后磁盘上要有 mp4，最终回复给出相对路径。',
      ].join('\n')
    },
  })

  const json = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }
  const readJson = async (req) => {
    const ct = String(req.headers['content-type'] ?? '')
    if (ct && !ct.includes('application/json') && !ct.includes('text/json')) {
      throw Object.assign(new Error('请求体必须是 application/json'), { status: 415, code: 'bad_content_type' })
    }
    const chunks = []
    for await (const c of req) chunks.push(c)
    const text = Buffer.concat(chunks).toString('utf8')
    try {
      return text ? JSON.parse(text) : {}
    } catch {
      throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400, code: 'bad_json' })
    }
  }
  const fail = (res, err) => json(res, err.status ?? 500, { error: { message: err.message, code: err.code ?? 'error' } })
  const sameOrigin = (req) => {
    const secFetch = String(req.headers['sec-fetch-site'] ?? '')
    if (secFetch && secFetch !== 'same-origin' && secFetch !== 'same-site' && secFetch !== 'none') {
      throw Object.assign(new Error('跨站请求被拒绝'), { status: 403, code: 'bad_origin' })
    }
    const origin = req.headers.origin
    if (origin) {
      let host = ''
      try { host = new URL(origin).host } catch { host = '' }
      if (!req.headers.host || host !== String(req.headers.host)) {
        throw Object.assign(new Error('跨源请求被拒绝'), { status: 403, code: 'bad_origin' })
      }
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/desk/api/video',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const rel = url.pathname.replace(/^\/desk\/api\/video/, '') || '/'
          const method = req.method ?? 'GET'
          try {
            sameOrigin(req)
            if (method === 'GET' && (rel === '/' || rel === '/config')) {
              const cfg = resolveCfg()
              let models = []
              let loggedIn = false
              try {
                const auth = gatewayAuth()
                loggedIn = true
                models = listVideoModels(auth.catalog)
              } catch {
                models = listVideoModels(catalog())
              }
              const resolved = resolveVideoModel({
                requested: cfg.defaultModel,
                defaultModel: cfg.defaultModel,
                aliases: cfg.aliases,
                customModels: cfg.customModels,
                catalog: models,
              })
              return json(res, 200, {
                ...cfg,
                models,
                resolvedDefault: resolved,
                loggedIn,
                families: ['wan', 'minimax', 'grok', 'gpt', 'qwen', 'seedance'],
                segmentCap: segmentCap(resolved ?? cfg.defaultModel),
                maxDuration: MAX_DURATION,
                maxImages: MAX_IMAGES,
              })
            }
            if (method === 'POST' && rel === '/config') {
              const body = await readJson(req)
              const next = normalizeVideoConfig({ ...resolveCfg(), ...body })
              const settings = ctx.settings
              if (typeof settings?.update === 'function') await settings.update(SCOPE, next)
              else if (typeof settings?.set === 'function') await settings.set(SCOPE, next)
              else throw Object.assign(new Error('无法保存生视频设置'), { status: 500, code: 'no_settings' })
              return json(res, 200, next)
            }
            if (method === 'POST' && rel === '/generate') {
              const body = await readJson(req)
              const sid = String(body.sessionId ?? '')
              const live = sid ? ctx.sessions.get?.(sid) : null
              const cwd = live?.header?.cwd ?? (typeof body.cwd === 'string' ? body.cwd : null)
              if (!cwd) throw Object.assign(new Error('会话还没有工作目录，先选一个工作区'), { status: 400, code: 'no_cwd' })
              const r = await runGenerate({
                prompt: body.prompt,
                model: body.model,
                aspectRatio: body.aspectRatio ?? body.aspect_ratio,
                duration: body.duration,
                images: body.images,
                out: body.out,
                cwd,
              })
              return json(res, 200, r)
            }
            json(res, 404, { error: { message: `no route ${method} ${rel}`, code: 'not_found' } })
          } catch (err) {
            fail(res, err)
          }
        },
      }),
    'desk-video: /desk/api/video',
  )

  log('已就绪：video_generate 走公司网关 /v1/videos/generations')
}
