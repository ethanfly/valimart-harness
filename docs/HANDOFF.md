# 交接：现在在哪、下次该干嘛

> 活文档。每次会话结束更新这里；过程记录放 `docs/sessions/`。

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
