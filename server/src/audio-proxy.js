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

export const MIN_RATE = 8000
export const MAX_RATE = 48000

/** 识别入站上限：设备 6 秒 / 192000 字节绰绰有余，桌面对文件转写也够。 */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024
/** 合成请求 JSON 上限（input ≤ 2000 字，绰绰有余）。 */
const MAX_SPEECH_BODY_BYTES = 64 * 1024
/** 上游识别文本上限：正常就几个字，64 KiB 已是滥用。 */
const MAX_TEXT_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TTS_BYTES = 20 * 1024 * 1024

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
 */
export function splitWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  const end = buf.readUInt32LE(4) + 8
  if (end !== buf.length) return null
  let at = 12
  let format = null
  let pcm = null
  while (at < end) {
    if (at + 8 > end) return null
    const id = buf.toString('ascii', at, at + 4)
    const size = buf.readUInt32LE(at + 4)
    const body = at + 8
    const next = body + size + (size % 2)
    if (next > end) return null
    if (id === 'fmt ') {
      if (format || size < 16) return null
      const fmtTag = buf.readUInt16LE(body)
      const channels = buf.readUInt16LE(body + 2)
      const rate = buf.readUInt32LE(body + 4)
      const byteRate = buf.readUInt32LE(body + 8)
      const blockAlign = buf.readUInt16LE(body + 12)
      const bits = buf.readUInt16LE(body + 14)
      if (!channels || !bits || bits % 8 || !rate ||
          blockAlign !== channels * (bits / 8) || byteRate !== rate * blockAlign) return null
      format = { fmtTag, channels, rate, bits, blockAlign }
    } else if (id === 'data') {
      if (!format || pcm || !size || size % format.blockAlign) return null
      pcm = buf.subarray(body, body + size)
    }
    at = next
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
  constructor({ db, cfg, ledger, proxy, fetchImpl }) {
    this.db = db
    this.cfg = cfg
    this.ledger = ledger
    this.proxy = proxy
    // 测试注入位：本地起一个假语音上游，验证真实打包/剥壳逻辑而不是 Mock 分支。
    this.fetch = fetchImpl ?? ((...args) => fetch(...args))
  }

  /** 复用 llm-proxy 的网关令牌校验（吊销即时生效、停用即 403）。 */
  authenticate(req) {
    return this.proxy.authenticate(req)
  }

  voiceConfig() {
    const v = this.cfg.voice ?? {}
    return {
      provider: v.provider ?? '',
      asrModel: v.asrModel ?? 'whisper-1',
      ttsModel: v.ttsModel ?? 'tts-1',
      voice: v.voice ?? 'alloy',
      ttsRate: Number(v.ttsRate) || 24000,
      timeoutMs: Math.max(1000, Number(v.timeoutMs) || DEFAULT_TIMEOUT_MS),
      maxTtsBytes: Math.max(1024, Number(v.maxTtsBytes) || DEFAULT_MAX_TTS_BYTES),
      asrPriceCnyPerMinute: Number(v.asrPriceCnyPerMinute) || 0,
      ttsPriceCnyPerMinute: Number(v.ttsPriceCnyPerMinute) || 0,
    }
  }

  /** 与文本模型共用周额度：超额时直接拒绝，避免语音绕过限额。 */
  assertQuota(user, providerId) {
    if (this.ledger.exceeded(user, providerId)) {
      throw new HttpError(429, '本周额度已用完', 'quota_exceeded')
    }
  }

  /** 语音通道必须在配置里且可用（mock 或已解析到密钥），否则一律 503。 */
  upstreamFor(providerId) {
    const up = providerId ? this.cfg.upstreams?.[providerId] : undefined
    if (!up || !(['mock', 'openai-compatible'].includes(up.kind)) || (up.kind !== 'mock' && !up.resolvedKey)) {
      throw new HttpError(
        503,
        '网关还没有配置可用的语音通道。请在 server/config.json 的 voice.provider 指定的上游接入 ASR/TTS 并配置密钥。',
        'voice_not_configured',
      )
    }
    return up
  }

  record(user, { provider, model, kind, status, latencyMs, audioSeconds = 0 }) {
    const v = this.voiceConfig()
    const perMinute = kind === 'asr' ? v.asrPriceCnyPerMinute : v.ttsPriceCnyPerMinute
    const seconds = Number(audioSeconds) || 0
    const priced = perMinute > 0
    this.ledger.record({
      userId: user.id,
      username: user.username,
      provider,
      model,
      stream: false,
      status,
      tag: kind === 'asr' ? 'voice-asr' : 'voice-tts',
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
    const v = this.voiceConfig()
    const up = v.provider ? this.cfg.upstreams?.[v.provider] : undefined
    const available = !!up && (up.kind === 'mock' || (up.kind === 'openai-compatible' && !!up.resolvedKey))
    sendJson(res, 200, {
      available,
      // 显式 mock 标记：设备开机必须区分「本地演示音」和「真语音」，不许静默混淆。
      mock: !!(available && up.kind === 'mock'),
      asrModel: v.asrModel,
      ttsModel: v.ttsModel,
      ttsRate: v.ttsRate,
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
    const v = this.voiceConfig()
    const up = this.upstreamFor(v.provider)
    const started = Date.now()
    this.assertQuota(user, v.provider)

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

    if (up.kind === 'mock') {
      this.record(user, {
        provider: v.provider,
        model: v.asrModel,
        kind: 'asr',
        status: 'ok',
        latencyMs: Date.now() - started,
        audioSeconds: seconds,
      })
      sendJson(res, 200, { text: '（离线演示）这是模拟的语音识别结果，不是真实上游。' })
      return
    }

    const boundary = '----valimart' + Date.now().toString(16)
    const body = multipart({ model: v.asrModel, response_format: 'json' }, boundary, {
      name: 'speech.wav',
      type: 'audio/wav',
      data: pcmToWav(pcm, effectiveRate, effectiveChannels),
    })
    const origin = String(up.baseUrl ?? '').replace(/\/+$/, '')

    const arm = this.armUpstream(res, v.timeoutMs)
    try {
      let upstreamRes
      try {
        upstreamRes = await this.fetch(`${origin}/audio/transcriptions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${up.resolvedKey}`,
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
      this.record(user, { provider: v.provider, model: v.asrModel, kind: 'asr', status: 'ok', latencyMs: Date.now() - started, audioSeconds: seconds })
      sendJson(res, 200, { text: transcript })
    } catch (err) {
      const status = arm.reason === 'timeout'
        ? 'timeout'
        : arm.reason === 'client'
          ? 'client_aborted'
          : err.ledgerStatus ?? (err instanceof HttpError ? err.code : 'upstream_unreachable')
      this.record(user, { provider: v.provider, model: v.asrModel, kind: 'asr', status, latencyMs: Date.now() - started })
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
    const v = this.voiceConfig()
    const up = this.upstreamFor(v.provider)
    const started = Date.now()
    this.assertQuota(user, v.provider)

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

    if (up.kind === 'mock') {
      // 700 ms 的 440 Hz 正弦，16 kHz 单声道，给设备端一个可播放的真实 PCM。
      const rate = 16000
      const samples = (rate * 700) / 1000
      const pcm = Buffer.alloc(samples * 2)
      for (let i = 0; i < samples; i++) {
        const s = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000)
        pcm.writeInt16LE(s, i * 2)
      }
      this.record(user, { provider: v.provider, model: v.ttsModel, kind: 'tts', status: 'ok', latencyMs: Date.now() - started, audioSeconds: 0.7 })
      sendPcm(pcm, rate, { 'x-audio-mock': '1' })
      return
    }

    const origin = String(up.baseUrl ?? '').replace(/\/+$/, '')
    const arm = this.armUpstream(res, v.timeoutMs)
    try {
      let upstreamRes
      try {
        upstreamRes = await this.fetch(`${origin}/audio/speech`, {
          method: 'POST',
          headers: { authorization: `Bearer ${up.resolvedKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: v.ttsModel,
            input,
            voice: v.voice,
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
      const audio = await readBounded(upstreamRes, v.maxTtsBytes)
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
      this.record(user, {
        provider: v.provider,
        model: v.ttsModel,
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
      this.record(user, { provider: v.provider, model: v.ttsModel, kind: 'tts', status, latencyMs: Date.now() - started })
      if (arm.reason === 'client') return
      throw this.upstreamFailure(arm, err, '合成')
    } finally {
      arm.done()
    }
  }
}
