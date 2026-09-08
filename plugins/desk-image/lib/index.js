/**
 * @company-desk/desk-image —— 企业交付工作台的生图插件。
 *
 * DeepSeek Harness 官方/社区没有走公司网关、可配 GPT / Qwen / Grok 的生图插件
 * （awesome 清单里 Vision 类是选图、预览、附件，不是文生图）。本插件：
 *   - 注册 image_generate / image_edit，经公司网关 /v1/images/*（密钥不落本机）
 *   - 设置页可选默认模型（gpt / qwen / grok 短名或目录里的真实 id）
 *   - 输入框「生图」芯片：不切会话模型，直接出图写到工作目录
 */
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ASPECT_RATIOS, listImageModels, normalizeImageConfig, resolveImageModel } from './models.js'
import { assertInside, callGatewayImages, readImageB64, writeImageItems } from './generate.js'

export const name = 'desk-image'
export const inject = ['webServer', 'tools', 'systemPrompt', 'sessions', 'deskHost', 'settings']

export const Config = z.object({
  defaultModel: z.string().default('grok'),
  aspectRatio: z.string().default('1:1'),
  aliases: z.dict(z.string()).default({ gpt: 'gpt-image-1', qwen: 'qwen-image', grok: 'grok-imagine-image-2.0' }),
  customModels: z.array(z.string()).default([]),
})

const SCOPE = 'desk-image'
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
  const log = (msg) => console.log(`[desk-image] ${msg}`)
  const host = ctx.deskHost
  let resolveCfg = () => normalizeImageConfig(config)
  if (typeof ctx.settings?.register === 'function') {
    const scope = ctx.settings.register(SCOPE, Config, { base: config, applies: 'live' })
    resolveCfg = () => normalizeImageConfig({ ...config, ...scope.get() })
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

  async function runGenerate({ prompt, model, aspectRatio, n, out, image, images, cwd, signal }) {
    const cfg = resolveCfg()
    const auth = gatewayAuth()
    const resolved = resolveImageModel({
      requested: model,
      defaultModel: cfg.defaultModel,
      aliases: cfg.aliases,
      customModels: cfg.customModels,
      catalog: auth.catalog,
    })
    const ratio = ASPECT_RATIOS.includes(String(aspectRatio ?? '')) ? String(aspectRatio) : cfg.aspectRatio
    const resolveRef = (p) => assertInside(cwd, path.isAbsolute(p) ? p : path.resolve(cwd, p))
    let imageB64
    let imagesB64
    if (image) imageB64 = readImageB64(resolveRef(image))
    if (Array.isArray(images) && images.length) {
      imagesB64 = images.map((p) => readImageB64(resolveRef(p)))
    }
    const { items, model: used, edit } = await callGatewayImages({
      gatewayUrl: auth.gatewayUrl,
      token: auth.token,
      model: resolved,
      prompt,
      n,
      aspectRatio: ratio,
      image: imageB64,
      images: imagesB64,
      signal,
    })
    const written = await writeImageItems({ cwd, out, items })
    return { written, model: used, edit, ratio }
  }

  function formatResult({ written, model, edit, ratio }) {
    const lines = written.map((f) => `- ${f.rel}（${f.bytes} 字节）`)
    const pics = written.map((f) => `![${path.basename(f.rel)}](${f.rel})`)
    return [
      `${edit ? '修图' : '生图'}完成：模型 ${model}，比例 ${ratio}，${written.length} 张。`,
      ...lines,
      '',
      '请在最终回复里用 Markdown 直接展示：',
      ...pics,
    ].join('\n')
  }

  ctx.tools.register(
    defineTool({
      name: 'image_generate',
      description:
        '通过公司网关生图（文生图），不要切会话模型、不要 chat/completions、不要直连上游。model 可写 gpt / qwen / grok 短名，或公司目录里的真实 id（如 grok-imagine-image-2.0、gpt-image-1、qwen-image）。图片写到当前会话工作目录；回复里用 Markdown ![说明](相对路径) 展示。',
      parameters: {
        prompt: { type: 'string', required: true, description: '生图提示词。用户给了完整提示词就原文用。' },
        model: { type: 'string', description: '短名 gpt / qwen / grok，或公司目录里的模型 id；缺省用设置里的默认生图模型' },
        aspect_ratio: { type: 'string', enum: ASPECT_RATIOS, description: '构图：1:1 头像、16:9 封面、9:16 竖图、4:3 / 3:4 插画' },
        n: { type: 'number', description: '张数 1–4，默认 1' },
        out: { type: 'string', description: '相对当前工作目录的输出文件名，缺省自动命名 image-YYYYMMDD-HHMMSS.jpg' },
      },
      output: textOut,
      timeoutMs: 180_000,
      async execute(args, exec) {
        const session = sessionOf(ctx, exec)
        const cwd = cwdOf(session)
        const r = await runGenerate({
          prompt: args.prompt,
          model: args.model,
          aspectRatio: args.aspect_ratio,
          n: args.n,
          out: args.out,
          cwd,
          signal: exec?.signal,
        })
        return formatResult(r)
      },
      presentCall: (args) => ({ card: 'generic', title: `生图 ${args.model ?? ''}`.trim(), kind: 'other', rawInput: args }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'image_edit',
      description:
        '通过公司网关修图（图生图）。image 是工作目录里的参考图路径。model 规则同 image_generate。只写要改的部分。',
      parameters: {
        prompt: { type: 'string', required: true, description: '只写要改的部分' },
        image: { type: 'string', required: true, description: '参考图路径（相对当前工作目录或绝对路径）' },
        model: { type: 'string', description: '短名 gpt / qwen / grok，或公司目录里的模型 id' },
        aspect_ratio: { type: 'string', enum: ASPECT_RATIOS },
        out: { type: 'string', description: '输出文件名' },
      },
      output: textOut,
      timeoutMs: 180_000,
      async execute(args, exec) {
        const session = sessionOf(ctx, exec)
        const cwd = cwdOf(session)
        const r = await runGenerate({
          prompt: args.prompt,
          model: args.model,
          aspectRatio: args.aspect_ratio,
          out: args.out,
          image: args.image,
          cwd,
          signal: exec?.signal,
        })
        return formatResult(r)
      },
      presentCall: (args) => ({ card: 'generic', title: `修图 ${args.model ?? ''}`.trim(), kind: 'other', rawInput: args }),
    }),
  )

  ctx.systemPrompt.section({
    name: 'desk:image',
    order: 61,
    text: () => {
      const cfg = resolveCfg()
      const models = listImageModels(catalog())
      const ids = models.map((m) => m.id)
      const extras = cfg.customModels.filter((id) => !ids.includes(id))
      const available = [...ids, ...extras]
      const line = available.length ? available.join('、') : '（公司目录里还没有生图模型，请管理员在网关接入 GPT / Qwen / Grok 通道）'
      return [
        `## 生图`,
        `用户说生图、出图、画一张、修图、改图时，调用 image_generate / image_edit，不要切会话模型，不要 chat/completions，不要直连 xAI / OpenAI / 通义。`,
        `默认模型短名：${cfg.defaultModel}（设置 → 生图 可改成 gpt / qwen / grok 或真实 id）。可用模型：${line}。`,
        `短名对照：gpt → GPT Image / DALL·E；qwen → 通义万相 / qwen-image；grok → Grok Imagine。`,
        `出图后磁盘上要有文件，最终回复用 Markdown ![说明](相对路径) 展示。`,
      ].join('\n')
    },
  })

  const json = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
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
    if (origin && (!req.headers.host || String(new URL(origin).host) !== String(req.headers.host))) {
      throw Object.assign(new Error('跨源请求被拒绝'), { status: 403, code: 'bad_origin' })
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/desk/api/image',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const rel = url.pathname.replace(/^\/desk\/api\/image/, '') || '/'
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
                models = listImageModels(auth.catalog)
              } catch {
                models = listImageModels(catalog())
              }
              const resolved = resolveImageModel({
                requested: cfg.defaultModel,
                defaultModel: cfg.defaultModel,
                aliases: cfg.aliases,
                customModels: cfg.customModels,
                catalog: models,
              })
              return json(res, 200, { ...cfg, models, resolvedDefault: resolved, loggedIn, families: ['gpt', 'qwen', 'grok'] })
            }
            if (method === 'POST' && rel === '/config') {
              const body = await readJson(req)
              const next = normalizeImageConfig({ ...resolveCfg(), ...body })
              const settings = ctx.settings
              if (typeof settings?.update === 'function') await settings.update(SCOPE, next)
              else if (typeof settings?.set === 'function') await settings.set(SCOPE, next)
              else throw Object.assign(new Error('无法保存生图设置'), { status: 500, code: 'no_settings' })
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
                n: body.n,
                out: body.out,
                image: body.image,
                images: body.images,
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
    'desk-image: /desk/api/image',
  )

  log('已就绪：image_generate / image_edit 走公司网关 /v1/images/*')
}
