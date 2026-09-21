<p align="center">
  <img src="desktop/build/icon.png" width="128" height="128" alt="valimart harness">
</p>

<h1 align="center">valimart harness</h1>
<p align="center"><strong>企业交付工作台</strong> · 公司账号登录 · 模型密钥只在服务端 · 任务必须有交付物</p>

<p align="center">
  <a href="https://github.com/ethanfly/valimart-harness"><img alt="GitHub" src="https://img.shields.io/badge/github-ethanfly%2Fvalimart-harness-181717?logo=github"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white">
  <img alt="Kernel" src="https://img.shields.io/badge/dsh-0.1.5--rc.2-1484fc">
</p>

本仓库是公司自己的桌面客户端 + 公司网关。内核是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`@deepseek-ai/dsh@0.1.5-rc.2`），由本仓库安装并打公司补丁，**不必再克隆上游**。二次开发起点是 [TDHarness-coding](https://github.com/398894496-arch/TDHarness-coding)。

> 接手看 [`docs/HANDOFF.md`](docs/HANDOFF.md)。过程记录在 [`docs/sessions/`](docs/sessions/)。

---

## 它是什么

员工在本机跑 Agent（读文件、跑命令、写交付物），所有模型请求经 **公司网关** 代理：密钥不出服务端，按人记账、限额，任务卡和公司盘落在网关上。

| 给谁 | 用什么 |
| --- | --- |
| 员工 | 桌面客户端（会话 / 任务 / 设置） |
| 管理员 / 总监 | 同一客户端 + 管理页 `http://<网关>:8790/admin` |
| 公司服务器 | 网关服务（Windows 安装包，或树莓派 Docker） |
| 只要 CLI | [pi](https://github.com/earendil-works/pi) + `pi install npm:pi-valimart-desk`（登录公司网关、选模型） |

**产品能力一览**

- **会话**：个人 / 团队工作区，模型按厂商分组，`@` 引用本机文件，Agent 本机流式执行。
- **Mixed 混合模式**：规划 / 实施 / 审核三个角色，宿主跑验收；可停止、恢复、重试。
- **任务卡**：`待初审 → 待终审 → 通过 / 退回`。口头完成不算完成，必须挂交付物。
- **公司知识库（四层）**：岗位手册 → 共享经验 → 个人记忆 → 检索层 `company_knowledge`（只回答谁 / 何时 / 在哪）。
- **公司网关**：账号与设备令牌、模型通道、周额度（跨上游合计一条「总额度」）、公司盘、管理页。
- **生图**：`image_generate` / `image_edit` 走网关，短名 `gpt` / `qwen` / `grok`。
- **pi CLI**：不装桌面客户端时，`pi install npm:pi-valimart-desk` 走同一套公司网关。

```
  员工客户端 (Electron / 浏览器 :3470)
           │  登录令牌 · 会话 · 任务 · 公司盘镜像
           ▼
  公司网关 (Node :8790)  ← 密钥、账本、任务卡、公司盘只在这里
           │
           ▼
  上游模型 / 生图 / 搜索（DeepSeek · Grok · ChatGPT · 通义 · AnySearch …）
```

---

## 项目构造

```
company-harness/                 # npm 包名仍是 company-desk
├─ server/                       # 公司网关（零第三方运行时依赖，Node 内置 sqlite）
│  ├─ config.json                # 默认配置：种子账号、额度、上游、通道
│  ├─ src/                       # 登录 / 令牌 / LLM 代理 / 账本 / 任务 / 公司盘
│  ├─ skills/                    # 随包技能，播种到公司盘 _shared/skills
│  └─ test/                      # 网关端到端
├─ plugins/
│  ├─ desk-host/                 # 宿主：登录态、模型路由、公司盘镜像、任务工具、Mixed
│  ├─ desk-ui/                   # 浏览器外壳：侧栏、会话、任务、设置、登录遮罩
│  └─ desk-image/                # 生图：经网关 /v1/images/*
├─ profile/cordis.patch.yml      # dsh "desk" profile：关官方外壳、插公司插件
├─ desktop/                      # Electron 壳（安装版客户端）
│  └─ build/icon.png             # 应用图标（README / 安装包 / 快捷方式）
├─ installer/                    # Windows 网关 NSIS + WinSW 服务定义
├─ deploy/raspberry-pi/          # 树莓派 / 飞牛 OS ARM64 Docker 部署
├─ scripts/
│  ├─ kernel/                    # 内核 pin、补丁、发现/试打/发布
│  ├─ lib/bootstrap.mjs          # 开发启动与安装版首次解压共用
│  ├─ launch.mjs                 # npm run dev / client / desktop
│  └─ build-*.mjs                # 安装包流水线
├─ e2e/                          # Playwright
├─ packages/pi-valimart-desk/    # pi-valimart-desk：公司网关登录 / 模型 / 知识 / 任务卡
└─ docs/                         # 交接、会话记录、设计与计划
```

品牌图（界面用，不要改路径）：

| 文件 | 用途 |
| --- | --- |
| `plugins/desk-ui/src/client/assets/valimart-mark.png` | 花标：侧栏收起、标题栏、favicon |
| `plugins/desk-ui/src/client/assets/valimart-wordmark.png` | 字标 VALIMART：侧栏展开、登录遮罩、空态 |
| `desktop/build/icon.png` / `icon.ico` | 应用图标、安装包、本 README |

换 logo：替换前两张 PNG → `npm run build` 并重启客户端；安装包 / 快捷方式再跑 `npm run icon` 后重新 `dist:*`。

---

## 使用方法

分四条路：**开发机跑源码**、**员工装客户端**、**公司装网关**、**pi CLI 装公司包**。

### 1. 开发机（源码）

需要 Node.js ≥ 22（建议 25.x）。Windows PowerShell 5.1 多条命令用 `;`，不要用 `&&`。

```powershell
cd E:\orcaWorkspace\company-harness   # 仓库根
npm install                           # esbuild / playwright / mdast
npm run setup                         # 装锁定内核到 ~/.company-desk/kernel 并打补丁
npm run dev                           # 网关 :8790 + 客户端 :3470 + 桌面窗口
```

| 命令 | 做什么 |
| --- | --- |
| `npm run server` | 只起网关 `http://127.0.0.1:8790`（管理页 `/admin`） |
| `npm run client` | 只起内核 Web，浏览器打开 `http://127.0.0.1:3470` |
| `npm run desktop` | 客户端 + 窗口（不起网关） |
| `npm run build` | 打包 `desk-ui`（`launch.mjs` 发现源码更新也会自动重打） |
| `npm test` | `node --test` 服务端 + 脚本 |
| `npm run test:e2e` | Playwright |

开发种子账号（仅源码 `config.json`；安装版网关不播种演示用户）：

| 账号 | 密码 | 角色 |
| --- | --- | --- |
| `boss` | `boss123456` | 管理员 |
| `director` | `director123` | 总监 |
| `emp-a` | `emp123456` | 员工 |

登录后模型请求走网关。安装版与开发版可同机：安装版 profile `desk-app` + `~/.company-desk/app/kernel`；开发版 `desk` + `~/.company-desk/kernel`。登录态 / 公司盘 / 会话共用 `~/.dsh/desk` 与 `~/.dsh/sessions`。

**走一遍**

1. 登录遮罩输入 `boss / boss123456`。
2. 「会话」→ 团队工作区新会话 → 选模型 → 「文件」芯片带上本机文件 → 发送。
3. 需要多角色时：设置里为规划 / 实施 / 审核各选一个公司目录模型 → 会话打开 Mixed → 照常发送。
4. 「任务」→ 新建 → 「打开进程」→ Agent 写交付物并提交验收 → 审核人初审 / 终审。
5. 问「公司里有没有人做过 ×××？」→ Agent 走 `company_knowledge`。
6. 管理页 `http://127.0.0.1:8790/admin`：通道、额度、知识库查询、内核 / 客户端发布。

### 2. 员工电脑（安装包，不需要 Node）

先装内核（Mac 包也从 `~/.company-desk/kernel` 取）：

```powershell
npm run setup
```

**Windows 客户端**

```powershell
npm --prefix desktop install
npm run dist:client          # → dist/valimart-harness-Setup-<ver>.exe
```

员工双击安装（按用户，无需管理员）→ 桌面快捷方式 **valimart harness** → 登录页填公司网关，例如：

- 本机网关：`http://127.0.0.1:8790`
- 树莓派网关：`http://10.56.41.60:8790`

打包时预置网关：`$env:DESK_GATEWAY_URL = "http://gw.company.local:8790"` 再跑对应的 `dist:client` / `dist:client:mac`。

装到 `%LOCALAPPDATA%\Programs\valimart-harness`。首次启动解压内核到 `~/.company-desk/app`（约十几秒），之后秒开。包未签名，SmartScreen 选「更多信息 → 仍要运行」。

**macOS Intel 客户端（可在 Windows 构建机直出）**

不要用 electron-builder `--mac`（Windows 上会直接拒绝，而且 7z 会毁掉 `.app` 的符号链接和可执行位）。走公司脚本：

```powershell
npm run dist:client:mac
# 或预置网关：
npm run dist:client:mac -- --gateway http://10.56.41.60:8790
```

产物：`dist/valimart-harness-<installerVersion>-mac-x64.zip`，内含 `valimart harness.app`。

默认：Electron 44.1.1、Node 22.23.2、darwin-x64，门槛 **macOS 13.0+**。脚本会从 Windows 内核注入 Darwin 原生包（含 node-pty prebuilds、`node-addon-system-darwin-x64`），并校验 zip / 权限 / Mach-O。

员工在 **Mac 上解压**（不要在 Windows 上解再压），把 `.app` **拖进 `/Applications`** 再打开。未签名时右键 → 打开，或：

```bash
xattr -dr com.apple.quarantine "/Applications/valimart harness.app"
```

只验已有 zip：`node scripts/build-mac-client.mjs --verify-only dist/xxx-mac-x64.zip`。老系统（macOS 11/12）另打 `--electron 30.x --node 20.x`。Mac 版关闭自更新，升级用整包替换。工程细节见 [`docs/sessions/2026-09-09-mac客户端打包.md`](docs/sessions/2026-09-09-mac客户端打包.md)。

### 3. 公司网关

**Windows 服务器**

```powershell
npm run dist:gateway         # → dist/valimart-harness-Gateway-Setup-<ver>.exe
```

管理员安装 → Windows 服务 `TheDivaGateway`（自启）→ 管理页 `http://<主机>:8790/admin` 走首次引导（公司名 + 初始管理员，无演示数据）。数据在 `%ProgramData%\valimart harness Gateway\data`，卸载保留。

**树莓派 / 飞牛 OS ARM64**

代码挂进 Docker，改 JS **不用重建镜像**：

```powershell
scp -r server ethanfly@10.56.41.60:/vol1/1000/harness/valimart-gateway/
ssh ethanfly@10.56.41.60 "cd /vol1/1000/harness/valimart-gateway/deploy && sudo docker compose restart"
```

详情：`deploy/raspberry-pi/`。生产网关当前跑在 `http://10.56.41.60:8790`。

**上游密钥（只放服务端）**

优先在管理页或客户端「设置 → 同事 → 模型通道」接入（写入 `gateway.sqlite`）。也可以：

```powershell
$env:DEEPSEEK_API_KEY = "sk-..."
$env:ANYSEARCH_API_KEY = "as_sk-..."
```

或 `server/config.local.json`（不入库）。没有真实 key 时目录里仍有 `mock-echo` 供离线演示。

个人 Google One / AI Pro / Ultra 请在「加入订阅」选 **Antigravity**（OAuth 与 CPA / CLIProxyAPI 同一套 Cloud Code 客户端，回调 `localhost:51121`）。旧 **Google One / Gemini CLI** 通道只留给 Code Assist 企业账号。不要把 AI Studio API key 当成订阅填。

### 4. pi CLI（不装桌面客户端）

公司网关已经在跑、只想用 [pi](https://github.com/earendil-works/pi) 写代码时，装本仓库的 **`pi-valimart-desk`** 包：登录、公司模型目录、知识检索、任务卡只读。Electron 壳 / Mixed / 公司盘镜像仍只在桌面客户端。

包带扩展，装上后会改 `settings.json` 的 `extensions`，并以完整系统权限运行。先看源码再装。

**1. 先装 pi CLI**（Node.js ≥ 22）

```powershell
npm install -g @earendil-works/pi-coding-agent
pi --version
```

**2. 再装公司包**

已发 npm [`pi-valimart-desk@0.1.2`](https://www.npmjs.com/package/pi-valimart-desk)。本机（写入 `~/.pi/agent/settings.json`，所有项目都能用）：

```powershell
pi install npm:pi-valimart-desk
pi list
```

只给当前仓库（写入 `.pi/settings.json`，同事拉代码后会自动装）：

```powershell
pi install -l npm:pi-valimart-desk
```

不写入 settings、只试一次：

```powershell
pi -e npm:pi-valimart-desk
```

开发改包时用仓库路径（必须是 `packages/pi-valimart-desk` 这一层，不要指仓库根）：

```powershell
cd E:\orcaWorkspace\company-harness
pi install .\packages\pi-valimart-desk
```

`pi list` 里应出现 `pi-valimart-desk`。卸掉：`pi remove npm:pi-valimart-desk`（项目级加 `-l`）。

**3. 登录公司网关并选模型**

先确保网关在跑（本机 `http://127.0.0.1:8790`，或局域网地址）。然后：

```powershell
pi
```

TUI 标题为 **valimart pi desk**（惠利玛花标）。在 pi 里：

1. `/desk-discover` 找局域网网关，或 `/desk-login http://127.0.0.1:8790 <账号>`（也可 `/login valimart`）。密码不要写进 slash；脚本用 `DESK_GATEWAY_PASSWORD`。
2. `/model` 选 `valimart/<公司目录里的聊天模型>`。
3. `/desk-status` 看账号和额度。知识检索用 `company_knowledge`，任务卡用 `company_tasks`。

登录态在 `~/.pi/agent/valimart-desk.json`（只有会话令牌和网关令牌，没有上游密钥）。完整说明：[`packages/pi-valimart-desk/README.md`](packages/pi-valimart-desk/README.md)。

---

## 日常命令

| 场景 | 命令 |
| --- | --- |
| 开发全套 | `npm run dev` |
| 只改 UI | `npm run build` 后重启客户端 |
| 检查内核补丁 | `npm run kernel:check` |
| 换内核版本 | 改 `scripts/kernel/pin.json` → `npm run kernel:prepare -- --version <ver>` |
| 打两个 Windows 安装包 | `npm run dist` |
| 打 macOS Intel 客户端 | `npm run dist:client:mac` → `dist/valimart-harness-<ver>-mac-x64.zip` |
| 发布客户端给员工 | `npm run client:publish -- --gateway <url> --user <管理员> --password <密码> --from dist/valimart-harness-Setup-0.1.0.exe` |
| 备份网关数据 | `npm run backup -- --data-dir <数据目录> --out backup.zip` |
| 给本机 pi 装公司包 | `pi install npm:pi-valimart-desk` 然后 `pi list` |

`launch.mjs` 常用参数：`--port`、`--gateway`、`--no-open`、`--prefix`、`--dsh-home`。

---

## 数据落在哪

| 位置 | 内容 |
| --- | --- |
| 网关 `server/data/`（或 `DESK_GATEWAY_DATA`） | `gateway.sqlite`（用户 / 令牌 / 任务 / 通道 / 账本）+ 公司盘 `drive/` |
| 公司盘 `_shared/` | 岗位手册、共享经验、技能（全员只读；员工只能追加日志层） |
| 公司盘 `_office/<账号>/` | 个人记忆，跟人走 |
| 公司盘 `projects/inbox/<任务ID>/` | 任务卡、工作日志、交付物 |
| 客户端 `~/.dsh/desk/` | 登录令牌、公司盘镜像 |
| 客户端 `~/.dsh/sessions/` | 会话记录 |
| pi 包 `~/.pi/agent/valimart-desk.json` | pi CLI 的登录会话令牌 + 网关令牌 |
| 开发内核 `~/.company-desk/kernel/` | 打过补丁的 dsh |
| 安装版客户端 `~/.company-desk/app/` | 解压的内核与 Electron userData |

`server/config.local.json`、`server/data/`、树莓派 `subscriptions.yaml` **不入库**。

令牌绑的是「这次登录的这台电脑」。换电脑不会踢上一台；管理页登录不签桌面令牌。管理员「吊销 / 停用」收回该人全部设备。

---

## 测试

```powershell
npm test                 # 服务端 + scripts
npm run test:e2e         # Playwright（本机 Edge）
npm run probe:channels   # 有真实 key 才打公网
```

覆盖：登录与设备令牌、模型代理与周额度、任务四格验收、公司盘隔离、通道接入/断开、知识检索、Mixed 恢复、安装版 bootstrap、备份。

界面截图证据：[`docs/evidence/`](docs/evidence/)。

---

## 进阶（打包 / 内核 / HTTPS）

构建机网络打不开 GitHub 时，脚本默认走 npmmirror。`dist:gateway` 需要先成功打过一次 `dist:client`（复用 electron-builder 的 `makensis`），或自装 NSIS 3 并设 `MAKENSIS`。`dist:client:mac` 不依赖 electron-builder，缓存落在 `build/mac-cache/`。

对外 HTTPS：网关本身仍是 HTTP，前面加 Caddy / Nginx，把 `publicUrl` 和客户端网关地址改成 `https://…`，不要把 8790 暴露到公网。流式对话要求反代不缓冲（Nginx `proxy_buffering off`）。

内核更新走公司门禁：员工机不直连 npm。管理员 `kernel:discover` → `kernel:prepare` → 管理页发布；已登录员工**下次启动**才切换。客户端整包更新是另一条通道（Setup.exe + buildId）。

补丁表、安装目录、静默参数、计划任务备份等细节仍以旧章节为准，见 git 历史或：

- 安装包设计：[`docs/superpowers/specs/2026-09-04-installers-design.md`](docs/superpowers/specs/2026-09-04-installers-design.md)
- Mixed 计划：[`docs/superpowers/plans/2026-09-09-mixed-mode-implementation.md`](docs/superpowers/plans/2026-09-09-mixed-mode-implementation.md)
- 树莓派：[`deploy/raspberry-pi/README.md`](deploy/raspberry-pi/README.md)

---

## 致谢

- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** — 会话、Agent、Web 与插件体系。
- **[TDHarness-coding](https://github.com/398894496-arch/TDHarness-coding)** — 公司网关与 desk profile 的二次开发起点。

上游各自保留其许可证与版权。
