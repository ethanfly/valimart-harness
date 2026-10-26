# 设备语音 API

供 AI Passport 等只持网关令牌的设备使用。这是网关的**设备 PCM 扩展**，并不是普通 OpenAI `/v1/audio/*` API 的通用兼容实现：设备只发送/接收此文规定的受限格式，网关才按配置把它翻译为上游兼容请求。

所有端点均要求：

```
Authorization: Bearer <gatewayToken>
```

`gatewayToken` 从 `POST /api/auth/login` 换取。不要用登录会话令牌
`sessionToken` 代替；它只用于 `/api/*`。本配置里登录会话和由它签发的
`gatewayToken` 同用 `loginTtlDays=30`，登出、管理员吊销或账号停用也会立即使
绑定的网关令牌失效。

## 配置语音通道

**推荐：管理页 → 模型 → 语音**（管理员可写，总监只读）。填端点 `baseUrl`、
API Key、ASR/TTS 模型、音色和可选价目，保存即生效，设备下一次语音调用就会用上新通道，
不需要重启网关。管理页设置**整体优先**于 `config.local.json` 的 `voice` 段；点「清除管理页设置」
即回退到配置。

- API Key 只存服务端库，页面和接口只回「是否已配置」，任何响应都不回显 key 值。
- 同一端点保存时 key 留空 = 沿用上次的 key；**换端点必须重填 key**，网关不会把旧密钥发到新地址。
- 「测试连通」会用当前表单值真实跑一次 TTS 合成 → ASR 识别（不保存表单），显示采样率、
  识别文本和两段延迟；失败时只回阶段（合成/识别）和稳定错误码，不透传上游错误原文
  （有的提供商会把请求细节和密钥片段回显在错误体里）。测试调用同样记账，`tag: voice-test`，
  但不受周额度拦截。
- 端点和模型参数存在网关数据库（`voice.json` 集合），随 `server/data` 一起备份。

开发配置默认走 `mock`，会返回模拟识别文本与 700 ms 测试音，响应会显式标明
`mock: true` / `x-audio-mock: 1`。设备不得把 mock 当成真实语音可用性。

没有管理页时（例如首次部署还没登录），也可以在**本地、不入库的**
`server/config.local.json` 里追加一个上游，再把 `voice.provider` 指过去：

```json
{
  "upstreams": {
    "speech": {
      "kind": "openai-compatible",
      "label": "Speech",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "SPEECH_API_KEY",
      "models": []
    }
  },
  "voice": {
    "provider": "speech",
    "asrModel": "whisper-1",
    "ttsModel": "tts-1",
    "voice": "alloy",
    "ttsRate": 24000,
    "timeoutMs": 30000,
    "maxTtsBytes": 20971520
  }
}
```

密钥只在网关进程环境里解析，不会发到设备。`baseUrl` 必须包含版本路径
（例如 `/v1`）；网关只会在后面加 `/audio/transcriptions` 或 `/audio/speech`。
真实上游需要兼容这些端点，且 TTS 必须能返回 **16-bit PCM 单声道 WAV，
8–48 kHz**。网关拒绝重定向，避免把上游 Authorization 带到别处。

语音价目是可选的每分钟人民币估算，管理页或 `config.local.json`
（`asrPriceCnyPerMinute` / `ttsPriceCnyPerMinute`）都可配置。未配置价目时账本记录
`costCny: 0, priceKnown: false`，这不代表供应商免费。

超时 `timeoutMs` 和 TTS 回包上限 `maxTtsBytes` 属于运维参数，只在配置文件里调，
管理页不暴露。

## 查看能力

`GET /v1/audio/config`

```json
{
  "available": true,
  "mock": false,
  "asrModel": "whisper-1",
  "ttsModel": "tts-1",
  "ttsRate": 24000,
  "ttsChannels": 1,
  "ttsBits": 16
}
```

- `available: false`：没有已配置且有密钥的 `openai-compatible` 语音上游
  （也未选择 mock）；请求语音会得到 `503 voice_not_configured`。
- `mock: true`：仅本地离线演示，不是真实 ASR/TTS。
- `ttsRate` 是建议值；真正播放必须读取语音响应头的采样率。
- 此端点不返回上游 URL、API key 或其他凭据。

## 语音识别

`POST /v1/audio/transcriptions?rate=16000&channels=1&encoding=pcm_s16le`

设备固件使用的请求为：

- `Content-Type: audio/pcm`
- body：原始 signed 16-bit little-endian PCM；允许 HTTP chunked 传输。
- `rate`：8000–48000 的整数；固件用 16000。
- `channels`：只能是单声道 1；固件使用 1。
- `encoding`：只能是 `pcm_s16le`。

网关也接受 `audio/wav` 的 16-bit PCM WAV（同样检查采样率/声道），但不会接受
`multipart/form-data` 或任意文件透传。最大请求体 8 MiB。设备可边录边发送，
不需要缓存完整录音；当前固件的 6 秒、192000 字节远低于上限。

网关补 WAV 头后，用受控的 multipart 请求转给配置的上游，固定 `asrModel`；
设备不能指定上游 model、格式或凭据。

成功：`200 application/json`

```json
{ "text": "识别后的文本" }
```

常见失败：空音频 `400 empty_audio`、非法采样率 `400 bad_rate`、非法声道
`400 bad_channels`、编码不是 `pcm_s16le` 的 `400 bad_encoding`、WAV 损坏
`400 bad_wav`、不支持的 WAV PCM 格式 `400 unsupported_audio`、PCM16 非完整采样
`400 bad_audio`、超大 `413`、超时 `504 timeout`。

## 语音合成

`POST /v1/audio/speech`

```json
{ "input": "要念的话", "format": "pcm" }
```

`input` 必填，最多 2000 字；`format` 缺省或为 `pcm`。其他格式、客户端给出的
`model`、`voice` 均不用于控制上游：网关固定使用 `voice.ttsModel` 和
`voice.voice`，并一律向上游请求 WAV，以便验证格式并取得真实采样率。

成功响应必须是：

```
Content-Type: audio/pcm
x-audio-rate: 24000
x-audio-channels: 1
x-audio-bits: 16
Cache-Control: no-store
```

body 是裸 PCM16LE 单声道。设备应先校验 `x-audio-channels: 1` 与
`x-audio-bits: 16`，再按 `x-audio-rate` 配置 I2S，边收边播；不要假设一定是
16 kHz。mock 通道额外返回 `x-audio-mock: 1`。

网关拒绝上游返回的非 WAV、非 16-bit、非单声道或采样率不在 8–48 kHz 的 WAV，
不会把 MP3/Opus/立体声字节伪装成 PCM。RIFF 长度必须与完整容器一致；逐块检查
边界、填充、fmt/data 唯一性和顺序、非空数据，以及 byteRate/blockAlign 与样本
格式的一致性。例外是流式写入者常用的占位符长度：RIFF 与 data 的长度字段同时为
`0xFFFFFFFF`（或 0）时，网关按「data 一直到文件尾」处理并截断到完整采样；
只出现一处占位、其余长度矛盾或声明长度大于实际字节数，仍按坏 WAV 拒绝。
TTS 上游响应上限可用 `voice.maxTtsBytes` 配置（默认 20 MiB）。
ASR 与 TTS 的超时覆盖上游响应头及响应体读取，超时统一返回 `504 timeout`。

## 企业知识检索

`GET /v1/knowledge/search?q=<urlencoded>&limit=2&kinds=handbook,shared,personal,task`

- 与 `/api/knowledge/search` 同一 `knowledge.search(user, ...)` 实现、同一用户权限。
- 不会暴露其他员工的个人记忆；网关令牌吊销、过期或用户停用同样立即失效。
- 返回的是“谁 / 何时 / 在哪里 + 小段摘要”，不是整份文档、不是聊天记录。
- 固件使用 `limit=2`；服务端仍按知识模块的安全上限裁剪请求值。

```json
{
  "query": "查询词",
  "terms": ["查询词"],
  "hits": [{ "kind": "handbook", "title": "文档.md", "path": "_shared/handbook/文档.md", "who": "公司手册", "snippet": "摘要", "score": 1 }],
  "scanned": { "files": 1, "tasks": 0 }
}
```

## 鉴权、额度与记账

- 没令牌、令牌失效或已吊销：`401 invalid_token`。
- 用户停用：`403 account_disabled`。
- 本周额度用完：`429 quota_exceeded`。
- 没有有效语音通道：`503 voice_not_configured`。
- 上游不可达/重定向拒绝：`502 upstream_unreachable`；上游拒绝：`502 upstream_error`
  （网关不透传上游错误体）；上游响应过大：
  `502 upstream_too_large`；上游超时：`504 timeout`。
- 语音请求记入账本，附带 `tag: voice-asr|voice-tts` 和
  `voice:{kind,audioSeconds}`。可配置每分钟价目后才有 `priceKnown: true`；
  不改变既有文本/媒体账本的语义。
- 账本 `provider` 是实际用的通道：管理页设置的通道固定记 `voice-admin`，
  配置文件的通道记 `voice.provider`。周额度按 provider 分别累计。
- 管理页「测试连通」的调用记 `tag: voice-test`，不参与周额度判断。

## 本地验证

```powershell
node --test server/test/audio.test.js server/test/voice-admin.test.js
npm --prefix E:/orcaWorkspace/company-harness test
```

测试使用临时数据目录和本机 HTTP stub 上游，不调用真实语音服务。真实供应商的
协议兼容性以及设备麦克风/扬声器表现仍需要单独联调；没有部署或重打网关安装包。

管理页用的接口（`Bearer` 登录会话令牌）：

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/admin/voice` | 总监 / 管理员 | 状态、来源、端点、是否已配置密钥、表单初值 |
| PUT | `/api/admin/voice` | 管理员 | 保存管理页通道（立即生效） |
| DELETE | `/api/admin/voice` | 管理员 | 清除管理页通道，回退到配置 |
| POST | `/api/admin/voice/test` | 管理员 | TTS → ASR 往返测试，固定 200 + `{ok,...}` |
