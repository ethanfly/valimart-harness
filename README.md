# valimart harness · 企业交付工作台

本项目是在 [TDHarness-coding](https://github.com/398894496-arch/TDHarness-coding) 上的**二次开发**，
核心运行时是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（npm：`@deepseek-ai/dsh`）。
内核由本仓库自己安装并打补丁（`scripts/install-kernel.mjs`），日常开发**不必再克隆**上游仓库——
进入这个目录、`npm install`、`npm run dev` 即可。

> 接手先看 [`docs/HANDOFF.md`](docs/HANDOFF.md)（现在在哪、关键决定、下次该干嘛）；过程记录在 [`docs/sessions/`](docs/sessions/)。

- **桌面客户端（valimart harness）**：左侧「会话 / 任务」双栏，个人与团队工作区，会话页可选模型、切换标准模式、
  `Full access` 权限，输入框「文件」芯片把本机文件放进工作目录并作为 `@` 引用；Agent 在本机执行，
  流式输出。
- **任务卡**：新建 / 列表 / 详情（概览、工作日志），提交信息、交付物（公司盘）、
  四格验收流 `待初审 → 待终审 → 通过 / 退回`，可指定审核人；只说做完了不算完成，必须有交付物。
- **设置**：通用、账号、同事（每人每周模型额度、7 天账本、模型花费、通道接入）、Agent 预设、
  人员（按部门分组、改角色、停用、吊销令牌）、订阅。
- **公司知识库（四层通道）**：① 岗位手册 `_shared/handbook`（全员只读）② 共享经验 `_shared/_memory`
  （六个子层，员工只能追加日志）③ 个人记忆 `_office/<账号>/_memory`（一人一座，跟人走）
  ④ 检索层 `company_knowledge`：开工前问「公司里有没有人做过」→ 谁 / 何时 / 在哪 / 一小段上下文，
  不拷贝别人的会话。Agent 工具与服务端管理页都能用。
- **公司网关（服务端）**：公司账号登录、每台登录设备一枚可即时吊销的网关令牌、模型密钥代理
  （密钥只在服务端，按人记账 / 限额）、按人隔离的公司盘、任务与验收流持久化、
  管理页 `/admin`（状态 / 公司盘 / 模型通道 / 知识库查询）。

```
company-desk/
├─ server/                 # 公司网关（Node.js，无第三方依赖）
│  ├─ config.json          # 默认配置：账号种子、额度、上游模型、通道目录
│  ├─ skills/              # 随包公司技能（ensureLayout 播种到公司盘 _shared/skills）
│  ├─ src/                 # http 路由 / 登录令牌 / LLM 代理 / 账本 / 任务 / 公司盘 / 通道
│  └─ test/                # 网关端到端 + sqlite / Anthropic 转译（node --test）
├─ plugins/
│  ├─ desk-host/           # dsh 宿主插件：网关登录态、模型路由、公司盘镜像、任务工具、/desk/api
│  ├─ desk-image/          # 生图插件：经公司网关 /v1/images/* 调用 GPT / Qwen / Grok 等模型
│  └─ desk-ui/             # dsh 浏览器端插件：valimart harness 外壳、侧栏、任务页、设置页、登录遮罩
├─ profile/cordis.patch.yml# dsh "desk" profile 补丁层（关官方外壳、插公司插件、默认全访问）
├─ desktop/                # Electron 壳（安装版客户端，§2.5）：main.js、splash.html、electron-builder.yml、build/icon.*；独立 npm 子项目
├─ installer/              # 网关安装包（§2.5）：gateway.nsi、gateway/init.mjs + TheDivaGateway.xml.tpl（WinSW 服务定义）、pins.json
└─ scripts/
   ├─ kernel/
   │  ├─ pin.json          # 内核锁定版本（@deepseek-ai/dsh@0.1.2-rc.1）
   │  ├─ patches.mjs       # 内置的公司内核补丁集（锚点式编辑，幂等；锚点对不上即失败）
   │  └─ locate.mjs        # 找内核前缀 / 兼容 Windows 与 POSIX 的 npm 目录布局
   ├─ lib/bootstrap.mjs    # 启动编排库：开发模式（launch / setup-profile）与安装版（Electron 主进程调用）共用
   ├─ install-kernel.mjs   # npm 装锁定版本的 dsh 到独立前缀并打补丁（npm run kernel / kernel:check）
   ├─ setup-profile.mjs    # 把 profile + 插件装进 ~/.dsh/profiles/desk（先确保内核就位）
   ├─ build-client.mjs     # esbuild 打包 desk-ui 浏览器端
   ├─ launch.mjs           # 一条命令拉起 网关(可选) + 客户端 + 桌面窗口（缺内核/profile/bundle 都自动补）
   ├─ build-payload.mjs / build-client-installer.mjs / build-gateway-installer.mjs / make-icon.mjs   # 安装包流水线（§2.5）
   ├─ backup-gateway.mjs   # 网关数据目录备份（sqlite serialize + 公司盘）
   └─ test/                # bootstrap / payload / gateway-init / backup 单元测试（node --test，随 npm test 跑）
```

## 1. 环境要求

- Windows 10/11（macOS / Linux 也可，桌面窗口靠 Edge / Chrome 应用模式）
- Node.js ≥ 22（开发时用的是 25.x），自带 npm
- 首次安装需要能访问 npm registry（下载内核）；之后离线可用

## 2. 安装

```powershell
cd company-desk
npm install                 # 只有 esbuild 一个开发依赖
npm run setup               # ① 装内核 ② 安装 desk profile 到 ~/.dsh/profiles/desk（launch.mjs 缺了也会自动补）
npm run build               # 打包 desk-ui 浏览器端（launch.mjs 发现源码更新会自动重打）
```

### 内核（自带，不依赖别的仓库）

`npm run setup`（或第一次 `npm run dev`）会执行 `scripts/install-kernel.mjs`：

1. `npm install -g @deepseek-ai/dsh@<pin> --prefix ~/.company-desk/kernel` —— 装进**独立前缀**，
   绝不碰全局 npm / `~/.local` / node 自己的目录（脚本会拒绝这些路径）；
2. 对该前缀应用 `scripts/kernel/patches.mjs` 里的 16 处公司补丁（见下表），每处在文件尾留 mark，
   再跑只补缺的，`node --check` 保证语法；
3. 写 `<前缀>/.company-desk-kernel.json` 戳记。

```powershell
npm run kernel:check        # 只检查：版本对不对、16 处补丁齐不齐（退出码 0/1）
npm run kernel              # 幂等：缺什么补什么
node scripts/install-kernel.mjs --force   # 重新 npm 安装再打补丁
```

前缀可用 `--prefix` / `DESK_KERNEL_PREFIX` 指定；旧机器上 `~/.tdh-coding-prefix` 里若已有内核会直接复用。
换内核版本只改 `scripts/kernel/pin.json`——补丁锚点对不上会硬失败并指出哪一条，逼着重审那条补丁，
而不是悄悄半套用。

| mark | 包 / 文件 | 一句话 |
|---|---|---|
| `company-sandbox-local-unc-v1` | `dsh-sandbox-local` | 拒绝把 UNC 路径当 `workspace-write` 根；ACL 授权失败给出诊断 |
| `company-skill-custom-trusted-v1` / `-get-custom-trusted-v1` | `dsh-skill-filesystem` | 公司技能目录走 Node fs 读取（列表与读取都行） |
| `company-skill-root-eacces-v1` | `dsh-skill-filesystem` | 一个根 EACCES 只当空，不拖垮整个技能提供者 |
| `company-fs-unc-acl-v1` / `-unc-replace-v1` | `dsh-fs-local` | 公司 SMB 上跳过 DACL 复制与 `ReplaceFileW`，改 rename |
| `company-goal-resume-armed-v1` | `dsh-goal` | 重复 resume 已激活的 goal 视为 no-op，不中断回合 |
| `company-win-junction-mklink-v3` / `-v4` | `dsh-app-boot` | Windows 用 `mklink /J`（无需开发者模式），cwd 固定为 SystemRoot |
| `company-glob-missing-root-v1` | `dsh-tool-fs-search` | rg 搜索根不存在 → 空结果而非硬失败 |
| `company-session-smbfs-rename-v1` | `dsh-session-persistence-jsonl` | 会话落盘 `link` ENOTSUP 时回退 rename；吞目录 fsync 的 ENOTSUP |
| `company-preset-skills-v2` | 预设 `standard` | 技能根只看公司盘 `_shared/skills` 的本机镜像（`~/.dsh/desk/drive/_shared/skills`） |
| `company-preset-web-fetch-v2` | 预设 `standard` / `code` | 会话开 `web_fetch`，放宽超时 |
| `company-preset-instr-root-v1` | 预设 `standard` / `code` | 指令文件项目根标记 `.company-root`，不往上翻到 `$HOME` |

### 随内核分发的第三方插件

`scripts/kernel/pin.json` 的 `profilePlugins` 列出随内核一起装、离线分发的第三方插件（员工机器不需要 npm/pnpm）：

| 插件 | 版本 | 作用 |
|---|---|---|
| `dsh-better-sidebar` | 0.18.0 | 右侧工作台：文件树 / CodeMirror 编辑器 / 图片·Markdown·HTML·PDF 预览 / 内嵌浏览器 / 真实终端 / Git 视角（真实 diff、暂存·提交·还原）/ **本轮文件视角**（agent 的 write/edit/read 按文件分组，点开看行级 diff） |
| `@anweat/dsh-browser` | 0.1.11 | 浏览器自动化：21 个 `browser_*` 工具（navigate / snapshot / click / fill / screenshot …）。`profile/cordis.patch.yml` 配 `channel: msedge`（用系统 Edge，不下载 Chromium）+ `opencliEnabled: false` |

公司一等插件 `@company-desk/desk-image` 不走 npm：随 `plugins/desk-image` 安装进 desk profile。官方 / 社区 DSH 没有可配 GPT / Qwen / Grok、且走公司网关的生图插件（awesome 清单 Vision 类是选图、预览、附件）。本插件注册 `image_generate` / `image_edit`，设置 → 生图 可选默认模型短名 `gpt` / `qwen` / `grok` 或目录里的真实 id。

安装链路：`install-kernel.mjs` 把插件装到独立 staging（`--omit=peer`，避免 `npm install` 把 `-g` 装进去的内核当 extraneous 删掉），按 `prune` 白名单拷进内核前缀的 `node_modules`（裁掉只服务预打包 client bundle 的 `react-icons`/`mermaid`/`@codemirror` 等，约省 300MB）；`ensureProfile` 把插件名写进 profile 的 `dsh.profile.bundles`，并在启动时把插件和内核的 `@deepseek-ai/*` peer 链接到 `$DSH_HOME/profiles/node_modules` 与内核前缀顶层 scope（DSH 运行时 `import()` 只沿 profile 目录向上找）。`build-payload.mjs` 打包前用 `stripKernelPeerLinks` 剥掉这些运行时链接，否则 `cpSync`/`tar` 会跟随 junction 把 kernel.tar 撑大一倍。

体积：kernel.tar 从 147MB 增至约 232MB（插件约 85MB，主要是 node-pty 34MB、better-sidebar 13MB、playwright 15MB）。`npm run kernel:check` 会一并校验插件是否装齐、版本是否对。

把 `SKILL.md` 放进公司盘 `_shared/skills/<名字>/`，同步到每个人后 Agent 即可使用。

### 上游模型密钥（只放服务端）

#### Google One / Gemini：个人订阅旧接入已停用

**2026-09-08 实测更正：本项目当前的 `gemini-code-assist` 适配不能用于个人 Google One / Google AI Pro / Ultra 订阅。** Google 官方已于 2026-06-18 停用个人版 Gemini Code Assist 和 Gemini CLI 的 Google 登录，要求迁移到 Antigravity。项目早先依照仍在线的旧登录文档实现，mock 测试通过不代表当前个人订阅仍可用；初始化轮询修复也无法恢复已停用的服务。

个人账号请使用官方 [Antigravity](https://antigravity.google) 或 [Antigravity CLI](https://antigravity.google/docs/cli/install/)。**本项目尚未实现 Antigravity 接入。** 官方 CLI 的 headless 自动化模式不是现有网关的 OpenAI 模型代理接口，不能通过更换 OAuth client ID 或品牌名称声称完成迁移。

旧 Code Assist 适配代码保留；Google 的停用公告明确 Code Assist Standard / Enterprise 不受此次停用影响，但本项目也未实测企业账号。旧适配的流式回复、工具签名、图片和账号续期测试仅验证协议转换逻辑。

企业 Code Assist 配置可使用 `oauth.gemini.clientId/clientSecret/redirectUri/projectId`（对应 `OAUTH_GEMINI_*` 环境变量）。配置自有项目不能解决个人版客户端停用。AI Studio API key 是另一种接入和计费方式，不应当作 Google One 订阅令牌填写。

更新后重启网关、刷新客户端。若 `config.local.json` 自定义了整个 `channels` 数组，需将默认 `server/config.json` 中的 `gemini` 条目同步到该数组。

依据：[Google 官方停用公告](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals?hl=zh-cn)、[Antigravity CLI 迁移指南](https://antigravity.google/docs/cli/gcli-migration/)。

#### API 密钥

网关从 **环境变量** 或 `~/.dsh/.credentials.yaml` 读取上游密钥，客户端永远拿不到：

```powershell
$env:DEEPSEEK_API_KEY = "sk-..."        # 或写进 ~/.dsh/.credentials.yaml： DEEPSEEK_API_KEY: sk-...
```

没有任何密钥时，目录里仍有 `mock-echo`（离线演示用）。管理员也可以在客户端
**设置 → 同事 → 模型通道** 里接入 Grok / ChatGPT / Claude 订阅或 OpenAI / Anthropic / DeepSeek key，
凭据写入 `server/data/gateway.sqlite`（集合名仍叫 `channels.json`），全员模型目录即时更新。
Claude / Anthropic 官方端点走 Messages API（`x-api-key` + `/v1/messages`）；ChatGPT / OpenAI 仍是 `/chat/completions`。
有真实 key 时可 `npm run probe:channels`（读 `OPENAI_API_KEY` / `CHATGPT_API_KEY` / `ANTHROPIC_API_KEY`，不把密钥打进日志）。

### 本机覆盖

- `server/config.local.json`：覆盖 `config.json` 任意字段（不入库），例如改端口、公司名、额度。
- 环境变量：`DESK_GATEWAY_HOST` / `DESK_GATEWAY_PORT` / `DESK_GATEWAY_DATA`（网关），
  `DESK_GATEWAY_URL`（客户端指向的网关）、`DESK_PORT`（客户端端口）、`DESK_STATE_DIR`（客户端状态目录）。

## 2.5 安装包（不依赖目标机器有 Node）

两个 Windows x64 安装包，设计见 [`docs/superpowers/specs/2026-09-04-installers-design.md`](docs/superpowers/specs/2026-09-04-installers-design.md)。
目标机器不需要 Node / npm / Git，客户端首次启动不联网：

| 产物 | 给谁 | 安装方式 |
| --- | --- | --- |
| `dist/valimart-harness-Setup-<ver>.exe`（约 150 MB） | 员工电脑 | 一键**按用户**安装，不需要管理员；装到 `%LOCALAPPDATA%\Programs\valimart-harness`（落盘约 600 MB；桌面 / 开始菜单快捷方式叫 **valimart harness**，「应用和功能」里显示为 **valimart harness 0.1.0**）；首次启动把内核解压到 `~/.company-desk/app`（本机实测约 19 s），之后约 2–3 s 开 |
| `dist/valimart-harness-Gateway-Setup-<ver>.exe`（约 25 MB） | 公司服务器 | 需要管理员（UAC）；装到 `%ProgramFiles%\valimart harness Gateway`，注册 Windows 服务 `TheDivaGateway`（随系统自启，崩了自动重启），防火墙放行 TCP 8790；数据在 `%ProgramData%\valimart harness Gateway\{data,logs}`（卸载保留） |

两个包都**未签名**：首次运行 SmartScreen 会拦，「更多信息 → 仍要运行」。安装器 / 卸载器都支持静默参数 `/S`。

### 构建（在有 Node 的开发机上）

```powershell
npm --prefix desktop install   # 首次：装 Electron 44 / electron-builder 26（只在 desktop/ 子项目里；根 package.json 仍只有 esbuild）
npm run dist:client            # = build-payload.mjs（→ build/payload）+ build-client-installer.mjs → dist/valimart-harness-Setup-<ver>.exe
npm run dist:gateway           # = build-gateway-installer.mjs（→ build/gateway）→ dist/valimart-harness-Gateway-Setup-<ver>.exe
npm run dist                   # 两个都出
```

- 版本号取根 `package.json` 的 `version`，两个包相同。
- **预置公司网关地址**（客户端登录页的默认值）：`node scripts/build-payload.mjs --gateway http://gw.company.local:8790; node scripts/build-client-installer.mjs`，
  或设好 `DESK_GATEWAY_URL` 再 `npm run dist:client`（`dist:client` 会重跑 `build-payload.mjs`，单独跑过的 `--gateway` 会被它覆盖）。
  不预置则默认 `http://127.0.0.1:8790`，员工在登录页自己填。
- **网络**：Electron 本体与 electron-builder 的辅助工具（NSIS、7zip、icons）走 GitHub 下载，在这个网络里经常失败；`build-client-installer.mjs` 在环境变量未设置时
  默认走 npmmirror（`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`、`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`），
  要换源就自己设这两个变量。Electron 44 没有 postinstall，二进制是首次 `electron .` 时才惰性下载：开发模式 `npm --prefix desktop start` 之前请先
  `$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"`（或显式 `node desktop/node_modules/electron/install.js`）。
  WinSW 按 `installer/pins.json` 下载到 `build/cache/WinSW-2.12.0.exe` 并校验 SHA256，下载不了就手动下好放到那里。
- **makensis**：`dist:gateway` 复用 electron-builder 下到缓存里的 NSIS（`%LOCALAPPDATA%\electron-builder\Cache\nsis-<ver>\nsis-<ver>-<随机后缀>\Bin\makensis.exe`），
  所以**要先成功跑过一次 `npm run dist:client`**；或自装 NSIS 3 并设 `MAKENSIS` 指向 `makensis.exe`（查找顺序：`MAKENSIS` 环境变量 → electron-builder 缓存 → PATH 里的 `makensis`）。
- 内核来源：本机默认前缀（`~/.company-desk/kernel`；也认 `DESK_KERNEL_PREFIX` 和旧位置 `~/.tdh-coding-prefix`，同 `scripts/kernel/locate.mjs`）版本等于 `scripts/kernel/pin.json` 且 16 处补丁齐 → 直接复制；否则重新 `install-kernel.mjs` 到 `build/kernel-stage`（要网络）。
  修剪 `.d.ts` / source map / 非 win32-x64 的 node-pty 预编译后打成 `kernel.tar`（约 134 MB），用 Windows 自带的 `tar.exe`（bsdtar，Win10 1803+）。
- 图标 `desktop/build/icon.png`（1024）/`icon-512.png`/`icon.ico`（16–256）已入库；改图标才需要 `npm run icon`（本机 Edge/Chrome 渲矢量花标，再面积采样）。
- `build/`、`dist/` 不入库；改了 `scripts/lib/bootstrap.mjs`、`scripts/kernel/*`、`plugins/**`、`profile/cordis.patch.yml` 要重新 `npm run dist:client`（它们都随包）。
- 本机 shell 是 Windows PowerShell 5.1：多条命令用 `;` 连接，不支持 `&&`。

### 客户端（valimart harness）

- 启动流程：启动页 → 随包 `node.exe` 跑 `bootstrap.mjs --packaged`（首次 / 升级后解压 `kernel.tar` 到 `~/.company-desk/app/kernel`，
  把内核预设里的技能根改成本机 `~/.dsh/desk/drive/_shared/skills`，装 dsh profile `desk-app`）→ 选端口起内核 → 等 HTTP 就绪 → 主窗口。
  任务管理器里内核进程是 `…\Programs\valimart-harness\resources\payload\runtime\node.exe`。
- 登录页「公司网关」填 `http://<服务器名或 IP>:8790`（打包时可预置，见上）。
- 端口 3470 被占会顺延 3471…3479，再不行随机；内核页面的偏好存在浏览器端、按端口（origin）区分，换端口会重置主题等偏好。
- 运行期状态全部在用户目录：`~/.company-desk/app`（解压的内核、插件 / profile / scripts 副本、`state.json`，以及 Electron 自身的 userData `electron/`）、
  `~/.company-desk/logs/desktop.log`（5 MB 滚动保留 3 份，含 bootstrap 与内核输出）、`~/.dsh/profiles/desk-app`；
  登录态 / 公司盘镜像 / 会话仍在 `~/.dsh/desk`、`~/.dsh/sessions`。安装目录运行期只读。
- 排障：F12 开 DevTools、F5 重载；启动失败弹「valimart harness 无法启动」对话框，可直接打开日志目录。
- 升级：公司网关发布新 Setup 后，已装客户端登录会后台下载，下次启动静默覆盖安装（见 §2.5 客户端更新）；也可以继续手动装新版本（一键安装器会先卸旧的）。首次启动发现 `buildId` 变了会重新解压内核（`~/.company-desk/app` 里本程序建的条目整体换新，`~/.dsh/profiles/desk-app` 随之刷新，`~/.dsh/desk`、`~/.dsh/sessions` 不动）。
  卸载（「设置 → 应用」，或 `"%LOCALAPPDATA%\Programs\valimart-harness\Uninstall valimart harness.exe" /S`）不删 `~/.company-desk` 与 `~/.dsh`。
- 开发机上安装版与 `npm run dev` 并存：安装版用 profile `desk-app` + `~/.company-desk/app/kernel`，开发版用 `desk` + `~/.company-desk/kernel`；
  登录态、公司盘镜像、会话（`~/.dsh/desk`、`~/.dsh/sessions`）共用，两边看到的是同一个登录账号。
  开发调试 Electron 壳请用 `npm --prefix desktop start -- --app-dir <dir> --dsh-home <dir>` 指到专用目录（绝对路径），不要与已安装的客户端共用 `~/.company-desk/app`：两边 `buildId` 不同，每次切换都会重新解压内核。
  `--app-dir` 指到含 `package.json` / `.git` 的目录（如仓库根）会被 `bootstrap.mjs` 直接拒绝。

### 服务端（valimart harness Gateway）

- 安装向导：欢迎 → 目录 → 安装 → 完成（显示管理页地址；首次打开管理页会引导设置公司名、初始管理员账号与密码，**没有演示数据**）。
  安装 = 停旧服务 → 复制文件 → `runtime\node.exe service\init.mjs <INSTDIR>` 生成配置与服务定义 → `icacls` 收紧数据目录 → WinSW 注册并启动服务 → 防火墙放行 TCP 8790。
- 安装目录：`runtime\node.exe`、`server\{src, config.json, package.json, config.local.json}`、
  `service\{TheDivaGateway.exe（WinSW 2.12.0）, TheDivaGateway.xml.tpl, TheDivaGateway.xml, init.mjs}`、
  `scripts\`（`kernel\{patches.mjs, locate.mjs, pin.json}` 与 `lib\{kernel-update,kernel-prepare,payload,npm-cli,find-tar}.mjs`：`api.js` 启动时静态导入，做内核目录与试打；pin 也给管理页显示版本）、
  `README.txt`（配置 / 密钥 / 日志说明，装完请读）、`Uninstall.exe`。
- 配置 `server\config.local.json`：首次安装生成（`host 0.0.0.0`、`port 8790`、`publicUrl http://<主机名小写>:8790`、`dataDir`、`seedAdmin: false`、`seedUsers []`——不播种 boss / 演示账号，打开管理页或客户端完成引导），**升级不覆盖**，改完重启服务。
  改端口后要同步改防火墙规则「valimart harness Gateway」——安装器只放行 8790，升级时会把规则重置回 8790。
- 数据目录固定在 `%ProgramData%\valimart harness Gateway\data`：服务定义里的 `DESK_GATEWAY_DATA` 优先于 `config.local.json` 的 `dataDir`；
  安装器用 `icacls` 把 `%ProgramData%\valimart harness Gateway` 收紧为仅 SYSTEM 与 Administrators 完全控制（服务跑在 LocalSystem；失败只在安装日志里警告）；
  `service\TheDivaGateway.xml` 每次安装 / 升级都由 `init.mjs` 按模板重新生成，**不要手改**（包括往里加 `<env>`）。
  日志在 `%ProgramData%\valimart harness Gateway\logs\TheDivaGateway.{out,err,wrapper}.log`。
- 上游模型密钥（服务跑在 LocalSystem，`~/.dsh/.credentials.yaml` 这条路不可用），三种方式都能跨升级保留：
  ① 管理员在客户端「设置 → 同事 → 模型通道」接入（落 `data\gateway.sqlite`）；
  ② `server\config.local.json` 写 `{ "upstreams": { "deepseek": { "apiKey": "sk-…" } } }`（`upstreams.<id>.apiKey`，id 见 `config.json`）；
  ③ 机器级环境变量，变量名是 `config.json` 里该上游的 `apiKeyEnv`（DeepSeek 为 `DEEPSEEK_API_KEY`）：管理员 `setx /M DEEPSEEK_API_KEY sk-…` 后重启服务（个别机器要重启系统才生效）。
- 管理：`services.msc`（服务 `TheDivaGateway`）或 `service\TheDivaGateway.exe start|stop|restart|status`；`sc.exe query TheDivaGateway`。
- 升级 = 重跑新版本安装包（停服务 → 覆盖文件 → `config.local.json` 与数据不动 → 重注册并启动）。
  卸载（「设置 → 应用」或 `Uninstall.exe /S`）：停并注销服务、删防火墙规则、删安装目录（只删自己装的东西）与注册表项，**保留** `%ProgramData%\valimart harness Gateway`，
  并把 `server\config.local.json` 备份为那里的 `config.local.json.bak`（重装后复制回 `server\` 再重启服务即可恢复端口 / publicUrl / 密钥）。
  「应用和功能」项在 `HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\TheDivaGateway`（含 `QuietUninstallString`）。

### HTTPS（反代，网关本身仍是 HTTP）

网关只听 HTTP。对外用 HTTPS 时在前面加 Caddy / Nginx，把 `publicUrl` 和客户端登录页的网关地址改成 `https://…`。防火墙放行 443，不要把 8790 暴露到公网。

Caddy：

```
desk.example.com {
    reverse_proxy 127.0.0.1:8790
}
```

Nginx：

```
server {
    listen 443 ssl;
    server_name desk.example.com;
    ssl_certificate     /etc/ssl/desk.crt;
    ssl_certificate_key /etc/ssl/desk.key;
    location / {
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }
}
```

装完后：`server\config.local.json` 的 `publicUrl` 改成 `https://desk.example.com`，重启 `TheDivaGateway`。员工客户端网关填同一地址。流式对话依赖反代不缓冲（上面 `proxy_buffering off` / Caddy 默认即可）。

### 备份

```powershell
npm run backup
npm run backup -- --data-dir "$env:ProgramData\valimart harness Gateway\data" --out D:\backups\valimart-harness.zip
```

脚本会 `serialize` 一份一致的 `gateway.sqlite`，再拷公司盘 `drive/` 和遗留的 json/jsonl。计划任务（每天凌晨，用 SYSTEM 跑）：

```
schtasks /Create /TN "valimart harness Gateway Backup" /SC DAILY /ST 02:30 /RU SYSTEM /TR "\"C:\Program Files\valimart harness Gateway\runtime\node.exe\" \"C:\Program Files\valimart harness Gateway\scripts\backup-gateway.mjs\" --data-dir \"%ProgramData%\valimart harness Gateway\data\" --out \"%ProgramData%\valimart harness Gateway\backups\latest.zip\""
```

安装版网关会带上 `scripts/backup-gateway.mjs`（下次重打 `dist:gateway` 后生效）。

### 无 Node 机器验收 checklist

1. 服务器：双击网关安装包 → `sc.exe query TheDivaGateway` 为 `RUNNING` → 浏览器打开 `http://<服务器名>:8790/admin` → 走首次引导设置公司名与管理员 → 进入管理页。
2. 员工机：双击客户端安装包 → 桌面快捷方式「valimart harness」启动 → 登录页填 `http://<服务器名>:8790`、刚设好的管理员账号 → 新会话发一句 → 有回复
   → 任务管理器里内核进程是 `…\Programs\valimart-harness\resources\payload\runtime\node.exe` → 关窗后无残留 `node.exe` → 再开一次秒开。
3. 服务器重跑同一安装包（升级）→ `config.local.json` 不变、服务 `RUNNING`；卸载 → `%ProgramData%\valimart harness Gateway` 仍在。

构建机（本机）已于 2026-09-04 以等价方式走过以上流程（两个包均 `/S` 静默安装、脚本启动客户端、在 IDE 浏览器里操作内核页面完成登录 / 发消息；管理页只核对了 HTTP 200，未在管理页登录；见 `docs/sessions/2026-09-04.md`）；一台真正没有 Node 的机器、双击安装 / 桌面快捷方式启动 / 管理页登录都还没试过。

### 内核更新（公司门禁）

员工机不直连 GitHub / npm。管理员在网关侧发现、试打补丁、发布；已登录员工**下次启动**才切换。Electron 壳走另一条通道：管理员把 `dist:client` 打出的 Setup.exe 发布到网关，员工机登录后后台下载，再下次启动时静默 `/S` 覆盖安装。

```powershell
npm run kernel:discover                                    # 列比当前 / pin 新的 GitHub Release（tag dsh-v*）
npm run kernel:prepare -- --version 0.1.2-rc.1             # 装指定 npm 版 + 16 处补丁，通过才打 tar
npm run kernel:publish -- --gateway http://127.0.0.1:8790 --user boss --password <管理员密码> --from build/kernel-update/<ver>
```

管理页 `/admin` 的「内核」一节：当前版本（无发布则显示随包保底 pin）、已存列表、发现列表、`discoverError`；管理员可「试打补丁 / 发布 / 回滚」，总监只读。

`scripts/kernel/pin.json` 当前锁定 `@deepseek-ai/dsh@0.1.2-rc.1`（2026-09-07 已对该版本跑过 `kernel:prepare`，公司补丁通过）。换更新版本前必须再跑一次 prepare。

### 客户端更新（整包 Setup.exe）

营销版本号一直是 `0.1.0`，用 `build/payload/payload.json` 的 **buildId** 区分构建。管理员把安装包存进网关 `data/clients/<buildId>/`，发布 `current.json`；员工机登录 / 开机校验时拉 `/api/client/current`，不同 buildId 就后台下载到 `~/.company-desk/app/client-next/`，下次启动 Electron 主进程在进内核之前 spawn Setup `/S` 后退出（`runAfterFinish: true` 会再打开新进程）。开发模式（`npm run client`）不下载、不安装。

旧安装包里没有这段更新器：同事须先**手动装一版带更新器的客户端**，之后才走网关自动更新。内核 tar 与客户端 Setup 是两条通道，互不替代。

```powershell
npm run dist:client
npm run client:publish -- --gateway http://127.0.0.1:8790 --user boss --password <管理员密码> --from dist/valimart-harness-Setup-0.1.0.exe
```

`client:publish` 默认读 `build/payload/payload.json` 的 buildId；也可 `--build-id`。管理页 `/admin` 的「客户端」一节：当前 buildId、已存列表、上传并发布、把已入库版本再发布、回滚；总监只读。上传时必须手填 payload.json 的 buildId（文件名只有 `0.1.0`，不能当版本号）。

## 3. 启动

以下是开发机上的跑法；员工机 / 服务器用 §2.5 的安装包，装完双击桌面「valimart harness」即可，不需要这些命令。

单机演示（网关 + 客户端 + 桌面窗口，一条命令）：

```powershell
npm run dev                 # = node scripts/launch.mjs --with-server --desktop
```

分开跑：

```powershell
npm run server              # 网关 http://127.0.0.1:8790
npm run client              # 客户端 http://127.0.0.1:3470（浏览器打开）
npm run desktop             # 客户端 + 独立桌面窗口（Edge/Chrome 应用模式，关窗即退出）
```

`launch.mjs` 参数：`--port <n>`、`--gateway <url>`、`--no-open`、`--prefix <dir>`、`--dsh-home <dir>`、
`--with-server`、`--desktop`。

### 种子账号（`server/config.json`）

| 账号 | 密码 | 角色 / 部门 |
| --- | --- | --- |
| `boss` | `boss123456` | 管理员 · 管理层 |
| `boss-b` | `boss123456` | 管理员 · 管理层 |
| `director` | `director123` | 总监 · 内容部 |
| `emp-a` / `mingan` | `emp123456` | 员工 · 内容部 |
| `zhangzhang111999` / `quan` | `emp123456` | 员工 · 电商部 |
| `xiaoman` | `emp123456` | 员工 · 设计部 |

`boss` 以外的演示账号只在开发模式首次启动时创建；安装版网关（§2.5）生成的 `config.local.json` 把 `seedUsers` 置空，首次启动只有 `boss`。

首次打开客户端会出现登录遮罩，用公司账号登录；登录后本机拿到一枚网关令牌（`~/.dsh/desk/desk-state.json`），
所有模型请求都经 `desk-gateway-<厂商> → http://127.0.0.1:8790/v1` 代理并按人记账；
模型菜单按厂商分组（DeepSeek / Grok / …），管理员在网关上接入或断开通道后，全员客户端在一个心跳内自动重写路由。

令牌规则：

- 令牌绑定「这次登录的这台电脑」。换电脑登录不会把上一台踢下线；网页管理页登录不签令牌，也不影响桌面端。
- 登出只收回本机令牌；管理员「吊销令牌」/「停用账号」一次收回这个人所有电脑上的令牌，
  对方的模型请求立刻 401，客户端在下一次心跳弹回登录遮罩并说明原因。
- 「个人」工作区一人一座：同一台电脑换人登录，前一个人的「个人」格子会从列表收起
  （目录与会话日志保留，那个人再登录时自动挂回）。

### 服务端管理页

浏览器打开 `http://127.0.0.1:8790/admin`，用管理员 / 总监账号登录（员工不可用）：
网关状态（人数 / 在线 / 有效令牌 / 7 天成本）、公司盘三区统计、模型通道、
知识库查询（同 `company_knowledge`，输入关键词得到「谁 / 何时 / 在哪」）、知识·工具合集。

## 4. 走一遍视频里的流程

1. **登录**：开发机遮罩里输入 `boss / boss123456`（`config.json` 的种子管理员）；安装版没有演示账号，首次打开走引导设置公司名与初始管理员。左下角显示头像、部门、在线状态。
2. **会话**：侧栏「会话」Tab → 团队工作区「新会话」→ 选模型（DeepSeek V4 Pro / Flash、
   接入的 Grok 等）→ 「文件」芯片选本机文件，文件落到 `<工作目录>/_attachments/`，草稿里出现 `@文件名` 芯片 →
   发送，Agent 在本机流式执行（读文件 / 跑命令 / 写交付物）。会话标题由模型自动生成。
3. **任务**：侧栏「任务」Tab → 新建任务（标题、任务内容 / 验收标准）→ 「打开进程」为任务在公司盘
   `projects/inbox/<任务ID>/` 建工作格子并开会话；Agent 通过 `desk:task` 工具更新提交信息 / 日志 / 交付物，
   窗口产物可一键附带到任务卡 → 选审核人「提交验收」进入 `待审` → 审核人「初审通过」进入 `待终审` →
   管理员「终审通过」或「驳回」（驳回后可修改再提交）。四格验收条随状态推进，工作日志记录每一步；
   交付物可直接打开公司盘路径。
4. **设置 → 同事**：每人本周额度、已用金额、7 天账本按人 / 按模型汇总、模型通道接入与断开。
5. **设置 → 人员**：按部门分组，改角色、停用、吊销令牌（对方下一次请求即 401 并被登出）。
6. **设置 → 订阅**：套餐、席位、各通道状态。
7. **四层通道**：团队工作区新会话问「公司里有没有人做过 ×××？谁做的、什么时候、放在哪？」→
   Agent 调 `company_knowledge` 检索，再用 `company_task_read` / `company_memory_read` 读任务卡与手册，
   回答谁 / 何时 / 在哪，并说明知识库分几层、先看哪层。

### 运行证据（`docs/evidence/`）

| 文件 | 对应视频画面 |
| --- | --- |
| `00-home-hero.png` | 首页：valimart harness 字标、个人 / 团队工作区、模型 · 标准模式 · Full access · 文件 |
| `01-login-mask.png` | 公司账号登录遮罩 |
| `02-session-agent-reply.png` | 会话页流式回复（本机 Agent） |
| `03-task-new.png` → `06-task-approved.png` | 新建任务 → 打开进程 → 审核人初审 → 终审通过 |
| `07-model-picker-grouped.png` | 模型菜单按厂商分组（DeepSeek / Grok） |
| `08-settings-subscription.png` | 订阅：套餐 / 席位 / 通道表 |
| `09-settings-colleagues.png` | 同事：每人额度、7 天账本、模型通道 |
| `10-settings-people.png` | 人员：按部门分组、改角色、停用、吊销令牌 |
| `11-task-overview-with-process.png` | 任务概览 + 右侧任务进程列 |
| `12-task-worklog-sessions.png` | 工作日志 + 关联进程（+ 关联 / 撤销） |
| `13-server-admin.png`、`14-server-admin-knowledge-search.png` | 服务端管理页与知识库查询 |
| `15-knowledge-session-toolcalls.png` | Agent 调 `company_knowledge` / `company_task_read` |
| `16-knowledge-session-result.png` | 检索结果：谁做的 / 什么时候 / 放在哪 / 状态 |
| `17-knowledge-session-four-layers.png` | 「企业知识库分四层、先看哪层」 |
| `18-fresh-kernel-install.png` | 全新前缀 + 全新 `DSH_HOME` 用本仓库自带安装器装内核后拉起的客户端（登录、公司盘同步、5 个模型） |

## 5. 测试

```powershell
npm test                    # node --test server/test/*.test.js scripts/test/*.test.mjs
npm run test:e2e            # Playwright：管理页登录 + 桌面流（登录/新会话/建任务/提交验收）
npm run probe:channels      # 有真实 key 才打公网；没有则 skipped
```

服务端覆盖：登录 / 令牌 / 吊销即失效、令牌按登录设备绑定（换电脑 / 管理页不打断桌面端，登出只收本机，吊销收全部）、
模型代理与按人记账限额、公司盘按人隔离、任务四格验收流、通道接入 → 全员目录更新 → 凭据不外泄 → 断开即下架、
知识检索（第四层，含公司技能）、关联进程、管理页可达性、周额度 429、SQLite 往返与 JSON 迁移、
Anthropic Messages 改写与流式转译（本地假上游）。
脚本侧（`scripts/test/`，只用临时目录）：`bootstrap.mjs`（端口顺延、profile 安装、安装版 `preparePackaged` 解压 / 幂等 / 升级、
技能根重定向、CLI 退出码）、`payload.mjs` 纯函数、网关 `init.mjs`（幂等、`config.local.json` 不覆盖、XML 渲染）、备份脚本。
`preparePackaged` 用例需要 `build/payload/kernel.tar`，没有就跳过。
Playwright（`npm run test:e2e`）用本机 Edge：管理页登录、页面流登录 → 新会话 → 建任务 → 提交验收。

内核安装器的验证方式：`node scripts/install-kernel.mjs --prefix <空目录> --dsh-home <空目录>` 真装一遍
（npm 下载 + 16 处补丁全部 `PATCHED`），再用 `launch.mjs --prefix/--dsh-home` 指向它拉起客户端登录；
打完补丁的 9 个内核文件与旧前缀逐字节一致（只有注释里的出处和技能根路径不同）。

## 6. 数据落盘

- 网关：`server/data/gateway.sqlite`（用户 / 会话 / 令牌 / 任务 / 设置 / 通道 / 用量账本）与公司盘 `server/data/drive/`：
  `_shared/`（共享经验、岗位手册、技能 `skills/`，全员只读）、`_office/<账号>/`（个人记忆，仅本人读写）、
  `projects/inbox/<任务ID>/`（任务交付物，相关人可读、提交人可写）。
  旧版 JSON/JSONL 首次启动会迁进 sqlite，旧文件不删。`DESK_GATEWAY_STORE=json` 可回退文件存储。
- 客户端：`~/.dsh/desk/`（`desk-state.json` 登录态与令牌、`drive/` 公司盘本机镜像、
  `produced-index.json` 会话产物索引），会话记录在 `~/.dsh/sessions/`（dsh 原生）。
- 内核：`~/.company-desk/kernel/`（打过补丁的 `@deepseek-ai/dsh`，`.company-desk-kernel.json` 是安装戳记）；
  profile 在 `~/.dsh/profiles/desk/`。删掉这两处再 `npm run setup` 即可重装，不影响会话与登录态。
- 安装版（§2.5）：客户端在 `~/.company-desk/app/`（内核 + Electron userData）、`~/.company-desk/logs/`、`~/.dsh/profiles/desk-app/`，
  登录态与会话仍是上面的 `~/.dsh/desk`、`~/.dsh/sessions`；服务端在 `%ProgramData%\valimart harness Gateway\{data,logs}`，
  配置在 `%ProgramFiles%\valimart harness Gateway\server\config.local.json`。

## 7. 致谢

感谢以下项目与作者，没有它们就没有 valimart harness：

- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**（`@deepseek-ai/dsh`）  
  本工作台的内核：会话、Agent、Web 界面与插件体系都建立在它上面。
- **[TDHarness-coding](https://github.com/398894496-arch/TDHarness-coding)**  
  本仓库由此二次开发而来：公司网关、desk profile、内核补丁与交付工作台的整体方向都受其启发，并在其基础上继续演进。

上游各自保留其许可证与版权。我们在此向 DeepSeek 团队与 TDHarness-coding 的作者致以诚挚感谢。
