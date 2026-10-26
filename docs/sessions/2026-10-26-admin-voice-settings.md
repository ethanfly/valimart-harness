# 2026-10-26：管理页语音通道（模型 → 语音）

## 起点

上一轮（10-23）把设备语音代理做完了，但接真实 ASR/TTS 只能改 `server/config.local.json`
再重启网关：管理员在管理页里既看不到状态，也改不了。用户要求「增加管理页面」，
并同意顺手修掉 WAV 头的问题。

## 做了什么

### 新模块 `server/src/voice-settings.js`

- 持久化在网关库 `voice.json` 集合：`{ channel: { baseUrl, apiKey, asrModel, ttsModel,
  voice, ttsRate, asrPriceCnyPerMinute, ttsPriceCnyPerMinute, updatedAt, updatedBy } }`。
- `effective()` 是唯一解析入口：管理页通道 > `config.voice` + 对应上游；管理页通道是
  **整体**生效（不会出现「端点用管理页、模型名用 mock 配置」的混合体）。
- `view()` 只回 `available / mock / source / sourceLabel / endpoint / keyConfigured /
  模型参数 / form 初值`——任何路径都不回 key。
- `normalizeBaseUrl()`：只收 http(s)，拒绝账号、查询串、锚点，去尾部斜杠；读库时也用它，
  所以坏记录等于没配。
- `update()`：首次保存必须填 key；留空沿用旧 key 的条件是**端点规范化后相同**；
  模型/音色拒绝 `\r\n"\\` 和控制字符（这些值会拼进上游 multipart 头）。
- `testChannel()`：表单填了非法端点就 400，不会悄悄改测当前通道。

### `server/src/audio-proxy.js`

- `channelConfig()` 直接取 `VoiceSettings.effective()`；`upstreamFor(channel)` /
  `record(user, channel, …)` 都用同一个通道对象，账本 provider 只有管理页通道才是
  `voice-admin`（配置通道仍用 `voice.provider`），配额归属不再串。
- `/v1/audio/config` 的 `available` 改成严格布尔：草稿里曾写成
  `up.kind === 'openai-compatible' && (apiKey || resolvedKey)`，结果把密钥字符串
  直接回了设备；既有测试 `assert.ok(!JSON.stringify(cfg).includes('sk-'))` 抓到了。
- 新增 `testChannel(ch, res, user)`：与设备路径共用 `fetch`（`redirect:'error'`）、
  `armUpstream`（超时 + 断连取消）、`readBounded`、`splitWav`、`pcmToWav`、multipart。
  失败回 `{ok:false,error:{stage,code,message}}`，不带上游原文；测试调用记
  `tag: voice-test`，不查额度。

### `splitWav` 占位符

真实 OpenAI TTS 的 WAV 在 RIFF 和 data 长度字段写 `0xFFFFFFFF`（流式写入不知道总长）。
现在：

- RIFF 是占位符（`0xFFFFFFFF` 或 0）→ `end = buf.length`；否则必须严格等于实际长度。
- data 占位符只在**流式容器**里生效：取到文件尾、截断到 blockAlign 倍数、非空；
  读完 data 立刻结束循环。
- 其他块不接受占位符；`fmt` 的越界检查放在读字段之前，截断块返回 null 而不是 RangeError。
- 只出现一处占位（RIFF 严格、data 占位）视为矛盾容器，拒绝。

### `server/src/api.js` / `index.js` / `admin-page.js`

- 路由改为薄封装：鉴权 + `voiceSettings.update/clear/testChannel` + `audio.testChannel`；
  `audio` 通过 `registerApi` 的 ctx 传入。
- 管理页：模型页新增「语音」子标签（状态卡 + 表单 + 保存/测试连通/清除），
  表单初值来自 `view().form`，key 输入框在已配置时占位 `********`、留空即保持；
  子标签加了记忆，保存/测试后 `renderMain()` 不再跳回「模型通道」。

## 测试

- `server/test/voice-admin.test.js`（7）：员工 403 / 总监只读 / 管理员可写；各类非法输入
  400 且不落库；保存后设备 `/v1/audio/config` 与 `/v1/audio/speech` 立即换通道、账本
  `provider=voice-admin` 且按价目计费；同端点留空保留 key、换端点留空拒绝；测试往返成功、
  上游 401 时 `ok:false` 且响应里没有 key 原文；DELETE 回退配置并恢复配置密钥。
- `server/test/audio.test.js`（18 → 20）：新增占位符结构用例 + 上游返回占位符 WAV 的
  端到端合成用例。
- 全量 `npm test`：629 tests，628 pass / 0 fail / 1 skip（缺 `kernel.tar` 的
  `preparePackaged`，预期）。PowerShell 下跑，`TEMP`/`TMP` 指向仓库外。

## 没做 / 留给下次

- 真实供应商联调（端点、模型名、音色按供应商实际填；`whisper-1`/`tts-1`/`alloy`
  是 OpenAI 的默认值）。
- 安装版网关未重装；e2e（Playwright）未跑。
- `config.voice.timeoutMs` / `maxTtsBytes` 仍然只在配置文件里调（运维参数，故意不放到
  管理页）。
