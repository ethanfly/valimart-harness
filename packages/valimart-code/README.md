# valimart code

**valimart code**（惠利玛）：基于 [Qwen Code](https://github.com/QwenLM/qwen-code) 二次开发的公司网关终端客户端（TUI）。界面、Agent、工具、会话都是 Qwen Code 的；登录、模型、公司盘、任务卡换成公司网关。命令名 `valimart`。

功能对标 pi 包 [`pi-valimart-desk`](../pi-valimart-desk)：

| 桌面客户端 / pi 包 | valimart code |
| --- | --- |
| 公司账号登录 → 会话令牌 + 网关令牌 | `valimart login`（先找本机 / 局域网网关，没有才手填，密码不回显）；启动时没登录会先要求登录 |
| 局域网发现网关 | 同一套 UDP 18790 协议，另外探一遍本机 pi / Claude 插件 / 桌面客户端记下的网关地址 |
| provider `valimart`（OpenAI completions） | Qwen Code 的 `modelProviders.openai`：每个公司目录模型一条，`baseUrl` 是网关 `/v1`，密钥走 `envKey` |
| 公司默认模型 / 快速推理模型 | `/model` 列表第一位 + `model.name`；快速推理模型写进 `fastModel` |
| 思考档位 | 网关的 `reasoningEfforts` 映射成 Qwen Code 的 `deepseek-openai` 推理档位，会话里用 `/effort` 调 |
| `company_knowledge` 等 14 个 Agent 工具 | 自带 MCP 服务 `desk`（`/mcp` 可见），与 Claude 插件同一套工具 |
| 公司盘镜像 | `~/.valimart/valimart-drive/`（MCP 服务每 30 秒同步，`/desk-sync` 立刻同步） |
| 任务卡四格 | `/desk-tasks`、`/desk-task`、`/desk-task-new`、`/desk-task-submit`、`/desk-task-review`、`/desk-task-final`（Tab 补全任务卡号、审核人） |
| 状态栏「valimart: 姓名」 | Qwen Code 状态栏：`valimart 姓名 (账号) @公司 · 模型 · 任务 tk-…` |
| TUI 花标 | 启动横幅换成惠利玛花标与 VALIMART 字标，标题 `VALIMART CODE <版本> · Qwen Code` |
| 公司交付简报技能 | `company-briefing`（`~/.valimart/skills/`） |

密钥仍只在网关。本机 `~/.valimart/valimart-desk.json` 只存登录会话令牌和网关令牌，与 pi、Claude 插件的登录态分开。

## 安装

需要 Node.js ≥ 22。安装包挂在 GitHub Release `latest`，介绍页 <https://ethanfly.github.io/valimart-harness/#valimart-code> 有直链。

```powershell
npm install -g https://github.com/ethanfly/valimart-harness/releases/download/latest/valimart-code-0.1.0.tgz
valimart --version
```

也可以先下载 `valimart-code-*.tgz` 再 `npm install -g .\valimart-code-0.1.0.tgz`。不走 npm 自动更新：新版本到发布页下载重装。和本机原版 `qwen` 互不影响（目录、设置、会话都在 `~/.valimart`）。

卸载：`npm uninstall -g valimart-code`。

## 使用

1. 公司网关已在跑（默认 `http://127.0.0.1:8790`）。
2. `valimart login`：选网关 → 公司账号 → 密码。命令行给了的项不再问：`valimart login http://192.168.1.10:8790 emp-a`。
3. `valimart` 进 TUI；`valimart -p "…"` 非交互。其余参数同 Qwen Code（`--resume`、`--yolo`、`mcp`、`extensions` …）。
4. 会话里：
   - `/desk-status`：账号、额度、模型目录、公司盘、绑定的任务卡
   - `/desk-sync`：立刻同步公司盘
   - `/desk-tasks [状态]`、`/desk-task [任务ID|off]`、`/desk-task-new <标题> [@账号]`
   - `/desk-task-submit <审核人账号>`、`/desk-task-review pass|reject [意见]`、`/desk-task-final pass|reject [意见]`
   - `/desk-discover [地址]`、`/desk-login`、`/desk-logout`
   - Agent 工具 `company_*` 由 MCP 服务 `desk` 提供，工具调用照 Qwen Code 的审批模式确认

终端子命令：

```text
valimart login [网关地址] [账号]   登录（非交互：设置 DESK_GATEWAY_URL / DESK_GATEWAY_USER / DESK_GATEWAY_PASSWORD）
valimart logout                     登出
valimart status                     登录态、额度、模型目录、公司盘
valimart discover                   找公司网关
valimart sync                       同步公司盘镜像
```

登录或令牌是启动时注入的：会话里 `/desk-login` 之后要 `/quit` 再 `valimart`（`/resume` 接着聊）。网关回 401 时同样处理。

## 和原版 Qwen Code 的区别

- 只用公司网关登录：`/auth`、Qwen 订阅的 `/logout` `/upgrade`、会装回原版的 `/update`、去 QwenLM 提 issue 的 `/bug` 都关掉；`valimart auth` / `valimart update` 只打印说明。
- 关掉使用统计、遥测、自动更新、models.dev 目录刷新。
- 每次启动按登录态重写 `~/.valimart/system-defaults.json`（Qwen Code 的系统默认设置，优先级最低）。自己的设置写 `~/.valimart/settings.json` 或项目 `.qwen/settings.json`，会盖过它。
- 系统提示第一句改成 Valimart Code；`--help` 里的命令名是 `valimart`。

## 目录

```text
~/.valimart/
  valimart-desk.json     登录态（会话令牌 + 网关令牌）
  valimart-drive/        公司盘镜像
  system-defaults.json   启动器生成的系统默认设置
  settings.json          你自己的 Qwen Code 设置（可选）
  skills/company-briefing/  随包技能（valimart 管理，别手改）
  …                      其余是 Qwen Code 的会话、历史等
```

环境变量：`VALIMART_HOME`（根目录，默认 `~/.valimart`）、`DESK_GATEWAY_URL` / `DESK_GATEWAY_USER` / `DESK_GATEWAY_PASSWORD`（非交互登录）、`VALIMART_DRIVE_SYNC_MS`（公司盘后台同步间隔，0 关掉）。

## 开发

不克隆上游：`pin.json` 锁定 `@qwen-code/qwen-code` 的版本和 integrity，构建时取 npm 包、打锚点补丁、塞进 valimart 自己的模块。和 dsh 内核补丁同一套规矩。

```powershell
npm install                              # 仓库根：esbuild
npm run dist:valimart-code               # → dist/valimart-code-<版本>.tgz（中间产物在 build/valimart-code/package）
node build/valimart-code/package/valimart/valimart.mjs --version
node --test packages/valimart-code/test/*.test.mjs
```

- `lib/`：登录态、网关客户端、发现、公司盘镜像、`company_*` 工具、模型目录映射、系统默认设置、启动器、斜杠命令
- `runtime/`：打进包内 `valimart/` 的入口（`valimart.mjs` 命令、`desk-mcp.mjs`、`session-context.mjs`、`statusline.mjs`、`commands.mjs`）
- `scripts/patches.mjs`：对 Qwen Code 包的锚点补丁（斜杠命令注入、系统提示身份、用法行、命令名）
- `scripts/build.mjs`：取包 → 补丁 → esbuild → npm pack

升级 Qwen Code：改 `pin.json` 的 `version` 与 `integrity`（`npm view @qwen-code/qwen-code@<版本> dist.integrity`），跑构建。锚点对不上会硬失败，按新包重审 `scripts/patches.mjs`，再用新版本冒烟一遍 TUI。
