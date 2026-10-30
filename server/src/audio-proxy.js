/**
 * 语音网关：设备专用 /v1/audio/*。这不是通用 OpenAI 语音 API 透传。
 *
 * 设计要点：
 * - 设备端不做 base64，也不做 WAV 封装。它 POST 原始 PCM(16-bit LE)，
 *   这里补 WAV 头再转给上游；TTS 回包统一剥成裸 PCM + 采样率响应头，
 *   设备不需要解析 WAV，也不用管各家采样率差异。
 * - 只收验证过的输入：裸 PCM 或 16-bit PCM WAV。multipart 不做校验透传
 *   （等于把任意 body 原样转给上游还绕过记账），直接拒绝；format / model /
 *   voice 不由客户端任指，一律用网关配置。
 * - 上游密钥只在这里，设备只持有网关令牌。fetch 一律 redirect:'error'：
 *   上游 30x 可能把 Authorization 带去第三方。
 * - 每次上游调用带超时 + 随设备断连取消；上游回包尺寸有上限。
 * - mock 通道显式标记（config.mock 布尔 + 合成响应 x-audio-mock 头），
 *   本地联调用；生产没配上游时 available=false + 503 voice_not_configured，
 *   不允许把 mock 悄悄当成真语音。
 * - 记账沿用 ledger：语音按秒计（voice:{kind,audioSeconds}）；只有配置了
 *   priceCnyPerMinute 才计成本（priceKnown=true），否则如实记 0，不假装知道成本。
 */
import { HttpError, readBody, sendJson, parseUrl } from './http.js'
import { configVoiceChannel, isLocalEndpoint } from './voice-settings.js'

export const MIN_RATE = 8000
export const MAX_RATE = 48000

/** 识别入站上限：设备 6 秒 / 192000 字节绰绰有余，桌面对文件转写也够。 */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024
/** 合成请求 JSON 上限（input ≤ 2000 字，绰绰有余）。 */
const MAX_SPEECH_BODY_BYTES = 64 * 1024
/** 上游识别文本上限：正常就几个字，64 KiB 已是滥用。 */
const MAX_TEXT_BYTES = 64 * 1024

/** 16-bit LE 单声道 PCM 包成 WAV。 */
export function pcmToWav(pcm, rate, channels = 1) {
  const bytes = pcm.length
  const header = Buffer.alloc(44)
  const byteRate = rate * channels * 2
  const blockAlign = channels * 2
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + bytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(bytes, 40)
  return Buffer.concat([header, pcm])
}

/**
 * 从 WAV 里取 fmt 参数并剥掉头；结构不对（太短 / 不是 RIFF+WAVE /
 * fmt 块缺失或在 data 之后）返回 null。fmtTag：1=PCM；Extensible WAV 需要解析
 * 子格式才可安全判为 PCM，设备协议不接受。
 *
 * OpenAI TTS 的 WAV 使用 0xFFFFFFFF 占位符（RIFF 和 data 块的 size 字段）：
 * 当 RIFF size 是占位符时，end = buf.length；当 data size 是占位符时，
 * data 取到文件尾并截断到 blockAlign 倍数（必须非空）。其他块仍严格校验。
 */
export function splitWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  const riffSize = buf.readUInt32LE(4)
  const streamed = riffSize === 0xFFFFFFFF || riffSize === 0
  const end = streamed ? buf.length : riffSize + 8
  // 非占位符时 RIFF 长度必须正好等于完整容器长度；声明比实际长 = 截断。
  if (end > buf.length || end < 12) return null
  if (!streamed && end !== buf.length) return null
  let at = 12
  let format = null
  let pcm = null
  while (at < end) {
    if (at + 8 > end) return null
    const id = buf.toString('ascii', at, at + 4)
    const size = buf.readUInt32LE(at + 4)
    const body = at + 8
    if (id === 'fmt ') {
      // 先做越界检查再读字段，否则截断的块会抛 RangeError。
      if (format || size < 16 || body + 16 > end) return null
      const fmtTag = buf.readUInt16LE(body)
      const channels = buf.readUInt16LE(body + 2)
      const rate = buf.readUInt32LE(body + 4)
      const byteRate = buf.readUInt32LE(body + 8)
      const blockAlign = buf.readUInt16LE(body + 12)
      const bits = buf.readUInt16LE(body + 14)
      if (!channels || !bits || bits % 8 || !rate ||
          blockAlign !== channels * (bits / 8) || byteRate !== rate * blockAlign) return null
      if (body + size > end) return null
      format = { fmtTag, channels, rate, bits, blockAlign }
      at = body + size + (size % 2)
    } else if (id === 'data') {
      if (!format || pcm) return null
      // data 占位符（0xFFFFFFFF / 0，流式写入者常见）：只在容器本身也是流式时取到文件尾，
      // 截断到 blockAlign 倍数且必须非空；读到 data 就结束，后面不再有块。
      if (streamed && (size === 0xFFFFFFFF || size === 0)) {
        const available = end - body
        const aligned = available - (available % format.blockAlign)
        if (aligned === 0) return null
        pcm = buf.subarray(body, body + aligned)
        at = end
        continue
      }
      if (size === 0 || size % format.blockAlign || body + size > end) return null
      pcm = buf.subarray(body, body + size)
      at = body + size + (size % 2)
    } else {
      // 其他块不认占位符：长度必须落在容器内。
      if (size === 0xFFFFFFFF || body + size > end) return null
      at = body + size + (size % 2)
    }
  }
  return pcm && format ? { pcm, ...format } : null
}

/** WAV 头参数是否设备/上游链路都认：16-bit PCM、单声道、采样率在支持范围内。 */
function isPlayablePcmWav(wav) {
  return (
    wav.fmtTag === 1 &&
    wav.bits === 16 &&
    wav.channels === 1 &&
    wav.rate >= MIN_RATE &&
    wav.rate <= MAX_RATE
  )
}

function multipart(fields, boundary, file) {
  const parts = []
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    )
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
        `Content-Type: ${file.type}\r\n\r\n`,
      'utf8',
    ),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  )
  return Buffer.concat(parts)
}

/** 有上限地读完一个上游响应体；超限取消连接并抛 502。 */
async function readBounded(upstreamRes, cap) {
  const reader = upstreamRes.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.length
    if (size > cap) {
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
      throw new HttpError(502, '上游返回的数据超过上限', 'upstream_too_large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

async function readBoundedText(upstreamRes, cap) {
  return (await readBounded(upstreamRes, cap)).toString('utf8')
}

export class AudioProxy {
  constructor({ db, cfg, ledger, proxy, fetchImpl, voiceSettings, voiceRuntime }) {
    this.db = db
    this.cfg = cfg
    this.ledger = ledger
    this.proxy = proxy
    this.voiceSettings = voiceSettings
    this.voiceRuntime = voiceRuntime
    // 测试注入位：本地起一个假语音上游，验证真实打包/剥壳逻辑而不是 Mock 分支。
    this.fetch = fetchImpl ?? ((...args) => fetch(...args))
  }

  /** 复用 llm-proxy 的网关令牌校验（吊销即时生效、停用即 403）。 */
  authenticate(req) {
    return this.proxy.authenticate(req)
  }

  /**
   * 当前生效的语音通道：管理页设置 > 配置文件；都没有返回 null。
   * 返回对象含 provider / kind / baseUrl / apiKey / 模型/音色/采样率/价目/超时。
   */
  channelConfig() {
    return this.voiceSettings ? this.voiceSettings.effective() : configVoiceChannel(this.cfg)
  }

  /** 与文本模型共用周额度：超额时直接拒绝，避免语音绕过限额。 */
  assertQuota(user, providerId) {
    if (this.ledger.exceeded(user, providerId)) {
      throw new HttpError(429, '本周额度已用完', 'quota_exceeded')
    }
  }

  /** 通道必须可用（mock，或这一端已解析到端点 + 密钥）；否则一律 503，不静默降级成 mock。 */
  upstreamFor(channel, kind) {
    const baseUrl = kind === 'asr' ? channel?.asrBaseUrl : channel?.ttsBaseUrl
    const apiKey = kind === 'asr' ? channel?.asrApiKey : channel?.ttsApiKey
    // 本机端点优先：哪怕配置通道是 mock，管理页改用本机模型也要落到运行时。
    if (isLocalEndpoint(baseUrl) && apiKey) return { baseUrl, apiKey }
    if (channel?.kind === 'mock') return channel
    if (channel?.kind === 'openai-compatible' && baseUrl && apiKey) return { baseUrl, apiKey }
    throw new HttpError(
      503,
      '网关还没有配置可用的语音通道。请在管理页 → 模型 → 语音 接入 ASR/TTS 上游（或在 server/config.json 配置 voice.provider）。',
      'voice_not_configured',
    )
  }

  record(user, channel, { model, kind, status, latencyMs, audioSeconds = 0, tag }) {
    const perMinute = kind === 'asr' ? channel.asrPriceCnyPerMinute : channel.ttsPriceCnyPerMinute
    const seconds = Number(audioSeconds) || 0
    const priced = perMinute > 0
    this.ledger.record({
      userId: user.id,
      username: user.username,
      provider: channel.provider,
      model,
      stream: false,
      status,
      tag: tag ?? (kind === 'asr' ? 'voice-asr' : 'voice-tts'),
      latencyMs,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      // 语音按秒计价，与文本 token 价目不同：没配价目就如实记 0（priceKnown=false）。
      costCny: priced ? Math.round((seconds / 60) * perMinute * 1_000_000) / 1_000_000 : 0,
      usageKnown: false,
      priceKnown: priced,
      voice: { kind, audioSeconds: seconds },
    })
  }

  /**
   * 给一次上游交互装上超时 + 设备断连取消。调用方负责在 finally 里 done()。
   * arm.reason 记录是谁触发的 abort：'timeout' | 'client' | ''（正常完成）。
   */
  armUpstream(res, timeoutMs) {
    const ac = new AbortController()
    const arm = { ac, reason: '' }
    arm.timer = setTimeout(() => {
      arm.reason = 'timeout'
      ac.abort()
    }, timeoutMs)
    arm.onClose = () => {
      if (!res.writableEnded) {
        arm.reason = 'client'
        ac.abort()
      }
    }
    res.on('close', arm.onClose)
    arm.done = () => {
      clearTimeout(arm.timer)
      res.off('close', arm.onClose)
    }
    return arm
  }

  /** 把上游交互里的异常翻成记账状态 + 给设备的错误。返回要抛出的 HttpError。 */
  upstreamFailure(arm, err, label) {
    if (arm.reason === 'timeout') return new HttpError(504, `语音上游超时（${label}）`, 'timeout')
    if (err instanceof HttpError) return err
    if (arm.reason === 'client') return new HttpError(499, '设备已断开', 'client_closed')
    return new HttpError(502, '语音上游不可达', 'upstream_unreachable')
  }

  /** GET /v1/audio/config —— 设备开机时问一次：有没有语音、是不是 mock、用什么参数播。 */
  handleConfig(req, res) {
    this.authenticate(req)
    const ch = this.channelConfig()
    const available = ch?.kind === 'mock' || (ch?.kind === 'openai-compatible' && !!ch.asrBaseUrl && !!ch.asrApiKey && !!ch.ttsBaseUrl && !!ch.ttsApiKey)
    sendJson(res, 200, {
      available: Boolean(available),
      // 显式 mock 标记：设备开机必须区分「本地演示音」和「真语音」，不许静默混淆。
      mock: Boolean(available && ch.kind === 'mock'),
      asrModel: ch?.asrModel ?? 'whisper-1',
      ttsModel: ch?.ttsModel ?? 'tts-1',
      ttsRate: ch?.ttsRate ?? 24000,
      ttsChannels: 1,
      ttsBits: 16,
    })
  }

  /**
   * POST /v1/audio/transcriptions?rate=16000&channels=1&encoding=pcm_s16le
   * 只收验证过的裸 16-bit LE 单声道 PCM（chunked 也行）或 16-bit PCM 单声道 WAV；
   * 网关补 WAV 头，再用 multipart 转给上游。multipart 透传一律拒绝。
   */
  async handleTranscriptions(req, res) {
    const { user } = this.authenticate(req)
    const ch = this.channelConfig()
    const up = this.upstreamFor(ch, 'asr')
    const started = Date.now()
    this.assertQuota(user, ch.provider)

    const url = parseUrl(req)
    const ctype = String(req.headers['content-type'] ?? '')
    if (/multipart\/form-data/i.test(ctype)) {
      throw new HttpError(
        400,
        '设备协议只收 audio/pcm 裸流；不支持 multipart/form-data 透传',
        'unsupported_content_type',
      )
    }
    if (!/^audio\/(?:pcm|wav)(?:;|$)/i.test(ctype)) {
      throw new HttpError(400, 'Content-Type 必须是 audio/pcm 或 audio/wav', 'unsupported_content_type')
    }
    const encoding = url.searchParams.get('encoding') ?? 'pcm_s16le'
    if (encoding !== 'pcm_s16le') throw new HttpError(400, 'encoding 目前只支持 pcm_s16le', 'bad_encoding')
    const rateRaw = url.searchParams.get('rate')
    const channelsRaw = url.searchParams.get('channels')
    const rate = rateRaw == null || rateRaw === '' ? 16000 : Number(rateRaw)
    const channels = channelsRaw == null || channelsRaw === '' ? 1 : Number(channelsRaw)
    if (!Number.isInteger(rate) || rate < MIN_RATE || rate > MAX_RATE) {
      throw new HttpError(400, `rate 必须是 ${MIN_RATE}–${MAX_RATE} 之间的整数`, 'bad_rate')
    }
    if (channels !== 1) throw new HttpError(400, 'channels 目前只支持单声道 1', 'bad_channels')

    const raw = await readBody(req, MAX_AUDIO_BYTES)
    if (raw.length === 0) throw new HttpError(400, '空音频', 'empty_audio')

    // 设备默认发裸 PCM；WAV（按 content-type 或 RIFF 魔数识别）解析头，
    // 头里的参数优先于查询串，但同样要过格式校验。
    let pcm = raw
    let effectiveRate = rate
    let effectiveChannels = channels
    const looksLikeWav =
      /audio\/wav/i.test(ctype) ||
      (raw.length >= 12 && raw.toString('ascii', 0, 4) === 'RIFF' && raw.toString('ascii', 8, 12) === 'WAVE')
    if (looksLikeWav) {
      const wav = splitWav(raw)
      if (!wav) throw new HttpError(400, '无法解析 WAV（需要标准 16-bit PCM WAV）', 'bad_wav')
      if (wav.fmtTag !== 1) throw new HttpError(400, 'WAV 必须是标准 PCM 编码', 'unsupported_audio')
      if (wav.bits !== 16) throw new HttpError(400, `WAV 是 ${wav.bits}-bit，只支持 16-bit PCM`, 'unsupported_audio')
      if (wav.rate < MIN_RATE || wav.rate > MAX_RATE) {
        throw new HttpError(400, `WAV 采样率 ${wav.rate} 超出 ${MIN_RATE}–${MAX_RATE}`, 'bad_rate')
      }
      if (wav.channels !== 1) throw new HttpError(400, 'WAV 声道目前只支持单声道 1', 'bad_channels')
      pcm = wav.pcm
      effectiveRate = wav.rate
      effectiveChannels = wav.channels
      if (pcm.length === 0) throw new HttpError(400, '空音频', 'empty_audio')
      if (pcm.length % 2 !== 0) throw new HttpError(400, 'PCM16 音频字节数必须是 2 的倍数', 'bad_audio')
    } else if (pcm.length % 2 !== 0) {
      throw new HttpError(400, 'PCM16 音频字节数必须是 2 的倍数', 'bad_audio')
    }

    const seconds = pcm.length / (effectiveRate * effectiveChannels * 2)

    // 本机运行时优先于 mock：配置通道是 mock 时，管理页改用本机模型也不能被演示分支截走。
    if (isLocalEndpoint(up.baseUrl)) {
      if (!this.voiceRuntime) throw new HttpError(503, '本机语音运行时未启用', 'voice_not_configured')
      try {
        const text = await this.voiceRuntime.transcribe(pcmToWav(pcm, effectiveRate, effectiveChannels))
        this.record(user, ch, { model: ch.asrModel, kind: 'asr', status: 'ok', latencyMs: Date.now() - started, audioSeconds: seconds })
        sendJson(res, 200, { text })
      } catch (err) {
        this.record(user, ch, { model: ch.asrModel, kind: 'asr', status: err instanceof HttpError ? err.code : 'local_asr_failed', latencyMs: Date.now() - started })
        throw err instanceof HttpError ? err : new HttpError(502, '本机识别失败', 'local_asr_failed')
      }
      return
    }

    if (up.kind === 'mock') {
      this.record(user, ch, {
        model: ch.asrModel,
        kind: 'asr',
        status: 'ok',
        latencyMs: Date.now() - started,
        audioSeconds: seconds,
      })
      sendJson(res, 200, { text: '（离线演示）这是模拟的语音识别结果，不是真实上游。' })
      return
    }

    const boundary = '----valimart' + Date.now().toString(16)
    const body = multipart({ model: ch.asrModel, response_format: 'json' }, boundary, {
      name: 'speech.wav',
      type: 'audio/wav',
      data: pcmToWav(pcm, effectiveRate, effectiveChannels),
    })
    const origin = String(up.baseUrl ?? '').replace(/\/+$/, '')

    const arm = this.armUpstream(res, ch.timeoutMs)
    try {
      let upstreamRes
      try {
        upstreamRes = await this.fetch(`${origin}/audio/transcriptions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${up.apiKey}`,
            'content-type': `multipart/form-data; boundary=${boundary}`,
          },
          body,
          signal: arm.ac.signal,
          // 上游 30x 会把 Authorization 转发到新地址：宁可失败也不外带凭据。
          redirect: 'error',
        })
      } catch (err) {
        throw this.upstreamFailure(arm, err, '识别')
      }
      if (!upstreamRes.ok) {
        // 不把上游错误体直接交给设备：有的提供商会回显请求/内部详情，
        // 包括误配的凭据或端点。HTTP 状态只写进网关账本，设备只拿稳定错误码。
        await readBoundedText(upstreamRes, MAX_TEXT_BYTES)
        const err = new HttpError(502, `语音上游识别失败（HTTP ${upstreamRes.status}）`, 'upstream_error')
        err.ledgerStatus = `upstream_${upstreamRes.status}`
        throw err
      }
      const text = await readBoundedText(upstreamRes, MAX_TEXT_BYTES)
      let transcript = ''
      try {
        const json = JSON.parse(text)
        transcript = String(json.text ?? json.output?.text ?? '')
      } catch {
        transcript = text.trim()
      }
      this.record(user, ch, { model: ch.asrModel, kind: 'asr', status: 'ok', latencyMs: Date.now() - started, audioSeconds: seconds })
      sendJson(res, 200, { text: transcript })
    } catch (err) {
      const status = arm.reason === 'timeout'
        ? 'timeout'
        : arm.reason === 'client'
          ? 'client_aborted'
          : err.ledgerStatus ?? (err instanceof HttpError ? err.code : 'upstream_unreachable')
      this.record(user, ch, { model: ch.asrModel, kind: 'asr', status, latencyMs: Date.now() - started })
      if (arm.reason === 'client') return // 设备已断开，无处可回
      throw this.upstreamFailure(arm, err, '识别')
    } finally {
      arm.done()
    }
  }

  /**
   * POST /v1/audio/speech
   * body: {input, format:'pcm'}（format 只认 pcm；model/voice 由网关配置决定，不收客户端的）。
   * 回包：裸 16-bit LE 单声道 PCM，响应头 x-audio-rate / x-audio-channels / x-audio-bits。
   */
  async handleSpeech(req, res) {
    const { user } = this.authenticate(req)
    const ch = this.channelConfig()
    const up = this.upstreamFor(ch, 'tts')
    const started = Date.now()
    this.assertQuota(user, ch.provider)

    const raw = await readBody(req, MAX_SPEECH_BODY_BYTES)
    let body
    try {
      body = JSON.parse(raw.toString('utf8') || '{}')
    } catch {
      throw new HttpError(400, '请求体必须是 JSON', 'invalid_body')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, '请求体必须是 JSON 对象', 'invalid_body')
    }
    if (typeof body.input !== 'string') throw new HttpError(400, 'input 必须是字符串', 'invalid_input')
    const input = body.input.trim()
    if (!input) throw new HttpError(400, '缺少 input', 'missing_input')
    if (input.length > 2000) throw new HttpError(413, 'input 超过 2000 字', 'input_too_long')
    // 设备协议只要 pcm 裸流；别的 format 不做通用透传（回包内容会随之变格式，设备播不了）。
    if (body.format != null && String(body.format).toLowerCase() !== 'pcm') {
      throw new HttpError(400, 'format 目前只支持 pcm', 'unsupported_format')
    }

    const sendPcm = (pcm, rate, extraHeaders = {}) => {
      res.writeHead(200, {
        'content-type': 'audio/pcm',
        'content-length': pcm.length,
        'x-audio-rate': String(rate),
        'x-audio-channels': '1',
        'x-audio-bits': '16',
        'cache-control': 'no-store',
        ...extraHeaders,
      })
      res.end(pcm)
    }

    if (isLocalEndpoint(up.baseUrl)) {
      if (!this.voiceRuntime) throw new HttpError(503, '本机语音运行时未启用', 'voice_not_configured')
      try {
        const audio = await this.voiceRuntime.speak(input, ch.voice)
        const wav = splitWav(audio)
        if (!wav || !isPlayablePcmWav(wav)) throw new HttpError(502, '本机合成没有返回可播放的 WAV', 'local_tts_failed')
        this.record(user, ch, { model: ch.ttsModel, kind: 'tts', status: 'ok', latencyMs: Date.now() - started, audioSeconds: wav.pcm.length / (wav.rate * 2) })
        sendPcm(wav.pcm, wav.rate)
      } catch (err) {
        this.record(user, ch, { model: ch.ttsModel, kind: 'tts', status: err instanceof HttpError ? err.code : 'local_tts_failed', latencyMs: Date.now() - started })
        throw err instanceof HttpError ? err : new HttpError(502, '本机合成失败', 'local_tts_failed')
      }
      return
    }

    if (up.kind === 'mock') {
      // 700 ms 的 440 Hz 正弦，16 kHz 单声道，给设备端一个可播放的真实 PCM。
      const rate = 16000
      const samples = (rate * 700) / 1000
      const pcm = Buffer.alloc(samples * 2)
      for (let i = 0; i < samples; i++) {
        const s = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000)
        pcm.writeInt16LE(s, i * 2)
      }
      this.record(user, ch, { model: ch.ttsModel, kind: 'tts', status: 'ok', latencyMs: Date.now() - started, audioSeconds: 0.7 })
      sendPcm(pcm, rate, { 'x-audio-mock': '1' })
      return
    }

    const origin = String(up.baseUrl ?? '').replace(/\/+$/, '')
    const arm = this.armUpstream(res, ch.timeoutMs)
    try {
      let upstreamRes
      try {
        upstreamRes = await this.fetch(`${origin}/audio/speech`, {
          method: 'POST',
          headers: { authorization: `Bearer ${up.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: ch.ttsModel,
            input,
            voice: ch.voice,
            // 一律向上游要 wav：头里带真实采样率，网关可以如实转告设备。
            response_format: 'wav',
          }),
          signal: arm.ac.signal,
          redirect: 'error',
        })
      } catch (err) {
        throw this.upstreamFailure(arm, err, '合成')
      }
      if (!upstreamRes.ok) {
        // 同 ASR：上游体不透传给设备，避免泄漏可能被回显的内部/凭据详情。
        await readBoundedText(upstreamRes, MAX_TEXT_BYTES)
        const err = new HttpError(502, `语音上游合成失败（HTTP ${upstreamRes.status}）`, 'upstream_error')
        err.ledgerStatus = `upstream_${upstreamRes.status}`
        throw err
      }
      const audio = await readBounded(upstreamRes, ch.maxTtsBytes)
      const wav = splitWav(audio)
      // 上游没按约定回 WAV：宁可明确失败，也不能把 mp3/opus 字节当 PCM 骗设备去播。
      if (!wav) throw new HttpError(502, '语音上游没有返回 WAV（网关统一向上游要 wav）', 'bad_upstream_audio')
      if (!isPlayablePcmWav(wav)) {
        throw new HttpError(
          502,
          `语音上游返回的音频设备播不了（${wav.bits}-bit / ${wav.channels} 声道 / ${wav.rate} Hz，需要 16-bit 单声道 ${MIN_RATE}–${MAX_RATE} Hz）`,
          'unsupported_audio',
        )
      }
      this.record(user, ch, {
        model: ch.ttsModel,
        kind: 'tts',
        status: 'ok',
        latencyMs: Date.now() - started,
        audioSeconds: wav.pcm.length / (wav.rate * 2),
      })
      sendPcm(wav.pcm, wav.rate)
    } catch (err) {
      const status = arm.reason === 'timeout'
        ? 'timeout'
        : arm.reason === 'client'
          ? 'client_aborted'
          : err.ledgerStatus ?? (err instanceof HttpError ? err.code : 'upstream_unreachable')
      this.record(user, ch, { model: ch.ttsModel, kind: 'tts', status, latencyMs: Date.now() - started })
      if (arm.reason === 'client') return
      throw this.upstreamFailure(arm, err, '合成')
    } finally {
      arm.done()
    }
  }

  /**
   * 管理页「测试」：用候选通道跑一次 TTS → ASR 往返，真实验证端点、密钥、模型名、
   * 回包格式和采样率能不能串起来。与设备路径共用同一套上游请求（redirect:'error'、
   * 超时、断连取消、回包上限、WAV 校验）；失败只回阶段 + 稳定错误码 + 中文摘要，
   * 不透传上游原文——有的提供商会把请求细节甚至密钥片段回显在错误体里。
   *
   * 测试调用照样记账（tag=voice-test），但不查额度：诊断不该被自己的周额度卡住。
   * 返回 200 + { ok, mock, totalMs, tts, asr, error }，由管理页展示，不抛 HTTP 错误。
   */
  async testChannel(ch, res, user) {
    const started = Date.now()
    const out = { ok: false, mock: ch.kind === 'mock', totalMs: 0, tts: null, asr: null, error: null }
    const finish = () => {
      out.totalMs = Date.now() - started
      return out
    }
    if (ch.kind === 'mock') {
      out.ok = true
      out.tts = { rate: 16000, seconds: 0.7, latencyMs: 0 }
      out.asr = { text: '（离线演示）mock 通道不会真的合成或识别语音。', latencyMs: 0 }
      return finish()
    }
    // 页面在测试开始前就关了：不要为了没人看的结果去调付费上游。
    if (res.destroyed || res.writableEnded) {
      out.error = { stage: 'tts', code: 'client_closed', message: '管理页已关闭，测试取消' }
      return finish()
    }
    const text = '你好，这是一条语音通道测试。'
    // 必须在本机分支之前声明：const 没有提升，本机路径里提前调用会 ReferenceError。
    const recordTest = (kind, model, t0, status, audioSeconds = 0) => {
      if (!user) return
      this.record(user, ch, {
        model,
        kind,
        status,
        latencyMs: Date.now() - t0,
        audioSeconds,
        tag: 'voice-test',
      })
    }
    if (isLocalEndpoint(ch.ttsBaseUrl) || isLocalEndpoint(ch.asrBaseUrl)) {
      if (!this.voiceRuntime) {
        out.error = { stage: 'tts', code: 'voice_not_configured', message: '本机语音运行时未启用' }
        return finish()
      }
      const t0 = Date.now()
      try {
        const audio = await this.voiceRuntime.speak(text, ch.voice)
        const wav = splitWav(audio)
        if (!wav || !isPlayablePcmWav(wav)) throw new HttpError(502, '本机合成没有返回可播放的 WAV', 'local_tts_failed')
        out.tts = { rate: wav.rate, seconds: Math.round((wav.pcm.length / (wav.rate * 2)) * 1000) / 1000, latencyMs: Date.now() - t0 }
        recordTest('tts', ch.ttsModel, t0, 'ok', out.tts.seconds)
        const a0 = Date.now()
        const recognized = await this.voiceRuntime.transcribe(pcmToWav(wav.pcm, wav.rate, 1))
        out.asr = { text: String(recognized).slice(0, 2000), latencyMs: Date.now() - a0 }
        recordTest('asr', ch.asrModel, a0, 'ok', out.tts.seconds)
        out.ok = true
      } catch (err) {
        const stage = out.tts ? 'asr' : 'tts'
        out.error = { stage, code: err instanceof HttpError ? err.code : 'local_tts_failed', message: err instanceof HttpError ? err.message : '本机语音失败' }
        recordTest(stage, stage === 'tts' ? ch.ttsModel : ch.asrModel, t0, out.error.code)
      }
      return finish()
    }
    const ttsOrigin = String(ch.ttsBaseUrl ?? '').replace(/\/+$/, '')
    const asrOrigin = String(ch.asrBaseUrl ?? '').replace(/\/+$/, '')
    const fail = (stage, err, arm, t0, kind, model) => {
      const timedOut = arm?.reason === 'timeout'
      const code = timedOut ? 'timeout' : err instanceof HttpError ? err.code : 'upstream_unreachable'
      const message = timedOut
        ? `语音上游超时（${stage === 'tts' ? '合成' : '识别'}）`
        : err instanceof HttpError
          ? err.message
          : '语音上游不可达'
      recordTest(kind, model, t0, code)
      out.error = { stage, code, message }
      return finish()
    }

    // 第一段：TTS → WAV（顺便验证上游采样率和设备可播性）。
    let pcm = null
    let rate = ch.ttsRate
    {
      const t0 = Date.now()
      const arm = this.armUpstream(res, ch.timeoutMs)
      try {
        let upstreamRes
        try {
          upstreamRes = await this.fetch(`${ttsOrigin}/audio/speech`, {
            method: 'POST',
            headers: { authorization: `Bearer ${ch.ttsApiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: ch.ttsModel, input: text, voice: ch.voice, response_format: 'wav' }),
            signal: arm.ac.signal,
            redirect: 'error',
          })
        } catch (err) {
          throw this.upstreamFailure(arm, err, '合成')
        }
        if (!upstreamRes.ok) {
          await readBoundedText(upstreamRes, MAX_TEXT_BYTES)
          throw new HttpError(502, `上游合成失败（HTTP ${upstreamRes.status}）`, 'upstream_error')
        }
        const audio = await readBounded(upstreamRes, ch.maxTtsBytes)
        const wav = splitWav(audio)
        if (!wav) throw new HttpError(502, '上游没有返回 WAV（网关统一向上游要 wav）', 'bad_upstream_audio')
        if (!isPlayablePcmWav(wav)) {
          throw new HttpError(
            502,
            `上游音频设备播不了（${wav.bits}-bit / ${wav.channels} 声道 / ${wav.rate} Hz，需要 16-bit 单声道 ${MIN_RATE}–${MAX_RATE} Hz）`,
            'unsupported_audio',
          )
        }
        pcm = wav.pcm
        rate = wav.rate
        out.tts = {
          rate: wav.rate,
          seconds: Math.round((wav.pcm.length / (wav.rate * 2)) * 1000) / 1000,
          latencyMs: Date.now() - t0,
        }
        recordTest('tts', ch.ttsModel, t0, 'ok', out.tts.seconds)
      } catch (err) {
        if (arm.reason === 'client') {
          out.error = { stage: 'tts', code: 'client_closed', message: '管理页已关闭，测试取消' }
          return finish()
        }
        return fail('tts', err, arm, t0, 'tts', ch.ttsModel)
      } finally {
        arm.done()
      }
    }

    // 第二段：把刚合成的 PCM 重新封 WAV 送去识别 —— 完整走一遍设备链路。
    {
      const t0 = Date.now()
      const arm = this.armUpstream(res, ch.timeoutMs)
      const boundary = '----valimart' + Date.now().toString(16)
      const body = multipart({ model: ch.asrModel, response_format: 'json' }, boundary, {
        name: 'speech.wav',
        type: 'audio/wav',
        data: pcmToWav(pcm, rate, 1),
      })
      try {
        let upstreamRes
        try {
          upstreamRes = await this.fetch(`${asrOrigin}/audio/transcriptions`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${ch.asrApiKey}`,
              'content-type': `multipart/form-data; boundary=${boundary}`,
            },
            body,
            signal: arm.ac.signal,
            redirect: 'error',
          })
        } catch (err) {
          throw this.upstreamFailure(arm, err, '识别')
        }
        if (!upstreamRes.ok) {
          await readBoundedText(upstreamRes, MAX_TEXT_BYTES)
          throw new HttpError(502, `上游识别失败（HTTP ${upstreamRes.status}）`, 'upstream_error')
        }
        const raw = await readBoundedText(upstreamRes, MAX_TEXT_BYTES)
        let transcript = ''
        try {
          const json = JSON.parse(raw)
          transcript = String(json.text ?? json.output?.text ?? '')
        } catch {
          transcript = raw.trim()
        }
        out.asr = { text: transcript.slice(0, 2000), latencyMs: Date.now() - t0 }
        recordTest('asr', ch.asrModel, t0, 'ok', out.tts.seconds)
        out.ok = true
        return finish()
      } catch (err) {
        if (arm.reason === 'client') {
          out.error = { stage: 'asr', code: 'client_closed', message: '管理页已关闭，测试取消' }
          return finish()
        }
        return fail('asr', err, arm, t0, 'asr', ch.asrModel)
      } finally {
        arm.done()
      }
    }
  }
}
