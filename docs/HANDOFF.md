# 交接：现在在哪、下次该干嘛

> 活文档。每次会话结束更新这里；过程记录放 `docs/sessions/`。

## 2026-10-23：设备语音代理与设备端知识检索（分支 feature/device-voice-proxy，未合入 main；已打网关包、未安装）

- **新增设备专用 `/v1` 端点**（都用 `gatewayToken`，同 `LlmProxy.authenticate` 的吊销/停用检查）：
  `GET /v1/audio/config`、`POST /v1/audio/transcriptions`、`POST /v1/audio/speech`、
  `GET /v1/knowledge/search`。知识检索直接调用 `knowledge.search(user, …)`，所以个人记忆不会跨用户暴露；固件目前用 `limit=2`。
- **明确契约（不是通用 OpenAI Audio 透传）**：ASR 收 `audio/pcm` 裸 `pcm_s16le`（8–48 kHz、仅单声道；chunked 可用；固件 16 kHz mono、≤6 s/192000 B），网关补 WAV 头后受控 multipart 上送；不支持未验证 multipart 透传。TTS 只收 `{input,format:"pcm"}`，固定用服务端 model/voice，向上游要 WAV 后只接受 16-bit/mono/8–48 kHz，剥成 `audio/pcm` 并回 `x-audio-rate` / `x-audio-channels: 1` / `x-audio-bits: 16`。
- **mock/生产状态**：开发默认 `voice.provider:"mock"`；`/config` 返回明确布尔 `available` 和 `mock`，mock TTS 另有 `x-audio-mock: 1`。没有有密钥的真实通道即 `available:false`、请求为 `503 voice_not_configured`，不把 mock 静默当真语音。配置及完整协议见 `docs/device-voice-api.md`。
- **安全与资源**：禁止上游重定向（避免 Authorization 泄漏）；30 s 可配超时、设备断开取消、ASR 错误文本 64 KiB / TTS 默认 20 MiB 响应上限。拒绝上游非 WAV、MP3/Opus、立体声、非 16-bit 或不支持采样率，绝不拿任意字节冒充 PCM。记账有 `voice:{kind,audioSeconds}` 和 `voice-asr|voice-tts` tag；可配每分钟语音价目，未配时 `costCny=0, priceKnown=false`，不改原有账本语义。
- **TTL 已核实**：登录路径给 session 与 gateway token 均传 `loginTtlDays ?? 30`，所以这里都是 **30 天**；登出/吊销/停用即时失效。此前 session 草稿误称 gateway token 90 天，已纠正（90 只是 DB 方法的旧默认值，当前 API 不用它）。
- **最终加固**：RIFF 声明长度必须等于完整响应，逐块检查长度/填充、唯一 fmt/data、非空且样本对齐的 PCM、blockAlign/byteRate 一致性；上游发头后卡在响应体的超时也统一为 `504 timeout`。真实语音通道仅接受 `openai-compatible` kind 且已解析密钥。
- **验证**：`node --test server/test/audio.test.js` **18 pass / 0 fail**（临时目录 + 本机真实 HTTP stub；覆盖打包/格式、畸形 RIFF、响应体超时/取消/超限/错误、禁用/吊销、账本与知识隔离）；PowerShell `npm --prefix E:/orcaWorkspace/company-harness test` **620 tests：619 pass / 0 fail / 1 skip**（唯一 skip 是未设 `DESK_NATIVE_TEST_KERNEL` 的真实内核跨进程锁用例）。未用真实密钥/付费上游；`fnos-probe.mjs` 未触碰（仍是本地临时文件、不入库）。过程：`docs/sessions/2026-10-23-device-voice-proxy.md`。
- **已提交推送并打网关包（未安装）**：提交 `ba41746` 已推 origin 与 gitea 的 `feature/device-voice-proxy`（未合入 main，release 工作流只对 main 触发，本次不触发）；gitea `main` 一并补推到 `ba67ed2`（原停在 09-24 的 `ba50fc0`）。`npm run dist:gateway` 打出 **`dist/valimart-harness-Gateway-Setup-0.1.0.exe`**（27.1 MiB / 28,384,700 字节，SHA-256 `b85ed743113a5adb71b00a53f3ccda610882dc6ae0908491a438fee4d46b4db5`，随包 node 为构建机 v26.7.0）。暂存版按服务环境（`NODE_ENV=production`、`DESK_GATEWAY_PACKAGED=1`、临时数据目录、端口 18797）冒烟：`/health` 正常，`/v1/audio/*` 与 `/v1/knowledge/search` 无令牌 401。安装版 config 去掉了 mock 上游而 `voice.provider` 仍是 `mock`，所以装上后 `/v1/audio/config` 为 `available:false`、语音请求 503，要在 `config.local.json` 接 `openai-compatible` 语音上游才可用。原 10-08 旧包备份为 `dist/valimart-harness-Gateway-Setup-0.1.0-prev-20261008.exe`（SHA-256 `681dbbfb34c77dbf70c3c20b3c4d3b17a816a19f48fc2c6f16b927fae257e1aa`）可回滚。**未做**：安装/升级本机网关（要 UAC）、真实语音供应商与设备联调、合入 main。

## 2026-10-23：修 0.2.1 官方账号菜单顶掉公司员工入口（已重发包）

- **回归**：1619 包（内核 0.2.1-rc.2）左下角公司芯片被 dsh 官方账号菜单芯片顶掉（点开是设置/意见反馈/退出 DeepSeek 登录），员工入口消失。根因：0.2.1 官方设置入口重构为 `settings.launcher` 槽（官方注册秩 0）；single 槽 **lowest renders + 同秩拒注册**；内核把显式 priority 覆盖成自动遮蔽秩，desk-ui 的 `-10` 失效。
- **修法（DOM 接管，别再去抢槽）**：styles.css 隐藏 `.dk-account-settings [data-slot='settings.launcher']` 与旧 `button[class*='_trigger']`（保持挂载）；sidebar.jsx `DeskUserChip` 接管显示位，点击转发隐藏官方按钮再点菜单「设置」开面板；`settings.trigger` 注册保留供老内核。**踩坑**：apply 时 inject 未声明的 launcher 槽会拖死整个插件；异步定时器里 register 无 fiber 上下文；factory 里 register 被同秩拒——都试过，都失败，见 `docs/sessions/2026-10-21-kernel-0.2.1-rc.2.md`。
- **验证**：Playwright 探针截图公司芯片恢复、点击开设置面板公司分区齐全；e2e 无断言涉及。
- **已重发**：`dist/valimart-harness-Setup-0.1.0-20261023.0322.exe`（244.1 MiB，buildId `0.1.0+0.2.1-rc.2.20261023-0322.a632f28f`，SHA-256 `63cb31c4109aabea9891d76f6cb80d2ea7350fb5c011b2f95c790192298d890c`）替换 1619（带病版）；网关 current 已切、1619 留 previous 可回滚；提交 `4616a9b` 推送触发 CI release。员工机器下次启动静默升级。

## 2026-10-21：内核升 0.2.1-rc.2（补丁已重审）· TDH 同步 · dsh-purge 拒装

- **内核 `0.2.0-rc.2` → `0.2.1-rc.2`**（npm latest/next，2026-10-17 发布）。只改 `scripts/kernel/pin.json`；`npm run setup` + `npm run kernel:check` ✓ 20 处补丁齐全。junction mklink v3/v4 仍 anchor-gone、company-think 预设仍 missing（均预期）；dsh-browser@0.1.11 / anysearch@0.1.4 插件补丁仍命中，兼容豁免由 setup 自动写 `profiles/desk/compatibility.json`。
- **markdown-slot 补丁重审**（`patches.mjs` 第一条）：0.2.1 上游给 `AssistantMarkdown`/`AssistantNodeView` 原生传 `renderSlot`、assistant-step 注册原生带 children（reasoning.body + message.images）。处置：签名与子槽声明各加 0.2.1 变体；**删除 `assistant-node-render-slot` 编辑**（上游已吸收）；文本块与实例化锚点复用 0.1.5/0.1.7 变体（逐字节一致）。`kernel-patches.test.mjs` 同步改：0.1.7 用例去掉已删编辑断言，新增 0.2.1 锚点用例。
- 验证：全量 `npm test`（PowerShell） **602 tests，601 pass / 0 fail / 1 skip**（skip=preparePackaged 缺 kernel.tar，预期）；e2e boot 锚点（`staticModules:` / `.run(`）在 0.2.1 前端仍命中，`session-images.spec.js` 不用改，但未跑 Playwright 全量。dev 客户端冒烟（安装版占 3470，改 `--port 3471`）：启动零报错，desk-host/image/video 就绪、模型路由已配、公司盘同步 1565 文件、token URL 303 正常；冒烟进程已清理。
- **新 gotcha**：从 Git Bash 跑 `npm test` 时 `spawnSync('tar')` 会解析到 GNU tar，`E:` 被当远程主机（`Cannot connect to E: resolve failed`），gateway-linux 打包用例误报失败——**测试必须在 PowerShell 下跑**（System32 bsdtar）。
- **TDH 上游克隆已同步**：`E:/orcaWorkspace/TDHarness-coding` main 快进 `1523e56 → 82c65fc`（2026.10.19）。上游 `kernel.yml` pin 0.2.1-alpha.1；其补丁器把 markdown-slot 用 `maxKernel: 0.1.6` 门跳过（他们新客户端不用该槽），本仓 desk-ui 仍消费 `conversation.assistant.markdown`，故走变体重写。锚点重审可参考上游 `patches/apply-kernel-patches.js`。
- **dsh-purge 拒绝安装**（决策，别轻易推翻）：GitHub `YuJunZhiXue/dsh-purge` 是「破甲」越狱插件，直接改写内核包的提示词/权限策略/工具限制。与公司锚点补丁层正面冲突；企业多用户 + 上游订阅账号场景下违反平台 ToS、有批量封号风险；原仓库删库中、镜像 fork 遍地且未审计，供应链风险高。研究/防御目的可隔离审查源码，不入 company-harness。细节 `docs/sessions/2026-10-21-kernel-0.2.1-rc.2.md`。
- **已提交推送并打包发布（10-22 凌晨）**：提交 `058af7a` 已推 origin/main，触发 release 工作流。本地 `npm run dist:client` 打出 **`dist/valimart-harness-Setup-0.1.0-20261021.1619.exe`**（244.1 MiB / 255,991,489 字节，buildId `0.1.0+0.2.1-rc.2.20261021-1619.02c12f4f`，SHA-256 `91cd8ce4cc68e7e42c49808f0ac5da46b955831791836c499e8b0d031a6acf38`），用本机 ethan 桌面会话令牌发布到安装版网关：**当前版本已切到这一版**，`0.1.0+0.2.0-rc.2.20261012-0325.37e0a9ad` 留作 previous 可回滚。员工机器下次启动静默覆盖安装。payload.json 确认随包内核 0.2.1-rc.2。
- **未做**：Playwright e2e 全量未跑（需要时 `npm run test:e2e`，内核桌面页要 `DESK_SMOKE_URL`）；未做隔离目录 payload 真实启动核验（dev 冒烟用的是同一前缀同一补丁内核，风险已覆盖大半）；profile 插件未升（dsh-browser 0.2.1 / anysearch 0.1.8 已发布，升级要连带重审 settings 补丁变体）；安装版网关 server 代码未重发（本轮未改 `server/**`，无需 `dist:gateway`）。

## 2026-10-12：GitHub Pages 直链下载与项目 Star

- `docs/intro/index.html` 的下载入口在页面加载时请求 GitHub `latest` Release API，客户端、网关与 VS Code 插件按附件名称解析为直接下载 URL；VS Code / 网关多个版本时按语义版本取最新。API 请求失败或附件缺失时回退到 Releases 页面。
- 首页导航增加 GitHub 仓库按钮和 Shields 动态 Star 徽章。GitHub Pages 仍由 `.github/workflows/pages.yml` 在 `docs/intro/**` 推送到 `main` 后发布。
- 当前在线 `latest` Release 返回客户端 `valimart-harness-Setup-0.1.0-20261012.0207.exe`、网关 `valimart-harness-Gateway-Setup-0.1.0.exe`、VS Code 插件 `valimart-harness-0.3.1.vsix`；客户端链接按 API 响应更新，不固定版本号。过程记录：`docs/sessions/2026-10-12-pages-download-links.md`。
- 验证：页面 2 段内联脚本语法通过；用 latest 资产样例检查 7 个下载入口直达匹配附件，网络失败回退到 Releases；`git diff --check` 通过。推送后由 Pages Actions 发布。

## 2026-10-12：订阅账号用量状态与官方入口

- 管理页「模型设置 → 模型通道」为每个订阅账号显示网关最近观察到的状态：有成功响应时标记「最近请求成功 · 可用」，上游额度错误时标记「已触发限额」，并展示网关优先冷却截止时间；冷却期过后提示等待下一次请求验证。
- 账号状态附最近检查时间和平台官方入口（Grok、ChatGPT、Claude、Gemini、Antigravity）。页面区分网关调用观察与官方额度查询；冷却表示账号优先级恢复时间，没其他可用账号时网关仍可能提前回退重试。
- 账号状态时间写入通道 `channels.json` 集合（默认 SQLite），成功状态最多每 5 分钟持久化一次，避免每次请求都写数据库。服务端配置接入但没有独立账号列表的订阅通道会提示暂无单账号状态。
- 用户明确“手动刷新”应主动查询官方实时余额，并允许复用官方客户端内部接口。管理员可按账号或整通道刷新；服务端先续期 OAuth，再直接请求平台接口，结果带本次查询时间、剩余比例/金额和平台返回的恢复时间。令牌与原始响应仅留在网关。
- 实时适配：ChatGPT `/backend-api/wham/usage`、Claude `/api/oauth/usage`、Grok Build `/v1/billing?format=credits`、Gemini Code Assist `retrieveUserQuota`、Antigravity `retrieveUserQuotaSummary`。这些产品内部接口可能变更或拒绝某些客户端；错误按账号显示，不缓存旧余额冒充实时结果。服务端配置接入且没有独立 OAuth 账号列表的通道不可单独刷新。
- 修改 `server/src/subscription-usage.js`、`server/src/api.js`、`server/src/index.js`、`server/src/oauth-subscribe.js`、`server/src/channels.js`、`server/src/llm-proxy.js`、`server/src/admin-page.js`，并补充适配器与网关路由测试。全量 `npm test` **600 pass / 0 fail / 1 skip**。未对真实订阅账号发请求，未打网关安装包。过程记录：`docs/sessions/2026-10-12-subscription-account-usage.md`。

## 2026-10-12：提交业务改动，GitHub 客户端只留最新版

- 提交当前生视频插件、媒体历史与会话 tab、工作区排序、网关媒体协议 / 出站代理、管理页布局等积累改动，推送 GitHub `origin/main`，触发既有 release 工作流。
- `.github/workflows/release.yml`：新客户端上传成功后，仅保留本次客户端 exe；`replacesArtifacts` 只替换同名附件，不能清掉带旧时间戳的客户端。新增 `artifactErrorsFailBuild`，清理前确认唯一客户端已完整上传；失败时保留旧包。
- 同步删除更早运行的 `windows-installers` Actions artifact，本次产物保留 3 天。网关与 VS Code 附件不在客户端清理范围内。
- 已在线清理 `latest` Release 的 17 个旧客户端，现保留 `valimart-harness-Setup-0.1.0-20261003.1500.exe`；旧 Windows artifact 也已清理到只剩最新一份，新构建成功后自动替换。
- 验证：全量测试复跑 **590 pass / 0 fail / 1 skip**；首次全量有一项 Mixed 换账号时序断言失败，单文件复跑 30/30，全量复跑恢复通过。新增发布清理保护测试 **3/3**；`npm run build` 与 `git diff --check` 通过。
- 临时 `fnos-probe.mjs` 留在本地，未提交。过程见 `docs/sessions/2026-10-12-submit-release-retention.md`。

## 2026-10-08：desk-video 生视频插件

- 插件 `plugins/desk-video`（`@company-desk/desk-video`），照 desk-image：工具 `video_generate` 只走公司网关 `/v1/videos/generations`，密钥不落本机。
- 短名 wan / qwen / minimax / grok / gpt / seedance 对到公司目录里的真实 id；设置 → 生视频可从目录下拉选择，也可填额外模型 id。输入框「生视频」芯片：提示词 + 最多 4 张参考图 + 时长。
- 长视频：时长超过模型单段上限（万相/海螺/可灵 10s、Sora/Seedance 12s、Veo 8s，总上限 120s）时分段生成，本机 ffmpeg concat 拼接。参考图只喂第一段。`longForm: false` 关掉。
- 网关 `server/src/upstream-video.js`：万相（dashscope 异步 video-synthesis）、MiniMax 海螺（video_generation + 取文件）、火山 Seedance（contents/generations/tasks）翻成统一 `{ data: [{ url }] }`。Grok / Sora 仍走 OpenAI 兼容透传。
- 挂载：`profile/cordis.patch.yml`、`COMPANY_PLUGINS`、`build-payload`、closure。验证：desk-video + upstream-video + 旧视频代理 **20 pass**；bootstrap + desk-image 一起 **44 pass / 1 已修**。
- **已打客户端包并发布**：`dist/valimart-harness-Setup-0.1.0-20261008.0226.exe`（221.8 MiB，buildId `0.1.0+0.2.0-rc.2.20261008-0226.02cd5a0a`，SHA-256 `57f15f19be149b9216bd509766fcaa5ef87bb642b24e5e845cfe90e9a21b556e`）。网关当前客户端已切到这一版，上一版 `…20261003-1455.a084a6ac` 留作 previous。
- **再次发布（含生图 / 视频 tab）**：`dist/valimart-harness-Setup-0.1.0-20261008.0237.exe`（221.8 MiB，buildId `0.1.0+0.2.0-rc.2.20261008-0237.074d9b4d`，SHA-256 `8d65afee117a47f5be0125b4cf6dd1fc8a6e15b07c03fdf437ae9fe8421bb526`）。当前版本已切到这一版，0226 留作 previous。
- **再次发布（生图表单布局）**：`dist/valimart-harness-Setup-0.1.0-20261008.0244.exe`（221.8 MiB，buildId `0.1.0+0.2.0-rc.2.20261008-0244.b2210f38`，SHA-256 `880d97078d39601385aa2262f609002cb697773e0b250c9b377ec5e5f567b60b`）。当前版本切到这一版，0237 留作 previous。
- **再次发布（视频参考图点选 / 上传）**：`dist/valimart-harness-Setup-0.1.0-20261008.0308.exe`（221.8 MiB，buildId `0.1.0+0.2.0-rc.2.20261008-0308.46ab9a4e`，SHA-256 `8e5a39be286e382ea94ac555a7a958f26636d74ffcb25e6932d857cfebe5b904`）。当前版本切到这一版，0244 留作 previous。
- **再次发布（表单控件不再溢出）**：`dist/valimart-harness-Setup-0.1.0-20261008.0327.exe`（221.8 MiB，buildId `0.1.0+0.2.0-rc.2.20261008-0327.9ebb32a4`，SHA-256 `699f926b63fa4dc410efbcbc790e25c22d3f412a931f20bb771a71127b3c469c`）。当前版本切到这一版，0308 留作 previous。
- **再次发布（内容与 0327 相同，只换时间戳）**：`dist/valimart-harness-Setup-0.1.0-20261008.0345.exe`（221.8 MiB，buildId `0.1.0+0.2.0-rc.2.20261008-0345.9ebb32a4`，SHA-256 `3e8b3475192c477b988e231e8e4c4d570f5a331d3f1fe46a14d6464f62d43f56`）。当前版本切到这一版，0327 留作 previous。生视频 422 的修复在 `server/src/llm-proxy.js`。
- **网关已重打包并升级安装**：`dist/valimart-harness-Gateway-Setup-0.1.0.exe`（27.1 MiB），`/S` 静默升级退出码 0。`TheDivaGateway` 运行中，8790 返回 401（要登录）。安装目录 `llm-proxy.js` 含 `asDataUri` / `settleVideo`（6 处），`config.local.json` 保留，`ethan` 桌面会话仍有效。员工机器下次启动静默覆盖安装。安装版网关仍是旧代码（万相 / MiniMax / Seedance 的协议翻译还没进服务），要这些通道生效需再 `dist:gateway`。`boss/boss123456` 在安装版上已改过，发布用的是本机 `ethan` 桌面会话。
- **同日后续客户端包**（交接补记，源码仍未提交）：`0418` / `0516` / `0551` / `0639` / `0804` 依次发布。网关记录的最后一版是 `0.1.0+0.2.0-rc.2.20261008-0804.2e33a469`（sha256 `e64837b7…decbf2`，232609992 字节，上一版 `0639` 同摘要 `2e33a469`）。
- **2026-10-09 再发布**：`dist/valimart-harness-Setup-0.1.0-20261009.0223.exe`（221.8 MiB，buildId `0.1.0+0.2.0-rc.2.20261009-0223.83eba77e`，SHA-256 `5454ab3d9a0a73ffed9e8aadf9484b53dcd37c9a733c13feff84be9034e1ee9c`）。这一包比 `0804` 多出的是 `desk-host`：会话视频 `GET /sessions/:id/video`、插件清单登记 `desk-video`、工作区排序改从后往前插。倒序插入没有生效：内核 `insertBefore` 同步返回、内部排队，连续两次都按调用瞬间的旧顺序算，后一次覆盖前一次；而且内核 `create()` 把新建工作区插到最前，排序只在登录同步时跑一次。
- **2026-10-09 工作区置顶**：`plugins/desk-host/lib/workspace-order.js` 的 `pinWorkspaceOrder` 等前一次落盘再排下一个，固定「个人、团队、其余」。侧栏 `/workspace-git` 轮询（8 秒）发现前两位不对就再钉一次。`scripts/test/workspace-order.test.mjs` 3 pass。本机安装目录先手工换上并重启验证：顺序为个人、团队、valicreaty…
- **当前发布**：`dist/valimart-harness-Setup-0.1.0-20261009.0233.exe`（221.8 MiB，buildId `0.1.0+0.2.0-rc.2.20261009-0233.e6179889`，SHA-256 `58e40b116428e0e61c1e118d4a6f01bed0ae92e2a4015e305e4b50c81b9c508f`）。网关当前版本切到这一版，`0223` 留作 previous。解包后的 payload 含 `workspace-order.js` 与 `pinWorkspaceOrder`。

## 2026-09-30：会话里的 `/uploads/...jpg` 被当成图片加载

- 现象：湛江磁盘会话末尾「图片加载失败 xxx.jpg」，重试也没有图。回复原文是举例 `` `/uploads/202609/xxx.jpg` ``，文件不在工作区。
- 根因：`imageMarkdownParts` 把行内代码里的图片路径一律预览。以 `/` 开头的是服务器路径，不是本机会话目录里的文件，请求 `/desk/api/sessions/:id/image` 必然 404，失败态把路径盖成「图片加载失败」。
- 修法：行内代码以 `/` 开头不再预览。本机相对路径、`图片文件：`、Windows 路径仍预览。`scripts/test/session-image.test.mjs` 4 pass；`npm run build` 已重打 bundle。
- **已打客户端包并发布**：`dist/valimart-harness-Setup-0.1.0-20261003.1455.exe`（221.8 MiB，buildId `0.1.0+0.2.0-rc.2.20261003-1455.a084a6ac`，SHA-256 `229691098869db598899368483c65fb7983f347d2762190368795702ad9f1548`）。网关当前客户端已切到这一版，上一版 `…20260930-0700.4ad363e9` 留作 previous。员工机器下次启动静默覆盖安装。

## 2026-09-30：Mixed 审核不通过回规划再实施再审

- 现象：审核 `changes_requested` 在任务级返修（默认 2 轮）用完后直接 `blocked`，改进方案停在错误横幅，不会交给规划模型。
- 修法：`#reviewLoop` 返修耗尽后调 `#replanFromReview`：审核摘要 / 未过验收 / findings 写进 `planPrompt` 的 `replan.review`；规划模型出新 planVersion；点名任务（即使已 executed）回 pending，小模型再实施，再审核。新计划重置返修预算。次数受既有 `maxReplans`（默认 1）限制，用尽仍 `blocked`，不无限循环。审核 `blocked`、审核输出两次非法仍直接停。
- 状态机：`reviewing` 允许回到 `planning`。`applyReplan` 的 stale 集包含 `failedTaskIds` 本身。
- 停在 blocked 之后：面板「按改进继续」仍走 resume continue（同一 run，不另开重跑）。`#resumeEntry` 见到最近一轮 `changes_requested` 就带上改进方案，规划预算归零后再规划、再实施、再审。每次继续给一轮。审核结论是 `blocked`（无法继续）的恢复仍拒绝。
- 验证：review + recovery + panel **52 pass / 0 fail**；`npm run build` 已重打 desk-ui bundle。未打安装包；`plugins/desk-host/lib/**` 要重启客户端进程才生效。
- 过程：`docs/sessions/2026-09-30-mixed-review-replan.md`。

## 2026-09-30：pi CLI 默认模型改成跟公司设置一致

- 现象：网关默认模型是 `grok-4.7-build-fast`（桌面端也显示 Grok），但 pi 打开用的是 `valimart/deepseek-flash`。
- 根因：pi 没设 `settings.defaultModel`（也没 `--model` / `enabledModels`）时，启动模型＝**可用模型里的第一个**（`pi-coding-agent/dist/core/model-resolver.js` 的 `availableModels[0]`；scoped 路径同义），而 pi 包把网关目录按通道顺序注册 → DeepSeek 通道在最前。`company.defaultModel` 从来没被 pi 侧使用（只被 `/desk-status` 打印），`/desk-login` 还会主动切到 `catalogModels()[0]`。VS Code 插件没这个问题（一直读 `company.defaultModel`）。
- 修法：`packages/pi-valimart-desk` 新增 `gatewayDefaultModelId` / `orderByDefault` / `preferredModel`（`lib/models.mjs`）；注册目录时把公司默认模型**提到第一位**，`/desk-login` 结束后切到它（默认不在目录里就退回第一个）。不写用户的 `settings.json`——pi 扩展 API 只有 `getSettings()` 读、没写，靠目录顺序这条 pi 自己的语义就够。
- 验证：单测 24 pass（+2）；`pi --print "ok" --mode json` 的会话里起始模型 `deepseek-flash` → `grok-4.7-build-fast`（先用 `-e <仓库扩展>` 验，发布后再用真实安装验）。
- 已发布 npm **0.1.11**（`pi-valimart-desk`），本机 `pi install npm:pi-valimart-desk` 已升级；同事机器同样跑一次即可。细节 `docs/sessions/2026-09-30-pi-default-model.md`。

## 2026-09-30：标题栏改参考上游桌面端（caption 40px）+ 内核升 0.2.0-rc.2

- 参考源：`deepseek-ai/deepseek-harness` GitHub `master`（`git clone --depth 1 --filter=blob:none --sparse` 到本机 `E:\orcaWorkspace\dsh-ref`，只取 `apps/desktop` + 相关 `packages/client/*`）。桌面壳契约：`WINDOWS_TITLEBAR_HEIGHT = 40`、`html[data-windows-titlebar]`、`preload-menu.ts`（shadow DOM 菜单条，左 48px，28px 高按钮，点击 → 主进程 `Menu.popup`）、`AppFrame.module.css`（frame 下移 40px + 底色＝侧栏色、`::before` 整条拖区、主列 `border-radius: 16px 0 0 0`、侧栏无边框）。
- **内核：`0.2.0-rc.1` → `0.2.0-rc.2`**（npm `latest`/`next` ＝ GitHub 最新 release `dsh-v0.2.0-rc.2`）。`scripts/kernel/pin.json` 只改版本；`npm run kernel` 重装后 **20 处补丁新打、4 处已有、2 处 optional 跳过**（junction mklink 锚点消失，预期）；`npm run kernel:check` 齐全。开发 client（profile `desk`）在 0.2.0-rc.2 上启动正常，公司盘 / 模型路由 / 生图插件零报错。
- 桌面壳自绘 caption（`plugins/desk-ui/src/client/titlebar.jsx`）：40px 一条、与侧栏同色、左侧「折叠侧栏（28px 方钮，`layoutActions.toggleSidebar`）+ 应用 / 编辑」，右侧窗控；菜单调 `deskShell.openMenu(name, x, y)` → `desktop/main.js` 的 `desk:menu-popup` 用 `Menu.popup` 弹原生菜单（应用＝关于/重新加载 F5/开发者工具 F12/退出；编辑＝撤销…全选走 role）。**仍不用 `titleBarOverlay`**（frameless 自绘窗控，避免原生色带 + 主题同步 IPC）。
- `styles.css`：`--dk-titlebar-h` 36 → **40px**；`.dk-frame { padding-top: 40px; background: var(--dk-bg-1) }`；`.dk-col-main { background: base; border-radius: 16px 0 0 0 }`；Electron 下侧栏去右边框；**删掉整套「会话顶栏挤进 caption」的避让几何**（`:first-child` 行高、`--dk-caption-right`、tablist margin-top、指针开洞）——会话顶栏回到官方默认几何，窗控不再和它抢同一行；右侧栏面板 `top: 0 → var(--dk-titlebar-h)`（绝对定位包含块是 frame 的 padding box）；品牌行 `56px/上内边距` → `height: 40px; margin-top: 6px`（字标中线 66，与参考截图一致）；`e2e/desktop-chrome.spec.js` + `e2e/sidebar-toggle-align.spec.js` 按新几何重写（断言 band 与侧栏同色、`main.left = 280`、圆角 16px、面板 top 40、菜单/折叠/窗控点击命中）。
- `desktop/preload.js`：兜底条 36 → 40px，图标改 `textContent`（消 innerHTML 告警），新增 `openMenu`。
- **其他坑**：`.dk-desk-maximized .dk-frame { padding: var(--dk-win-inset) }` 是短写，会把 `padding-top` 清零——已改成只重写 `padding-top`。
- 顺带：`e2e/session-images.spec.js` 的 web boot 锚点随内核升级换掉（0.2.0-rc.2 是 `globalThis.__ModuleLoader__.create(...)` + `n.run(handler)`，静态模块表 `staticModules: <fn>()`；用正则取函数名再替换 run 调用）；`e2e/admin.{setup,smoke}.spec.js` 还在断言上一轮已从管理页删掉的 `#kernel h2`，改断言 `#client h2`。
- **第二轮（同日，按用户圈注补齐）**：
  - 主列左上圆角被会议根节点盖成直角（`.wSkVaW_root` 自带不透明白底，范围 0 圆角）——学上游 `.centerCol` 给 `.dk-col-main` 加 `overflow: hidden`，像素采样确认圆角处透出 band 色 `#f7f7f8`；同时确认输入行下拉（完全权限菜单）没被裁。
  - 会话顶栏 `conversation.session.header.utilities` 槽不再隐藏（上一轮为了把基础文件夹挪到侧栏菜单而藏掉）——恢复后右上角就是上游同款的「文件夹 + ⌄」胶囊 + ⋯ + 右侧栏开关（实测可点击）。
  - 「应用」菜单照截图改成 **关于 valimart harness / 检查更新… / ─ / 退出**（不再放重新加载 / 开发者工具，F5 / F12 键盘快捷键仍在）。`desktop/main.js` 把启动前的更新检查抽成 `checkClientUpdate({apply})`，菜单项复用并向 `dialog` 报结果（已是最新 / 已下载下次启动装 / 已下载并立即重启安装 / 未登录 / 失败原因）；随包删除已失效的“跳过打开前更新检查”分支。
- 验证（第二轮）：`npm test` **558 pass / 0 fail / 1 skip**；全量 e2e **17 passed / 7 skipped / 0 failed**（新增主列 `overflow: hidden` 与 utilities 不隐藏的回归断言）；真机探针：`build/round2-session.png`（圆角 + 文件夹胶囊）、`build/round2-dropdown.png`（下拉未被裁）、`build/menu-real-shell.png`（真实 `desktop/main.js` attach 模式下点「应用」原生菜单弹出、aria-expanded=true）。
- 验证：`npm test` **557 pass / 0 fail / 1 skip**；全量 `npx playwright test` **17 passed / 7 skipped / 0 failed**；真机（仓库自带 Electron 载入 dev 客户端页，1280×820）截图 `build/caption-new.png` / `build/caption-session.png` / `build/caption-rail.png`：caption 40px、菜单 x=48 起、窗控 138px（3×46）在 x=1142、侧栏 280 与 band 同色 `rgb(247,247,248)`、主列 `left 280 / radius 16px`、品牌行 46..86、caption 折叠钮切 280↔56（rail 内不再重复折叠钮）、会话顶栏右侧按钮 y=51 可点。
- **已打客户端包并发布到网关（两轮）**：第一轮 `dist/valimart-harness-Setup-0.1.0-20260930.0643.exe`（buildId `...-0643.5e6f0872`，sha256 `8bc81de3…`）；**当前发布的是第二轮** `dist/valimart-harness-Setup-0.1.0-20260930.0700.exe`（221.8 MiB，buildId `0.1.0+0.2.0-rc.2.20260930-0700.4ad363e9`，SHA-256 `a351756e71b6e2e398d2d5f46c29e34d25e67ed4a66964def6ea2dc13e1beb26`，旁有 `.sha256`）。payload 内核 0.2.0-rc.2 / 20 处补丁齐全；旧包留 previous 可回滚。隔离目录用随包 node + payload 真实启动：HTTP 200、版本可见、登录页可见、pageerror 与 stderr 均空（`build/client-artifact-check-A0KK26/verification.json`）。**员工机器下次启动静默覆盖安装**。
- 未做：未重发网关安装包（本轮未改 `server/**`）；本机安装版前缀 `~/.company-desk/app/kernel` 仍是 0.1.7-rc.1，装上新客户端包后才变。过程记录 `docs/sessions/2026-09-30-titlebar-caption.md`。

## 2026-09-29：移除内核自动更新，内核随客户端整包分发

- 背景：内核大部分不兼容，升级需人工重审补丁；客户端包里本来就带内核。故去掉「网关分发内核 tar + 客户端下次启动切换」这条链，只保留客户端整包更新。
- 服务端：删 `server/src/kernel-catalog.js`；`api.js` 去掉 `/api/kernel/*`、`/api/admin/kernel/*` 与相关导入；`admin-page.js`「更新」页去掉内核分区与按钮（保留客户端分区、`/api/status` 的内核版本展示）。`index.js` 不再注入内核目录。
- 客户端：删 `plugins/desk-host/lib/kernel-update.js`（拉 tar/写 pending）；`readLocalKernelVersion` 拆到新 `plugins/desk-host/lib/kernel-version.js` 只用于界面展示；`index.js` 去掉 `scheduleKernelUpdate`；`desktop/main.js` 打开前检查去掉内核段；`bootstrap.mjs` 去掉 `applyPendingKernel` 与 pending 消费。
- 脚本：删 `scripts/kernel/update.mjs`（discover/prepare/publish）与 `scripts/lib/kernel-update.mjs`；`hashFile` 移入 `scripts/lib/client-update.mjs`，`resolveNpmRegistry` 移入 `scripts/lib/npm-cli.mjs`；`kernel-prepare.mjs` 只留安装/插件函数（删 pack/prepare/assertPublishedOnNpm）；`package.json` 去掉 `kernel:discover|prepare|publish`（`kernel` / `kernel:check` 保留）。`gateway-stage.mjs` / `build-payload.mjs` 的随包清单同步去掉 `kernel-update.mjs`。
- 测试：删 `scripts/test/kernel-update.test.mjs`、`server/test/kernel-catalog.test.js`；新增 `scripts/test/kernel-install.test.mjs` 保留安装参数 / 错误格式 / registry / 卸插件用例；`gateway.test.js` 去掉内核接口用例。
- 验证：`npm test` **557 pass / 0 fail / 1 skip**（skip 仍是缺 `build/payload/kernel.tar` 的 preparePackaged）；`npm --prefix packages/vscode test` 82/82。升级内核的新流程：改 `scripts/kernel/pin.json` → `npm run setup` → `npm run dist:client`。

## 2026-09-29：网关管理页设置布局

- `/admin` 左侧主导航保留，概览增加服务器 / 公司盘双列信息区；模型页分为「模型通道 / 搜索密钥 / 模型目录」，知识页分为「查询与录入 / 知识合集」，组织页分为「人员 / 岗位 / 部门」tab。
- 页面增加分区标题、响应式栅格和更清晰的控件状态；不改接口、权限或数据行为。修改 `server/src/admin-page.js`，不涉及 desk-ui bundle。
- 验证：`node --test server/test/gateway.test.js` 全部通过（16 项），覆盖管理页渲染、内联脚本语法和 tab 标记；`git diff --check` 通过。

## 2026-09-29：单账号上游流式被整段缓冲（会话统计 TPS 被放大）

- 现象：Grok 会话统计「输出速度（TPS）」显示 112174 tok/s（底部同样）。实测投影缓存 `sessionStats.decodeMs=95ms / decodeTokens=11038`，TPS 就是两者之商被放大——不是模型异常，是解码时间塌成 0。
- 根因：`server/src/llm-proxy.js` 的 `fetchUpstream` 单账号分支在成功响应上执行 `await res.clone().text()` 来判定配额耗尽。`Response.clone()` 会 tee 出第二条流，在读原流之前先等克隆读完整段 SSE，会把整段响应缓存在 tee 里；客户端因此只在生成结束时一次性收到全部 chunk。多账号分支在 `res.ok` 时提前 return，所以只有单账号通道（如 Grok 订阅）中招。
- 复现与验证：本地起假上游（每 80ms 一个 SSE chunk），经网关 `/v1/chat/completions?stream=true` 读，单账号时 6+ 个 read 全在同一毫秒、span≈0；多账号时逐个到达。修复后单账号 span≈600ms。新增回归 `server/test/llm-proxy-stream.test.js`（去掉修复即失败）。
- 修复：单账号分支只在 `!res.ok` 时才 clone 窥探配额，与多账号分支一致；成功响应原样返回，保持增量流式。
- 影响与后续：已改源码，`server/test/*.test.js` **172 pass / 0 fail**。**安装版网关仍是旧代码**，需 `npm run dist:gateway` 后重装/升级；已产生的历史会话统计不会回改，只影响之后的新轮次。

## 2026-09-29：修复不同内核并存时的插件加载

- 开发内核为 `0.2.0-rc.1`，本机桌面安装版为 `0.1.7-rc.1`。保留各自版本与现有 browser / AnySearch 适配补丁。
- `bootstrap.mjs` 原先只检查 profile 配置和 bundle 文件是否存在，原地升级后会漏掉旧版或丢失的 `compatibility.json`。现在按当前内核检查精确版本记录，缺失则刷新，并保留已经验证过的历史版本记录。
- 两个 profile 原先共用 `profiles/node_modules`，后启动者会把前者的依赖改指向另一套内核。现在 profile 本地的官方包、第三方插件、zod，以及公司插件所在根目录，都直接绑定各自的内核；共享目录仅作旧版回退。新增回归测试已确认修复前发生串版、修复后各自解析正确。
- `readLocalKernelVersion` 优先读取正在运行的 dsh 入口所属包，修复开发版运行 0.2.0 却显示安装版 0.1.7 的问题。
- 本机 `desk` / `desk-app` 已修复；误以用户主目录为 DSH_HOME 的 3473 测试进程已停止，开发 profile 与技能根恢复为 `~/.dsh`。本机 app 和安装目录 payload 的 bootstrap / kernel-update 已同步；备份位于 `build/dsh-repair-20260929/`。未重发安装包或网关版本。
- 验证：`npm test` **587 pass / 0 fail / 1 skip**。两个真实内核各自使用对应插件闭包启动，Edge headless 页面 HTTP 200，stderr 与 pageerror 均为空，精确版本兼容记录生效。探针 `build/dsh-compat-probe.mjs`。全量测试的 TEMP/TMP 应设在仓库外（本次用 `E:/orcaWorkspace/dsh-test-temp`），否则“非 Git 工作区”测试会误探测到仓库父级 `.git`。
- 后续已本地打包 Windows x64 客户端：`dist/valimart-harness-Setup-0.1.0-20260929.0430.exe`（221.7 MiB），buildId `0.1.0+0.2.0-rc.1.20260929-0430.2ea67908`，含本轮修复。SHA-256：`a70e121830874b9059af2ca79403b13b3865ab790022e9050a1d960d62b2e4cf`（旁有 `.sha256` 文件）。使用 `dist/win-unpacked/resources/payload` 的完整离线资源与随包 Node 在隔离目录解压启动，HTTP 200、登录页及 0.2.0 版本显示正常、stderr/pageerror 为空，结果 `build/client-artifact-check-Rst7Rl/verification.json`。未发布到网关。

## 现在在哪（pi CLI 包 pi-valimart-desk）

- 桌面客户端才有的公司网关登录 / 模型路由 / 知识检索 / 任务卡，收成可安装的 pi 包：`packages/pi-valimart-desk`（`pi install <仓库>/packages/pi-valimart-desk`）。
- 扩展注册 provider `valimart`（`/v1/chat/completions` + 网关令牌）、命令 `/desk-login` `/desk-logout` `/desk-status` `/desk-discover`、工具 `company_whoami` `company_knowledge` `company_tasks`、技能 `company-briefing`。
- `/desk-login` 不带地址时先走局域网发现（`lib/discover.mjs`）列出可选，列表末尾「手动输入其他地址…」；发现不到才手填。`/login valimart` 把发现到的地址填成默认值。
- 模型目录思考档位：网关常给数组 `['low','high']`，pi 要 `thinkingLevelMap`（缺档填 null 才从 TUI 藏掉）。`toPiModels` 已按 desk-host 的 `normalizeEfforts` 转，并带上网关统一的 deepseek `thinkingFormat` / `max_tokens`。
- TUI 用惠利玛花标替换 pi logo，窗口标题 **valimart pi desk**。
- 状态文件 `~/.pi/agent/valimart-desk.json`；上游密钥仍只在网关。不上 Electron 壳、Mixed、公司盘镜像。
- 公司盘：登录后镜像到 `~/.pi/agent/valimart-drive/`（pull/push 个人记忆、`/desk-sync`）；工具 `company_memory_*`、`company_task_read/log/update/attach`，`/desk-task` 绑定当前卡。
- 单测：`packages/pi-valimart-desk/test/pi-desk.test.mjs`（已并进根 `npm test`）。

## 现在在哪（内核 0.1.7-rc.1，2026-09-24 已发布）

- pin `0.1.5-rc.2` → **`@deepseek-ai/dsh@0.1.7-rc.1`**（npm `next` / GitHub 最新 release；`latest` 仍是 0.1.5-rc.3）。删掉 `installBefore`（0.1.7 依赖是精确版本）。
- 补丁重审：assistant markdown 槽三处按 0.1.7 过程组签名（`groupPart` / `useDisclosure` / `inject`）加变体；预设改打 `dsh-web-app/presets/{standard,ptc,cordis}.patch.yml`（技能根 / web-fetch / instr-root 三文件全中）；junction mklink 两条改 optional，锚点消失跳过并留 mark（上游不再建 junction）；预设技能根对已有官方 `customSkillDirs` 的（cordis）只追加。
- 0.1.7 内核按 peer 范围跳过不兼容 bundle：`bootstrap.mjs` 加 `pluginVersionExemptions`，写 profile 本地 `compatibility.json`（不改插件清单）。**`preparePackaged` 每次启动无条件刷一遍**——只挂在 ensureProfile 里会丢：内核更新后老客户端先消费 pending（旧 bootstrap 写不了豁免），新客户端下次启动 `update.applied=false` 且 profile 无需重建，ensureProfile 被跳过，豁免永远落不了盘。
- anysearch 0.1.4 的 peer 范围停在 0.1.1（`dsh-credentials/system-prompt/tool-web/tools/web` 五个），必须豁免；它在 0.1.7 上用的 ctx 仍在，`build/anysearch-smoke.mjs` 真实闭包验证通过。
- 裸 tar **526MiB**（0.1.7 起 dsh 自带 `libreoffice-kit-win32-x64` 325MB，office-to-pdf / skill-office 用），超网关 `readBody` 512MiB 上传限额 → 网关分发件改 **gzip 169MiB**（`build/kernel-update/0.1.7-rc.1-pub/`；客户端 `tar -xf` 自动识别压缩，sha 对应压缩后文件）。要改限额动 `server/src/api.js` 的 kernel publish `readBody`。
- 验证：`npm test` **585 pass / 0 fail / 1 skip**；开发前缀 19 处补丁齐全、`--profile desk` 3471 启动 200 零报错；安装版前缀走 `fetchKernelUpdate` + `applyPendingKernel` 全链路（旧版留 `kernel-prev`），`desk-app` 3472 启动 200 零告警；新客户端首启模拟（`preparePackaged` 对新 payload 跑真实 appDir）把豁免写进真实 desk-app profile 后再启，零告警。
- 已发布：内核 0.1.7-rc.1（gz）与客户端 `0.1.0+0.1.7-rc.1.20260924-0651.c07ffca8`（`dist/valimart-harness-Setup-0.1.0-20260924.0651.exe`，248.8MB）都上了网关，员工机器下次启动自动静默更新；旧版 kernel/client 都留了 previous 可回滚。发布用的是一次性脚本（`build/publish-kernel-once.mjs` / `publish-client-once.mjs`，复用 desk 会话 sessionToken；CLI 只收 user/password）。
- 顺手修了既有坏断言：管理页 label 加了「、识图」但 `oauth-subscribe.test.js` 的正则没跟上。
- **桌面端启动报错（用户报障，已修，提交 `11fba77`）**：升 0.1.7 后打开页面就是「web boot: 1 entry did not activate / @anweat/dsh-browser: pending (waiting for service: settings$Scope)」，内核进程 exit 1。根因：0.1.7 删除了 `settingsScope` 扁平客户端服务（设置页改用 `configForms.get(ns)` + `whileServed`，插件卡改挂 `plugins.item` 槽），而 dsh-browser 截至 0.1.15-alpha.2（9/21）仍按 0.1.5 API 注入 `settingsScope` + 注册 `settings.plugin.item`；0.1.7 的客户端 web boot 对任一未激活 entry 直接 throw。修法：`patches.mjs` 新增 optional 补丁 `company-desk-dsh-browser-017-settings-v1`（照官方 `dsh-client-ui-settings-web-search` 的 0.1.7 写法改 `@anweat/dsh-browser/lib/client.js`），上游发布适配版后锚点消失自动跳过；同时 `applyKernelPatches` 对 optional 补丁目标缺失改为跳过留痕（原会提前抛 target-missing 盖住「更新包缺插件」校验）。本机 dev/app 前缀已直接打好，`kernel:check` 20 处齐全、`npm test` 585 过、两前缀启动正常；同事机器随下一个客户端包首启 `pinSkillsRoot` 自动补打，不用重发内核。
- 未跟踪文件 `docs/intro/extract-logo-points.mjs`、`out/`（介绍页截图）不属于本轮，未提交。
- **右侧边栏按钮被窗控遮挡（用户报障，已修，提交 `febb187`）**：0.1.7 会话顶栏骨架重排——`header` 改挂 `conversation.header` 槽下、`conversation.session.header` 槽退到 header 内部（display:contents）、标题行前插了个空 `headerLeading` 列——0.1.5 的几何选择器（`> header` / `:first-child`）整体失配，「打开右侧边栏」按钮顶回标题行右缘压在窗控三件套下。`styles.css` 按「含 corner 按钮的那一行」（`:has(> [data-conversation-header-corner])`）重写 36px 行高 + 避让边距，旧 0.1.5 链保留（内核回滚仍生效）；右栏展开时的 strip chrome（全屏/收起/0.1.7 新增分栏）沿用既有 `*:has(> [data-sidebar-right-toggle])` 规则。三态实测（1245px 宽）全在窗控（1107 起）左侧。验证方法：headless Edge 不可用时用仓库自带 electron 加载真实页面 URL（token 从 desktop.log 取）`executeJavaScript` 量几何；改 CSS 后需重启安装版客户端（内核启动时把插件 JS 读进内存）。

## 现在在哪（卸 better-sidebar + 内核 0.1.5-rc.2 + 标题栏空隙）

- 已从 `scripts/kernel/pin.json` 卸掉 `dsh-better-sidebar@0.18.0`，改走官方右侧边栏开关。`@anweat/dsh-browser` / `@anysearch/anysearch-dsh` 仍随内核前缀分发。
- 内核 pin 升到 npm `latest`/`next` 的 **`@deepseek-ai/dsh@0.1.5-rc.2`**（未跟 0.1.6-alpha：会话多实例 / slot 变更）。本机开发前缀 `~/.company-desk/kernel` 与安装版前缀 `~/.company-desk/app/kernel` 均已 `--force` 重装，17 处公司补丁干净命中；`desk` / `desk-app` profile bundle 已去掉 better-sidebar。
- 标题栏改为独立 48px 空隙，窗控 32px 置顶；会话顶栏不再挤进标题栏，官方「打开/关闭右侧边栏」恢复显示且不与三件套叠层。`e2e/sidebar-toggle-align.spec.js` + `e2e/desktop-chrome.spec.js` 已按新几何改过。
- 下次启动客户端即可看到官方侧栏按钮。未打新的 `dist:client` 安装包。

## 现在在哪（2026-09-10 Mixed 模式）

- [详细计划](superpowers/plans/2026-09-09-mixed-mode-implementation.md)：T01–T10 已在计划中勾完；**T09 于本轮补完 waiting_input 问答**（规划缺关键需求 → 面板按 questionId 回答 → 重规划，25/25 recovery）。
- 客户端：设置「混合模式」三模型；会话芯片启用 Mixed（与官方 Plan 互斥）；运行面板看阶段/任务/证据/停止/恢复/重跑/用量。
- 用法：登录公司网关 → 设置保存规划/执行/审核模型（**从公司目录选，不再按启发式灰掉**）→ 会话打开 Mixed → 普通输入框发送。运行中改设置只影响下一次。停止先落盘再收敛。中断后用「继续/重试」，不要当文件重置。
- T11：新包 `dist/valimart-harness-Setup-0.1.0-20260910.0258.exe`（buildId `0.1.0+0.1.3-alpha.2.20260910-0258.60f45186`，含 zod 链）。`/D` 沙箱 0225→0258 未改正式 Programs；保存 mock-echo 后升级，API 再读仍为三角色（`t11-upgrade-reread.json`）。mac 未覆盖。
- T09 断网：隔离栈 + mock-echo，杀网关后约 15.6s blocked。mock-echo 现声明三角色，可做离线 Mixed。
- 未完成：**mac 未覆盖**、**三个不同真模型**（8795/8797 目录只有 pro/flash，其余通道未接入）、计划 A01–A34 多数仍只靠单测不能当 T12 勾完。
- T09 硬杀续跑（2026-09-10）：隔离栈三角色 `deepseek-v4-flash`，执行中硬杀 → 重启 `interrupted`、无自动重放 → resume 后 succeeded。
- T12 真模型小任务（2026-09-10）：三角色均为 `deepseek-v4-flash` 时小任务可 succeeded；两真模型分角色时规划 pro / 实施 flash 也可跑通。8795 目录仍只有 pro/flash，不能代替「三个不同真模型」。
- pin / 内核仍是 DSH **0.1.3-alpha.2**。本轮复跑：Mixed+ledger+bootstrap **158/158**；全量 `npm test` **510 / 503 pass / 6 fail / 1 skip**（仅生图×3、视频×2、oauth-subscribe×1 既有基线，零新增 Mixed 失败）。Playwright Mixed（排除「完整运行」）**5/5**：隔离 3476 + 8795 + `.dsh-mixed-t12e2e`，设置页断言公司目录每个模型在三角色下都可选。3473 旧 T11 实例未动。

## 现在在哪（2026-09-08 生图插件）

- **DSH 没有现成的、可配 GPT / Qwen / Grok 且走公司网关的生图插件。** awesome-dsh-plugin 的 Vision & Multimodal 是选图 / 预览 / 附件（如 `dsh-image-picker`），官方内核也没有 `image_generate` 工具。公司此前只有团队技能 `grok-imagine`（脚本调网关 `/v1/images/*`）。
- **已加公司一等插件 `@company-desk/desk-image`**：`plugins/desk-image`，写入 `profile/cordis.patch.yml` 与 `ensureProfile` 链接。工具 `image_generate` / `image_edit` 只走公司网关（密钥不落本机）；短名 `gpt` / `qwen` / `grok` 对到目录里的真实 id。设置 → 生图 可改默认模型；输入框「生图」芯片直接出图写工作目录。
- 管理员仍需在网关通道里接入对应上游（GPT Image / 通义万相 / Grok Imagine），目录里没有的 id 可在设置里填「额外模型 id」。

## 现在在哪（2026-09-08 追加）

- **Google One 个人订阅接入不可用，旧方案需迁移（2026-09-08 实测更正）**：之前新增的 `gemini-code-assist` 是旧 Gemini CLI 接入；Google 官方已于 2026-06-18 停用个人 Google AI Pro / Ultra 在此客户端的权限。用户亲测返回 `This client is no longer supported... migrate to Antigravity`。之前 mock 测试及安装包只证明本地协议代码可运行，不能证明个人订阅可用；项目 ID / 轮询修复包不能解决停用。README、provider 提示和上游错误分类已更正。当前尚未实现 Antigravity 集成，不要继续让个人用户登录旧 Gemini CLI、自建项目或更换旧 OAuth client ID。Standard / Enterprise 不受官方本次停用影响，但项目未实测企业账号。依据：https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals 。

- **第三方插件落地：完成**。`dsh-better-sidebar@0.18.0`（改动预览/审查工作台）+ `@anweat/dsh-browser@0.1.11`（浏览器自动化，21 个 `browser_*` 工具）随内核前缀离线分发：
  - `scripts/kernel/pin.json` 新增 `profilePlugins`（名字/版本/prune 白名单）；`install-kernel.mjs` 装到 staging 再按白名单拷进内核前缀；`ensureProfile` 写进 `dsh.profile.bundles`，并把插件 + 内核 `@deepseek-ai/*` peer 链接到 `$DSH_HOME/profiles/node_modules` 与内核顶层 scope；`build-payload.mjs` 打包前 `stripKernelPeerLinks` 剥掉运行时链接（否则 tar 翻倍）。
  - 浏览器配置在 `profile/cordis.patch.yml`：`channel: msedge` + `opencliEnabled: false`（用系统 Edge，不下载 Chromium）。
  - 顺手修了 desk-ui 的 `ctx.workspaces.startSession`（内核 0.1.2-rc.1 的服务名是 `uiWorkspace`；基线也复现）。
  - 验证：`scripts/test/*.test.mjs` 178 个全绿（177 pass + 1 skip）；开发版 `desk` profile 真机启动 → better-sidebar 面板/文件树/「本轮文件」diff 正常、`browser_status` 返回 21 tools、点「新会话」0 报错；`build-payload` 出的 `kernel.tar` 232MB 含两个插件。
  - 注意：`server/test/oauth-subscribe.test.js` 有 6 个既有失败（grok-imagine 图片/视频代理、管理页源码），与本次改动无关（未动 server/）。

## 现在在哪（2026-09-06）

- **全量体验/缺陷清扫：完成并提交**。四路并行审计（网关服务端 / 桌面壳+脚本 / desk-ui / desk-host）→ 修掉约 40 项，最严重的是：任务卡正文跨任务串数据、llm-proxy 客户端断连不取消上游（照跑照扣费）、store 半提交污染、网关令牌永久有效、个人区远端删除被镜像“复活”、/desk/api 无来源校验。过程与逐项清单见 `docs/sessions/2026-09-06.md`；`npm test` 169/169。
- **清扫补刀（同日第二轮提交）**：任务绑定沿会话树向上找（子代理/ralph 也能用 company_task_* 与任务上下文）；网关令牌失效时拆掉本机模型路由（不再挂死路由给误导性的「模型连接失败」）；用户名禁 `.` 开头/结尾与连续 `..`（会拼进 `_office/<用户名>` 路径）；网关读请求体超限改为读完即弃（keep-alive 残留半截 body 会污染下一请求帧解析）。`npm test` 170/170。

## 上一轮（2026-09-04 傍晚）

- 仓库：<https://git.ethan.team/ethanfly/company-harness>，分支 `main`（安装包工作用户同意直接提交在 `main` 上）
- 目标：复刻视频里的「企业交付工作台」—— 现产品名 **valimart harness**（统一服务端 + 共享模型 token + 桌面客户端）
- 状态：视频里出现的功能全部落地并有截图证据（`docs/evidence/00–18`）；`npm test` **67** 个用例全绿（含 sqlite / Anthropic 转译 / 备份）；
  Playwright 冒烟另跑 `npm run test:e2e`。
  内核由仓库自己安装打补丁（`scripts/install-kernel.mjs`），**不再依赖 `TDHarness-coding` 仓库**
- **安装包：完成**（提交 `ba2d0b6`（计划）→ `4f016a2`（Task 8 审查修复）+ 随后的文档提交；设计 `docs/superpowers/specs/2026-09-04-installers-design.md`，
  计划 `docs/superpowers/plans/2026-09-04-installers.md`，按计划 9 个任务逐个实现 / 审查 / 提交）。
  `npm run dist` 出两个 Windows 安装包：客户端 `dist/valimart-harness-Setup-<ver>.exe`（Electron 壳 + 随包 `node.exe` + 打好补丁的 `kernel.tar`，按用户一键安装到 `%LOCALAPPDATA%\\Programs\\valimart-harness`）
  与服务端 `dist/valimart-harness-Gateway-Setup-<ver>.exe`（NSIS + `node.exe` + WinSW 注册 Windows 服务 `TheDivaGateway`，装到 `%ProgramFiles%\\valimart harness Gateway`）。
  安装版首次启动不播种演示账号；打开管理页或客户端走「公司 → 管理员 → 同事」引导。
  本机（构建机）已实测：客户端装 → 冷启动 19 s / 热启动 2.4 s → 卸载；网关装成服务 → 安装版客户端登录 `boss` 到 `http://<本机名>:8790`（内核由安装版客户端拉起，页面在 IDE 浏览器里操作）、Mock Echo 有回复 →
  网关覆盖升级（`config.local.json` 保留）→ 两边卸载（数据保留）。**一台真正没有 Node 的机器还没试过**（见下面第 1 项）。用法与细节见 README §2.5。
- **内核门禁更新：完成**（设计 `docs/superpowers/specs/2026-09-04-kernel-auto-update-design.md`）。GitHub Release 发现 → `kernel:prepare` / 管理页试打 16 处补丁 → 发布 `current`；员工登录后后台拉 tar，下次启动再切换。壳没有自动更新。`pin.json` 仍是 0.1.1-rc.2，未升 0.1.2。
- **服务端可部署：完成**。默认 `gateway.sqlite`（`node:sqlite`），旧 JSON/JSONL 首次打开空库时迁入、旧文件不删；`DESK_GATEWAY_STORE=json` 回退。README 有 Caddy/Nginx HTTPS 反代与 `publicUrl` 改法。`npm run backup` / `scripts/backup-gateway.mjs`（安装包下次 `dist:gateway` 会带上）。
- **小项：完成**。公司技能示例 `_shared/skills/company-briefing/SKILL.md`（`Drive.ensureLayout` 播种；管理页 / 知识检索可见）。Playwright：`e2e/admin.smoke.spec.js` + `e2e/desk-flow.smoke.spec.js`（`npm run test:e2e`，用本机 Edge）。`launch.mjs` 重复装内核早已修掉。
- **ChatGPT / Claude 协议：完成一半**。Claude/Anthropic 走官方 Messages API（`x-api-key` + `/v1/messages`，流式转成 OpenAI chunk）；ChatGPT/OpenAI 仍是 `/chat/completions`。单测 + 本地假上游覆盖。**公网真跑仍要你提供 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`，然后 `npm run probe:channels`。**
- 跑起来（开发机）：`npm install` → `npm run dev`（首次会从 npm 下载内核，约 20 秒）；账号见 README §3

### 关键决定（别轻易推翻）

| 决定 | 为什么 |
|---|---|
| 网关令牌绑定「登录会话 = 一台电脑」，不是一人一枚 | 一人一枚时管理页/第二台电脑一登录就把桌面端悄悄踢下线，且客户端心跳查不出来。现在：换电脑不互踢、管理页不签令牌、登出只收本机、管理员吊销一次收全部 |
| 「个人」工作区一人一座 | 同一台电脑换人登录，前一个人的个人格子从列表收起（目录和会话日志保留） |
| 内核补丁用锚点式编辑，锚点对不上就硬失败 | 整文件覆盖会在升内核时悄悄吃掉上游修复。升版本只改 `scripts/kernel/pin.json`，失败的那条补丁必须人工重审 |
| 内核前缀独立（`~/.company-desk/kernel`），拒绝写全局 npm / node 目录 | 不碰任何正在被别的东西用的树；老机器上 `~/.tdh-coding-prefix` 有内核则复用 |
| 上游密钥只在服务端；客户端只拿网关令牌 | 「共享 token」的本质：公司统一持有密钥/订阅，全员共用额度但按人记账限额 |
| `server/data/` 不入库 | 里面有通道凭据、令牌、密码哈希；首次启动按 `config.json` 自动播种 |
| 安装版客户端 = Electron 壳 + **随包 `node.exe`**（构建机 `process.execPath`）+ **`kernel.tar`**（打好补丁的前缀，首次启动解到 `~/.company-desk/app/kernel`） | Electron 只做窗口与进程编排，内核运行时与 `npm run desktop` 完全同一份 node，零 ABI 风险；公司内网未必能到 npm registry，所以内核随包、首次启动不联网；单个 tar 比落 3 万个小文件装得快 |
| 安装版 profile 叫 `desk-app`，内核在 `~/.company-desk/app/kernel`（开发版 `desk` / `~/.company-desk/kernel`） | 开发机上两套并存互不改链接；登录态 / 公司盘镜像 / 会话（`~/.dsh/desk`、`~/.dsh/sessions`）故意共用 |
| 客户端安装目录 `%LOCALAPPDATA%\Programs\valimart-harness`（包名 `valimart-harness`） | electron-builder 26 在 oneClick + 按用户模式下用包名作目录；已把 `desktop/package.json` 的 name 从 `the-diva-desktop` 改掉 |
| Electron 自身的 userData 放 `~/.company-desk/app/electron`（不是 `%APPDATA%\THE DIVA`） | 客户端运行期状态只在 `~/.company-desk/{app,logs}` 与 `~/.dsh` 三处，卸载 / 清理有据可依 |
| `preparePackaged` 重新解压时只删自己建的六个条目（`kernel plugins profile scripts node_modules state.json`），不 `rmSync` 整个 appDir | `--app-dir` 误指到 `~/.company-desk` 之类有用目录时不能把开发内核、日志一起删掉 |
| 网关数据固定在 `%ProgramData%\valimart harness Gateway\data`，由服务定义 XML 的 `DESK_GATEWAY_DATA` 注入（优先于 `config.local.json` 的 `dataDir`）；XML 每次安装 / 升级由 `init.mjs` 重生成 | 数据不在 `%ProgramFiles%` 下、卸载保留；旧目录 `%ProgramData%\THE DIVA Gateway` 备份脚本仍识别。安装版 `config.local.json` 写 `seedAdmin: false` + `seedUsers: []`，首次打开管理页 / 客户端走引导，不播种 boss 与演示账号 |
| 网关卸载器只删 `runtime\ server\ service\ README.txt Uninstall.exe`，不 `RMDir /r $INSTDIR` | 用户在目录页选了已有目录时不能整个清空 |
| `dist:gateway` 的 makensis 复用 electron-builder 缓存（`MAKENSIS` 环境变量可覆盖） | 不再装一套 NSIS；代价是要先跑过 `dist:client` |
| 网关令牌带 TTL（=登录会话 TTL）并校验绑定会话未被吊销 | 之前令牌永久有效：重登录 / 忘记登出会无限累积永不失效的令牌；现在令牌自己会过期，登出 / 管理员吊销仍即时生效。旧版无 expiresAt 的令牌视为不过期（兼容存量） |
| 公司盘 DELETE 拒绝目录整删 | `rmSync recursive` 一次能删整棵 inbox / _office（含交付物文件）；要删就删到文件级（任务交付物走任务卡接口） |
| `/desk/api` 只信任本机工作台同源页面（Sec-Fetch-Site / Origin），非 JSON content-type 不给解析 | 本机回环接口权限大（上传本机文件、拉资源管理器、直通网关业务 API），网页盲 CSRF 面必须关掉 |

## 下次该干嘛（按优先级）

### 0. 清扫遗留：语义待拍板 + 性能项（2026-09-06）

- **额度口径**：现在“每个上游各一份完整周额度”，员工接 N 个上游可用 N 份；UI 概念像是单一周预算。要改成总额度就动 `ledger.exceeded/quotaView` + 管理页展示（标注不确定是否刻意，先问你）。
- **终态任务内容**：approved/pending_final 下 assigner/assignee 仍能改 title/content/submission 且不再走验收——是否有意？要锁就进 `tasks.js` update()。
- 性能：公司盘快照每 30s 全量 sha256 阻塞事件循环（>20MB 交付物被静默跳过）；`knowledge.search` 全树同步扫盘无超时/无上限——建议 mtime 增量 + 单查询限时。usage.jsonl 只增不删、内存全量缓存。
- desk-host：内核 `-prev` 只清不复用（boot 崩溃无自动回退）、patches.mjs 先落盘后 --check、主代理+子代理工作流下任务绑定 / produced 产物索引失效（U1）、needsRelogin 时路由不拆、换人登录删工作区注册。

### 1. 安装包：剩余验收与小项

- 在一台没有 Node 的 Windows 机器上按 README §2.5 的 checklist 走一遍（服务端 + 客户端 + 升级 + 卸载）；顺带确认 `services.msc` 里服务显示名「THE DIVA 公司网关」正常、
  安装详情页里 `[init]` 中文行不乱码、完成页文字不被截断（这三项本机没核对）
- 没做：代码签名（SmartScreen 会拦）、多尺寸 ICO（现在只有一张 256px）、macOS / Linux 包
- 自动更新：内核有门禁（GitHub 发现 → prepare 16 处补丁 → 管理页/CLI 发布；员工下次启动切换）；壳没有
- 网关安装器端口写死 8790（`installer/gateway.nsi` 的 `${PORT}`）：管理员改了端口再升级，防火墙规则会被重置回 8790、完成页 URL 也错；`init.mjs` 已算出真实端口但 NSIS 没用上
- 内核 tar 还能再瘦（tar 里还有约 2 千个随包发布的 `src/*.ts`；去掉未用依赖要动内核，慎）
- 切入点：`scripts/lib/bootstrap.mjs`（启动编排，开发与安装版共用；`preparePackaged` + NDJSON CLI）、`desktop/main.js`（Electron 主进程）、
  `scripts/build-payload.mjs`、`scripts/build-client-installer.mjs`、`scripts/build-gateway-installer.mjs`、`installer/gateway.nsi` + `installer/gateway/init.mjs`

### 2. 服务端可部署（已做，剩余运维）

- SQLite / HTTPS 说明 / 备份脚本已落地。还没做：网关自己终结 TLS（现在只反代）、把计划任务写进 NSIS、备份轮转
- 注意安装版数据目录是 `%ProgramData%\valimart harness Gateway\data`（`DESK_GATEWAY_DATA`）；旧机若还在 `THE DIVA Gateway` 下，备份脚本会回退识别

### 3. 小项（剩余）

- 示例 `SKILL.md` + Playwright 冒烟已落地。完整内核桌面页要设 `DESK_SMOKE_URL=http://127.0.0.1:3470` 再 `npm run test:e2e`
- UI 像素级对齐视频（现在是按画面还原，不是逐像素）
- Agent 真机列出技能：登录后等公司盘镜像同步，新会话里应能看到 `company-briefing`（本轮用网关检索 / 管理页验证，没再开一轮 Agent）

### 4. ChatGPT / Claude 真跑（等 key）

协议适配已做。把 key 放到环境变量后执行：

```powershell
$env:OPENAI_API_KEY = "sk-..."          # 或 CHATGPT_API_KEY
$env:ANTHROPIC_API_KEY = "sk-ant-..."
npm run probe:channels
```

然后在客户端「设置 → 同事 → 模型通道」接入，发一条看流式回复和账本。ChatGPT 订阅令牌如果不是 OpenAI API 兼容，需要自备反代并把通道 `baseUrl` 指过去。

### 审查留下的小问题（安装包各任务的代码审查，均非阻塞）

- **bootstrap / launch**：`linkJunction` 的 `catch {}` 吞掉了删除错误；`launch.mjs` 等待超时直接 `die` 会留下已 spawn 的网关 / 客户端孤儿；薄壳与库各算一套 root；测试覆盖面（`waitHttp`、`ensureProfile` 分支）不足
- **build-payload**：`--out` 任意路径无保护地 `rmSync`（`--out .` 会删仓库）；`--kernel-prefix build/kernel-stage` 会先删再装；`argOf` 把下一个 `--flag` 当值（几个脚本同一模式）；
  `digestFiles` 只覆盖 5 个文件且按 basename 排序；`node --check` 对同一文件重复执行
- **desktop/main.js**：`fatal()` 不杀 bootstrap 子进程；顶层 `mkdirSync` 无守卫（home 不可写会弹 Electron 原生错误框）；bootstrap 无超时；日志只在启动时滚动；内核在窗口后崩溃时对话框标题仍是「无法启动」
- **build-*-installer**：产物路径硬编码、`existsSync` 不查新鲜度（旧文件会蒙混）；`spawnSync` 自身失败时丢 `r.error`；`build/gateway` 复制 103 MB `node.exe` 之后才找 makensis / WinSW；`server/src` 平铺 `readdirSync`（有子目录会 EISDIR）
- **installer/gateway**：`init.mjs` 的 `isMain` 直接比路径（应像 bootstrap 一样双侧 realpath）、`xmlEscape` 不转义 `'`、先建 ProgramData 目录再读模板；升级中 `init` 失败后已停的旧服务不会被重新启动；
  管理页的内核版本标签在安装版里走回退文案（`scripts/kernel/pin.json` 不随包）
- **测试**：若干用例的 `mkdtemp` 目录不清理；`payload.test` 的「内容变 → 摘要变」未真正断言；`npm test` 输出里有服务端 `[gateway]` 日志噪音
- 杂项：`.gitignore` 里 `desktop/dist/` 冗余；`desktop/package.json` 的 version 与根同为 0.1.0（构建时被根版本覆盖，可改成占位）

## 注意事项

- 改了 `plugins/desk-ui/src/**` 要重新打包（`npm run build`，或 launch 自动），bundle 不入库
- 改了 `profile/cordis.patch.yml` 后 launch 会自动刷新 profile；改 `plugins/desk-host/lib/**` 要重启客户端进程
- 升内核版本前先读 `scripts/kernel/patches.mjs` 头部说明；`npm run kernel:check` 能告诉你缺哪条
- 测试用 `npm test`，用的是临时数据目录，不碰 `server/data/`；`preparePackaged` 用例依赖 `build/payload/kernel.tar`，没有会 skip（别把 skip 当通过）
- 演示机上的网关 8790 与客户端 3470 若还在跑，改服务端代码后要重启网关进程
- **安装包构建**：改了 `scripts/lib/bootstrap.mjs`、`scripts/kernel/*`、`plugins/**`、`profile/cordis.patch.yml` 要重新 `npm run dist:client`（它们随包）；改了 `server/src/**`、`server/config.json`、
  `installer/**` 要重新 `npm run dist:gateway`。`build/`、`dist/` 不入库；`desktop/package-lock.json` 入库（锁 electron-builder 依赖树）
- 装 Electron 用 `npm --prefix desktop install`（不要加 `--allow-scripts=electron`，npm 11.19 会报 EALLOWSCRIPTS，Electron 44 也没有 postinstall）。
  Electron / electron-builder 二进制走 GitHub 在这个网络里会失败，`build-client-installer.mjs` 默认用 npmmirror（`ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR`），
  开发模式 `npm --prefix desktop start` 首次跑之前要自己设 `ELECTRON_MIRROR`
- `npm run dist:gateway` 依赖 electron-builder 缓存里的 makensis（`%LOCALAPPDATA%\electron-builder\Cache\nsis-*\nsis-*-*\Bin\makensis.exe`）：先跑过一次 `dist:client`，或设 `MAKENSIS`（查找顺序：`MAKENSIS` → 缓存 → PATH 里的 `makensis`）
- 网关安装包要管理员（UAC）才能装 / 升级 / 卸载；验证它需要用户在旁边点 UAC。装完机器上会有一个开机自启的服务 `TheDivaGateway` 与防火墙规则「THE DIVA Gateway」，测完记得卸载
- 本机 shell 是 Windows PowerShell 5.1：不支持 `&&`（用 `;`）；含中文的提交信息用 `git commit -F <UTF-8 无 BOM 文件>`，别直接 `-m`
- 安装版客户端与 `npm run dev` 共用 `~/.dsh/desk`（登录态、公司盘镜像），在开发机上测安装版时看到已登录 / 有账号预填是正常的
