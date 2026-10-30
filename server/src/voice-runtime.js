/**
 * 本机语音运行时：管理页一键下载 sherpa-onnx，网关自己跑识别和合成。
 *
 * 不引入 Python / Docker。推理走官方命令行：Windows x64 用 MT 构建（不依赖 VC 运行库），
 * Linux 按架构选 x64 或 aarch64 的 CPU 共享库包（树莓派网关是 aarch64）。
 * - ASR：sherpa-onnx-offline + SenseVoice Small int8（中英日韩粤，16 kHz）
 * - TTS：sherpa-onnx-offline-tts + Kokoro 多语言 v1.0（中英，24 kHz，16-bit PCM WAV）
 *
 * 文件落在 dataDir/voice-runtime/，与网关数据一起备份、不进安装包。下载校验 sha256，
 * 解压只接受包内预期前缀，拒绝逃出目录的条目。进程随网关关闭；单次推理有超时。
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import { Readable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { HttpError } from './http.js'

const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download'

/** 运行库按平台各一份。升级时改这里并重测，不要改成「拉 latest」。 */
export const VOICE_RUNTIMES = {
  'win32-x64': {
    name: 'sherpa-onnx-v2.0.0-win-x64-shared-MT-Release.tar.bz2',
    url: `${RELEASE}/v2.0.0/sherpa-onnx-v2.0.0-win-x64-shared-MT-Release.tar.bz2`,
    sha256: 'a66a89c6f3401f3f26a6f53d39ea632900884cbd6a116155e2a85f434b6a7bda',
    bytes: 26_570_586,
    dir: 'sherpa-onnx-v2.0.0-win-x64-shared-MT-Release',
  },
  'linux-x64': {
    name: 'sherpa-onnx-v2.0.0-linux-x64-shared.tar.bz2',
    url: `${RELEASE}/v2.0.0/sherpa-onnx-v2.0.0-linux-x64-shared.tar.bz2`,
    sha256: 'ee729caa387ede28fb62dd0c111e267da5ed436c9438ee502da9ee0a2e03ab7c',
    bytes: 27_896_866,
    dir: 'sherpa-onnx-v2.0.0-linux-x64-shared',
  },
  'linux-arm64': {
    name: 'sherpa-onnx-v2.0.0-linux-aarch64-shared-cpu.tar.bz2',
    url: `${RELEASE}/v2.0.0/sherpa-onnx-v2.0.0-linux-aarch64-shared-cpu.tar.bz2`,
    sha256: '0ee6e6a6de388f9db6f24c241ee6631c7509d47f3c8e5cd7b05259ff92f722b6',
    bytes: 27_802_045,
    dir: 'sherpa-onnx-v2.0.0-linux-aarch64-shared-cpu',
  },
}

/** 模型与平台无关。摘要固定，升级时改这里并重测。 */
export const VOICE_ASSETS = {
  asr: {
    name: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2',
    url: `${RELEASE}/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2`,
    sha256: '7305f7905bfcf77fa0b39388a313f3da35c68d971661a65475b56fb2162c8e63',
    bytes: 165_783_878,
    dir: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
    model: 'model.int8.onnx',
  },
  tts: {
    name: 'kokoro-multi-lang-v1_0.tar.bz2',
    url: `${RELEASE}/tts-models/kokoro-multi-lang-v1_0.tar.bz2`,
    sha256: 'c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298',
    bytes: 349_906_910,
    dir: 'kokoro-multi-lang-v1_0',
    model: 'model.onnx',
  },
}

const LOCAL_KEY = 'local'

/**
 * Kokoro 多语言 v1.0 的说话人编号，取自 model.onnx 的 speaker2id。
 * sherpa 只认数字 sid；名字对不上就退回默认，不再把非数字一律当成 0（0 是英语女声 af_alloy）。
 * 中文是 45–52。默认 zf_xiaoxiao：普通话女声，比 zf_xiaobei 更平、更像日常说话。
 */
export const KOKORO_SPEAKERS = {
  zf_xiaobei: 45,
  zf_xiaoni: 46,
  zf_xiaoxiao: 47,
  zf_xiaoyi: 48,
  zm_yunjian: 49,
  zm_yunxi: 50,
  zm_yunxia: 51,
  zm_yunyang: 52,
}
export const DEFAULT_LOCAL_VOICE = 'zf_xiaoxiao'

export function kokoroSid(voice) {
  const name = String(voice ?? '').trim()
  if (Object.prototype.hasOwnProperty.call(KOKORO_SPEAKERS, name)) return String(KOKORO_SPEAKERS[name])
  if (/^\d+$/.test(name)) return name
  return String(KOKORO_SPEAKERS[DEFAULT_LOCAL_VOICE])
}

/** 本机对应哪一份运行库。Linux 只认 x64 与 arm64，其余架构不提供。 */
export function runtimeKeyFor(platform, arch) {
  if (platform === 'win32' && arch === 'x64') return 'win32-x64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64'
  return null
}

function exe(name, platform) {
  return platform === 'win32' ? `${name}.exe` : name
}

/**
 * sherpa-onnx 自己的参数解析按空格切 Windows 路径，引号也没用。
 * 数据目录在「valimart harness Gateway」下，路径会被切成 C:\ProgramData\valimart，
 * 进程照样退出 0，但没有识别文本。8.3 短路径没有空格；卷上没开短名时留原路径。
 */
export function argPath(file) {
  if (process.platform !== 'win32' || !/[ "]/.test(file)) return file
  const bat = path.join(os.tmpdir(), `desk-short-${process.pid}-${Date.now()}.bat`)
  try {
    // execFile 传给 cmd /c 的引号会被 Node 转义，%~sI 拿到的不是原路径。写进 bat 再跑。
    fsSync.writeFileSync(bat, `@echo off\r\nfor %%I in ("${file.replace(/"/g, '')}") do @echo %%~sI\r\n`, 'utf8')
    const short = execFileSync('cmd.exe', ['/d', '/c', bat], { encoding: 'utf8', windowsHide: true }).trim()
    if (short && !/[ "]/.test(short)) return short
  } catch { /* 短名没开：只能把原路径交出去 */ } finally {
    try { fsSync.rmSync(bat, { force: true }) } catch { /* 临时 bat 清不掉不影响识别 */ }
  }
  return file
}

export class VoiceRuntime {
  constructor({ dataDir, voiceSettings, fetchImpl, tarImpl, spawnImpl, platform, arch } = {}) {
    this.root = path.join(dataDir, 'voice-runtime')
    this.voiceSettings = voiceSettings
    this.fetch = fetchImpl ?? globalThis.fetch
    this.tar = tarImpl ?? 'tar'
    this.spawn = spawnImpl ?? spawn
    this.platform = platform ?? process.platform
    this.arch = arch ?? process.arch
    this.runtimeKey = runtimeKeyFor(this.platform, this.arch)
    this.progress = null
    this.jobs = new Set()
  }

  bin(name) {
    const runtime = VOICE_RUNTIMES[this.runtimeKey]
    if (!runtime) return path.join(this.root, 'unsupported', exe(name, this.platform))
    return path.join(this.root, runtime.dir, 'bin', exe(name, this.platform))
  }

  async installed() {
    const asrDir = path.join(this.root, VOICE_ASSETS.asr.dir)
    const ttsDir = path.join(this.root, VOICE_ASSETS.tts.dir)
    const exists = async (p) => !!(await fs.stat(p).catch(() => null))
    return {
      runtime: await exists(this.bin('sherpa-onnx-offline')) && await exists(this.bin('sherpa-onnx-offline-tts')),
      asr: await exists(path.join(asrDir, 'tokens.txt')) && await exists(path.join(asrDir, VOICE_ASSETS.asr.model)),
      tts: await exists(path.join(ttsDir, 'tokens.txt')) && await exists(path.join(ttsDir, VOICE_ASSETS.tts.model)) && await exists(path.join(ttsDir, 'voices.bin')),
    }
  }

  /** 管理页状态：装了什么、正在下什么、本地通道是否已接上。 */
  async view() {
    const have = await this.installed()
    const channel = this.voiceSettings?.effective()
    const local = channel?.source === 'admin-page' && channel.asrBaseUrl?.startsWith('local://')
    return {
      supported: !!this.runtimeKey,
      platform: this.runtimeKey,
      ...have,
      ready: have.runtime && have.asr && have.tts,
      active: !!local,
      progress: this.progress,
      bytes: { runtime: VOICE_RUNTIMES[this.runtimeKey]?.bytes ?? 0, asr: VOICE_ASSETS.asr.bytes, tts: VOICE_ASSETS.tts.bytes },
    }
  }

  /**
   * 下载缺的部分并解压。已有且文件齐全的不重复下。
   * 同一时刻只允许一个安装；返回最新状态。
   */
  async install() {
    if (!this.runtimeKey) throw new HttpError(400, `本机语音运行时不支持 ${this.platform}/${this.arch}（仅 Windows x64、Linux x64、Linux arm64）`, 'unsupported_platform')
    if (this.progress) throw new HttpError(409, '正在下载，请等这一轮结束', 'install_busy')
    const have = await this.installed()
    const steps = ['runtime', 'asr', 'tts'].filter((id) => !have[id])
    try {
      for (const id of steps) await this.fetchAsset(id)
      if (!steps.length) this.progress = { id: 'done', received: 0, total: 0 }
    } finally {
      this.progress = null
    }
    return this.view()
  }

  assetOf(id) {
    return id === 'runtime' ? VOICE_RUNTIMES[this.runtimeKey] : VOICE_ASSETS[id]
  }

  async fetchAsset(id) {
    const asset = this.assetOf(id)
    await fs.mkdir(this.root, { recursive: true })
    const dest = path.join(this.root, `${asset.name}.part`)
    this.progress = { id, label: asset.name, received: 0, total: asset.bytes }
    const res = await this.fetch(asset.url, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new HttpError(502, `下载 ${asset.name} 失败（HTTP ${res.status}）`, 'download_failed')
    const hash = createHash('sha256')
    let received = 0
    const file = createWriteStream(dest)
    const stream = typeof res.body.getReader === 'function' ? Readable.fromWeb(res.body) : res.body
    try {
      for await (const chunk of stream) {
        received += chunk.length
        if (received > asset.bytes + 1024) throw new HttpError(502, `${asset.name} 比预期大，已中止`, 'download_too_large')
        hash.update(chunk)
        this.progress = { ...this.progress, received }
        if (!file.write(chunk)) await new Promise((r) => file.once('drain', r))
      }
    } catch (err) {
      file.destroy()
      await fs.rm(dest, { force: true })
      throw err
    }
    await new Promise((resolve, reject) => file.end((e) => (e ? reject(e) : resolve())))
    const digest = hash.digest('hex')
    if (digest !== asset.sha256) {
      await fs.rm(dest, { force: true })
      throw new HttpError(502, `${asset.name} 校验不符（期望 ${asset.sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…）`, 'bad_checksum')
    }
    await this.extract(dest, asset)
    await fs.rm(dest, { force: true })
  }

  /**
   * 解压前列出条目：必须全部落在预期目录里，否则整包拒绝。
   * 清单写到文件再逐行读。run() 只留输出尾部，Kokoro 的清单有两万多字符，
   * 从内存里切会把第一行切成半截，前缀对不上就被误判成非法路径。
   */
  async extract(archive, asset) {
    const listFile = `${archive}.list`
    let list
    let entries
    try {
      list = await this.run(this.tar, ['-tjf', archive], { cwd: this.root, stdoutFile: listFile })
      try {
        entries = (await fs.readFile(listFile, 'utf8')).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      } catch (err) {
        throw new HttpError(502, `无法读取 ${asset.name} 的文件清单：${err.message}`, 'bad_archive')
      }
      if (list.code !== 0) throw new HttpError(502, `列出 ${asset.name} 失败：${list.stderr.trim().slice(0, 200)}`, 'bad_archive')
    } finally {
      await fs.rm(listFile, { force: true })
    }
    const prefix = `${asset.dir}/`
    for (const entry of entries) {
      if (path.isAbsolute(entry) || entry.split('/').includes('..') || !entry.startsWith(prefix)) {
        throw new HttpError(502, `${asset.name} 含预期之外的路径 ${entry}，已拒绝解压`, 'bad_archive')
      }
    }
    const extracted = await this.run(this.tar, ['-xjf', archive], { cwd: this.root })
    if (extracted.code !== 0) throw new HttpError(502, `解压 ${asset.name} 失败：${extracted.stderr.trim().slice(0, 200)}`, 'extract_failed')
    const have = await this.installed()
    const key = asset.dir === VOICE_RUNTIMES[this.runtimeKey]?.dir ? 'runtime' : asset === VOICE_ASSETS.asr ? 'asr' : 'tts'
    if (!have[key]) throw new HttpError(502, `${asset.name} 解压后缺文件`, 'extract_incomplete')
  }

  /** 把本机运行时接成当前语音通道。已装好才允许。 */
  async activate(user) {
    const have = await this.installed()
    if (!have.runtime || !have.asr || !have.tts) throw new HttpError(400, '请先下载本机语音运行时', 'runtime_missing')
    return this.voiceSettings.update({
      asrBaseUrl: 'local://asr',
      asrApiKey: LOCAL_KEY,
      ttsBaseUrl: 'local://tts',
      ttsApiKey: LOCAL_KEY,
      asrModel: 'sense-voice-small-int8',
      ttsModel: 'kokoro-multi-lang-v1.0',
      voice: DEFAULT_LOCAL_VOICE,
      ttsRate: 24000,
      user,
    })
  }

  /** 识别一段 WAV，返回文本。失败抛 HttpError，由设备路径统一记账。 */
  async transcribe(wav) {
    const dir = path.join(this.root, VOICE_ASSETS.asr.dir)
    const input = await this.tempWav(wav)
    try {
      const out = await this.run(this.bin('sherpa-onnx-offline'), [
        `--tokens=${argPath(path.join(dir, 'tokens.txt'))}`,
        `--sense-voice-model=${argPath(path.join(dir, VOICE_ASSETS.asr.model))}`,
        '--num-threads=2',
        argPath(input),
      ])
      if (out.code !== 0) throw new HttpError(502, '本机识别失败', 'local_asr_failed')
      // v2.0.0 的 JSON 在 stdout；日志在 stderr。只看一边时，进程成功也会报「没有返回文本」。
      const line = `${out.stdout}\n${out.stderr}`.split(/\r?\n/).map((s) => s.trim()).find((s) => s.startsWith('{'))
      if (!line) throw new HttpError(502, '本机识别没有返回文本', 'local_asr_failed')
      let json
      try { json = JSON.parse(line) } catch { throw new HttpError(502, '本机识别结果无法解析', 'local_asr_failed') }
      return String(json.text ?? '')
    } finally {
      await fs.rm(input, { force: true })
    }
  }

  /** 合成一段文本，返回 WAV buffer。 */
  async speak(text, voice) {
    const dir = path.join(this.root, VOICE_ASSETS.tts.dir)
    const output = path.join(os.tmpdir(), `desk-tts-${process.pid}-${Date.now()}.wav`)
    const sid = kokoroSid(voice)
    try {
      const out = await this.run(this.bin('sherpa-onnx-offline-tts'), [
        `--kokoro-model=${argPath(path.join(dir, VOICE_ASSETS.tts.model))}`,
        `--kokoro-voices=${argPath(path.join(dir, 'voices.bin'))}`,
        `--kokoro-tokens=${argPath(path.join(dir, 'tokens.txt'))}`,
        `--kokoro-data-dir=${argPath(path.join(dir, 'espeak-ng-data'))}`,
        `--kokoro-lexicon=${argPath(path.join(dir, 'lexicon-us-en.txt'))},${argPath(path.join(dir, 'lexicon-zh.txt'))}`,
        '--num-threads=2',
        `--sid=${sid}`,
        `--output-filename=${argPath(output)}`,
        text,
      ])
      if (out.code !== 0) throw new HttpError(502, '本机合成失败', 'local_tts_failed')
      return await fs.readFile(output)
    } finally {
      await fs.rm(output, { force: true })
    }
  }

  async tempWav(wav) {
    const file = path.join(os.tmpdir(), `desk-asr-${process.pid}-${Date.now()}.wav`)
    await fs.writeFile(file, wav)
    return file
  }

  /** Linux 共享库包的 .so 在 lib/，不在系统路径里。 */
  libEnv() {
    if (this.platform === 'win32' || !this.runtimeKey) return undefined
    const dir = path.join(this.root, VOICE_RUNTIMES[this.runtimeKey].dir, 'lib')
    return { ...process.env, LD_LIBRARY_PATH: dir }
  }

  /**
   * 跑一个子进程，收集输出；超时杀进程树。
   * stdoutFile 把标准输出整份落盘（tar 清单会超过内存里保留的尾部）。
   */
  run(command, args, { cwd, timeoutMs = 120_000, stdoutFile } = {}) {
    return new Promise((resolve, reject) => {
      const stdoutFd = stdoutFile ? fsSync.openSync(stdoutFile, 'w') : 'pipe'
      const child = this.spawn(command, args, { cwd, windowsHide: true, env: this.libEnv(), stdio: [ 'ignore', stdoutFd, 'pipe' ] })
      if (stdoutFile) fsSync.closeSync(stdoutFd)
      this.jobs.add(child)
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => { child.kill() }, timeoutMs)
      if (!stdoutFile) child.stdout?.on('data', (c) => { stdout += c.toString('utf8') })
      child.stderr?.on('data', (c) => { stderr += c.toString('utf8') })
      child.once('error', (err) => { clearTimeout(timer); this.jobs.delete(child); reject(new HttpError(502, `无法启动 ${path.basename(command)}：${err.message}`, 'runtime_spawn_failed')) })
      child.once('exit', (code) => { clearTimeout(timer); this.jobs.delete(child); resolve({ code, stdout: stdout.slice(-8000), stderr: stderr.slice(-8000) }) })
    })
  }

  close() {
    for (const child of this.jobs) { try { child.kill() } catch { /* 已退出 */ } }
    this.jobs.clear()
  }
}
