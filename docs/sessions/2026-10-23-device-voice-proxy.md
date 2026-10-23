# 2026-10-23：网关设备语音代理与知识检索

## 目标与范围

为 AI Passport / valimart 无 PSRAM 设备提供只用 `gatewayToken` 的网关能力：

- 裸 PCM 语音识别；
- 裸 PCM 语音合成；
- 与网页登录同权限的企业知识检索。

固件侧固定用 chunked `pcm_s16le`、16 kHz、单声道、最多 6 秒 / 192000 字节；
TTS 接收端仅接受 16-bit 单声道 PCM。此次不改固件、`fnos-probe.mjs` 或其他无关文件，
不使用真实上游凭据/付费调用，不部署、不打包、不提交推送。

## 实现与加固

- 新增 `server/src/audio-proxy.js`，挂载：
  - `GET /v1/audio/config`
  - `POST /v1/audio/transcriptions`
  - `POST /v1/audio/speech`
- `server/src/index.js` 实例化 `AudioProxy`；`GET /v1/knowledge/search` 使用
  `LlmProxy.authenticate` 得到的同一用户调用 `knowledge.search(user, ...)`，确保
  gateway token 的吊销/停用与个人知识权限生效。
- 语音配置开发默认是 `mock`。`/config` 强制返回布尔 `available` 和布尔 `mock`；
  mock TTS 还带 `x-audio-mock: 1`。真实通道仅接受 `openai-compatible` kind，且必须
  已解析密钥；否则 `available: false`，语音请求是 `503 voice_not_configured`，
  不会把本地 mock 伪装成生产可用。
- ASR 只收被验证的 `audio/pcm`（`pcm_s16le`、8–48 kHz、单声道）或合法 16-bit
  PCM WAV；拒绝过去 draft 中的 `multipart/form-data` 原样转发。裸 PCM 被受控地补
  WAV 头、固定模型，并封成 multipart 发给上游。
- TTS 只收 `{input, format:"pcm"}`。客户端提供的 `model` / `voice` 不会影响上游；
  网关固定使用配置，固定向上游要 WAV。只有返回 16-bit、单声道、8–48 kHz PCM WAV
  才剥头转为 `audio/pcm`，携带准确的 `x-audio-rate/channels/bits`。非 WAV、MP3、
  8-bit、立体声和超范围采样率都会明确 `502`，绝不拿任意字节冒充设备 PCM。
- 上游请求加 `redirect: 'error'`（防 Authorization 随 30x 泄漏）、30 秒可配置超时、
  响应端断连时取消、TTS 响应可配置最大尺寸（默认 20 MiB）、ASR 错误文本 64 KiB
  上限。超时为 `504 timeout`，超大为 `502 upstream_too_large`。
- 账本为语音加 `tag: voice-asr|voice-tts` 与 `voice:{kind,audioSeconds}`；只有在
  `voice.asrPriceCnyPerMinute` / `ttsPriceCnyPerMinute` 被明确配置时才计人民币，
  否则 `costCny:0, priceKnown:false`，不改既有文本/媒体语义。

## 鉴权与时效核实

`POST /api/auth/login` 和重新签发网关令牌都传入 `cfg.loginTtlDays ?? 30`。因此这里
`gatewayToken` 与其绑定登录会话都为 **30 天**，并且登录登出、管理员吊销或账号停用
均即时失效。修正了 draft 文档里误写的“gatewayToken 90 天”说法（DB 方法默认值 90
并非当前 API 签发路径所用值）。

## 验证

`server/test/audio.test.js` 扩展到 18 项，均为临时目录 + 本机真实 HTTP stub：

- mock 的显式配置和 PCM 波形；chunked 6 秒 PCM 上送；ASR multipart/WAV 的真实请求打包；
- 上游 WAV 剥壳、模型/voice 固定、错误体、重定向拒绝、超时、响应体上限与客户端取消；
- 畸形 WAV、非 16-bit、立体声、超范围采样率、非 WAV 的拒绝；RIFF 容器完整长度、
  块边界/填充、fmt/data 唯一性、非零格式字段与字节率/样本对齐的一致性；
- 上游发送响应头和首字节后停滞，ASR 与 TTS 都返回 `504 timeout`；
- disabled/revoked token；无密钥语音通道；按秒语音账本与可配置价目；
- gateway token 知识检索的 `limit` 与用户个人记忆隔离。

已运行：

```powershell
node --test server/test/audio.test.js
```

最终结果：18 pass / 0 fail。完整 `npm --prefix E:/orcaWorkspace/company-harness test` 已在 PowerShell 运行：**620 tests：619 pass / 0 fail / 1 skip**（唯一 skip 是未设 `DESK_NATIVE_TEST_KERNEL` 时跳过的「真实内核：Windows 跨进程锁」用例）；不依赖真实付费上游。

## 协议边界与后续联调

详见 `docs/device-voice-api.md`。这是设备 PCM 扩展，并非向任意 OpenAI 音频客户端
承诺的全功能兼容端点；不支持任意 multipart、format、model 或 voice 透传。仍需在
配置真实语音供应商后做其 WAV 输出兼容性与实际 I2S/麦克风联调。

## 提交、推送与网关打包（同日后续）

- 提交前在 PowerShell 重跑全量（`TEMP`/`TMP` 设在仓库外）：620 tests：619 pass / 0 fail / 1 skip。
- 提交 `ba41746`（`feat(server): 网关设备语音代理与设备端知识检索`），只含本次 7 个文件；`fnos-probe.mjs` 仍不入库。
- 推送：`feature/device-voice-proxy` → origin（GitHub，已设上游）与 gitea；gitea `main` 补推
  `ba50fc0..ba67ed2`（14 个提交，快进）。未合入 main；GitHub release 工作流只对 main 触发，本次不触发。
- 打包：`npm run dist:gateway` → `dist/valimart-harness-Gateway-Setup-0.1.0.exe`，27.1 MiB（28,384,700 字节），
  SHA-256 `b85ed743113a5adb71b00a53f3ccda610882dc6ae0908491a438fee4d46b4db5`；makensis 用 electron-builder
  缓存的 nsis-3.0.4.1，WinSW 2.12.0 取自 `build/cache`；随包 `runtime/node.exe` 为构建机 v26.7.0。
- 打包前把同名旧包（10-08，28,372,278 字节，SHA-256
  `681dbbfb34c77dbf70c3c20b3c4d3b17a816a19f48fc2c6f16b927fae257e1aa`）复制为
  `dist/valimart-harness-Gateway-Setup-0.1.0-prev-20261008.exe`，回滚用。
- 冒烟：在暂存目录 `build/gateway/server` 用 `../runtime/node.exe src/index.js`，按服务环境
  （`NODE_ENV=production`、`DESK_GATEWAY_PACKAGED=1`）加临时 `DESK_GATEWAY_DATA` 与端口 18797 启动：
  `/health` 正常（`needsSetup:true`，不播种账号）；`GET /v1/audio/config`、`POST /v1/audio/speech`、
  `GET /v1/knowledge/search` 无令牌均 `401 invalid_token`。临时数据已删。
- 生产配置：暂存 `config.json` 只剩 `deepseek` 上游（mock 被 `toProductionConfig` 去掉），`voice.provider`
  仍是 `mock`，因此安装版在接入真实语音上游前 `available:false`、语音请求 `503 voice_not_configured`。
- 未做：安装/升级本机网关（需 UAC）、真实语音供应商联调、设备端 I2S/麦克风联调。

## 合入 main（同日后续）

- `git merge --ff-only feature/device-voice-proxy`：main 从 `ba67ed2` 快进到 `9913a14`（仓库历史线性，
  不建合并提交），再加本条交接补记，一起推 origin 与 gitea。
- origin/main 推送触发 release 工作流（Windows 客户端 + 网关、VS Code vsix，更新 Release `latest`）；
  `pi-valimart-desk` 版本未变，不发 npm。
- 本地 `dist` 网关包与 main 的 server 代码一致（合入后只多文档提交）。功能分支未删除。
