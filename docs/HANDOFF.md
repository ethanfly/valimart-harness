# 交接：现在在哪、下次该干嘛

> 活文档。每次会话结束更新这里；过程记录放 `docs/sessions/`。

## 现在在哪（2026-09-04 傍晚）

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

## 下次该干嘛（按优先级）

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
