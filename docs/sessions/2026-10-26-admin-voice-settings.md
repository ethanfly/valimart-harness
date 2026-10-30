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

## 同轮追加：管理页选择默认模型

用户在同一天追加「并支持网关管理页选择默认模型」。后端本来就有
`PATCH /api/company`（接受 `defaultModel` / `quickInferenceModel`），缺的是服务端校验和
管理页入口：

- **管理页**：「模型 → 模型目录」顶部加「默认模型」卡片：当前值、可用模型数、两个下拉
  （默认模型 / 快速推理）和保存。只列当前目录里真实可用的模型；已保存但暂时下架的 id
  仍保留一项「（当前不可用）」，避免悄悄改掉配置。总监只读。
- **只提交改过的字段**：冒烟时发现，配置里的 `quickInferenceModel`（`deepseek-v4-flash`）
  在只接了 mock 通道的网关里不在目录中；如果原样回传，服务端按「不在目录中」拒绝，
  连默认模型都保存不了。现在前端比较初始值，只发变化的字段。
- **服务端校验**：`defaultModel` / `quickInferenceModel` 必须是 `models()` 里的 id，
  否则 `400 unknown_model`；`null`/空串表示回退配置文件（`companyView()` 的 `??` 链）。
  之前这里完全不校验，写错 id 会让客户端静默退回第一个模型。
- **验证**：`gateway.test.js` 增加 1 项（默认值保存后 `/api/models` 生效、未知 id 400、
  `null` 回退、总监 403）与 HTML 断言；Playwright 冒烟：从 mock-echo 切到 mock-fast →
  卡片与 `/api/models` 都变、停在模型目录子标签、总监页面没有表单；全量
  `npm test` **630 tests / 629 pass / 0 fail / 1 skip**。

## 同轮再追加：网关自己下载并运行语音模型

用户澄清：要的是网关端自动下载、部署语音模型，不是去接一个已有的本地服务。

- sherpa-onnx 官方只发命令行和 WebSocket 服务，没有 OpenAI 兼容的 HTTP 服务，第三方的
  都是 Docker。所以网关直接 spawn 官方 Windows 命令行（v2.0.0 shared-MT，不依赖 VC 运行库），
  模型用 SenseVoice Small int8 和 Kokoro 多语言 v1.0，sha256 写死在 `VOICE_ASSETS`。
- 下载、解压、进程管理都在新文件 `server/src/voice-runtime.js`。解压前先 `tar -tjf` 看条目，
  有 `..` 或逃出预期目录就整包拒绝。临时文件 `.part`，校验失败即删。
- 通道用 `local://asr` / `local://tts` 这两个保留地址标记「走本机」，`normalizeBaseUrl` 放行，
  `AudioProxy` 在发请求前拦截。这样不用改设备协议，也不用在本机起一个 HTTP 服务。
- 测试全部注入 fetch / tar / 子进程，不下载 540 MB。真实下载和真实识别还没跑过。

## 同轮再追加：Linux 网关也能装本机语音

用户要求网关部署到 Linux 时同样支持。官方 v2.0.0 有 `linux-x64-shared` 和
`linux-aarch64-shared-cpu` 两份 CPU 包，sha256 从 GitHub releases API 取来写进
`VOICE_RUNTIMES`。树莓派网关是 aarch64，所以 arm64 必须单独一份，不能拿 x64 包顶。

- 选择按 `process.platform` + `process.arch`，只认 win32-x64、linux-x64、linux-arm64。
- Linux 的 `.so` 在包内 `lib/`，`run()` 给子进程加 `LD_LIBRARY_PATH`，不写系统目录。
- 修了一个真实 bug：`upstreamFor` 看到配置通道是 mock 就提前返回，本机端点被演示分支截走，
  设备拿到的是 700 ms 测试音。现在 `local://` 优先判断。

## 没做 / 留给下次

- 真实供应商联调（端点、模型名、音色按供应商实际填；`whisper-1`/`tts-1`/`alloy`
  是 OpenAI 的默认值）。
- 安装版网关未重装；e2e（Playwright）未跑。
- `config.voice.timeoutMs` / `maxTtsBytes` 仍然只在配置文件里调（运维参数，故意不放到
  管理页）。
