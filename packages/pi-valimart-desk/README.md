# pi-valimart-desk

**valimart pi desk**（惠利玛）：把桌面客户端里走公司网关的能力装进 [pi](https://github.com/earendil-works/pi) CLI。

启动 TUI 时用惠利玛花标替换 pi 默认 logo，窗口标题显示 `valimart pi desk`。

桌面端有登录遮罩、模型路由、知识检索、任务卡；裸 pi 没有。本包装上：

| 桌面客户端 | pi 包 |
| --- | --- |
| 公司账号登录 → 会话令牌 + 网关令牌 | `/desk-login`（先自动发现网关，没有才手填）或 `/login valimart` |
| 局域网发现网关 | `/desk-discover`（只记下地址，不登录） |
| llm-pi-ai 路由 `desk-gateway`（`/v1` + 网关令牌） | provider `valimart`（OpenAI completions） |
| `company_knowledge` | 同名工具 |
| 公司盘镜像 | `~/.pi/agent/valimart-drive/`（登录后同步，`/desk-sync`） |
| 个人/共享记忆 | `company_memory_write` / `read` / `list` |
| 任务卡 | `company_tasks`、`company_task_read` / `log` / `update` / `attach`；`/desk-task` 绑定 |
| 公司交付简报技能 | `company-briefing` |

**不上桌面壳**：Electron 标题栏、右侧栏、公司盘镜像、Mixed 三角色仍只在客户端。

密钥仍只在网关。本机 `~/.pi/agent/valimart-desk.json` 只存登录会话令牌和网关令牌。

## 安装

扩展以完整系统权限运行，会改 `settings.json` 的 `extensions`。先看源码再装。

### 0. 先有 pi

需要 Node.js ≥ 22。

```powershell
npm install -g @earendil-works/pi-coding-agent
pi --version
```

### 1. 从 npm 装（推荐）

已发布 [`pi-valimart-desk@0.1.7`](https://www.npmjs.com/package/pi-valimart-desk)。写入 `~/.pi/agent/settings.json`，之后在任何目录开 `pi` 都会加载：

```powershell
pi install npm:pi-valimart-desk
pi list
```

只给当前仓库（写入 `.pi/settings.json`）：

```powershell
pi install -l npm:pi-valimart-desk
```

不写入 settings、只试一次：

```powershell
pi -e npm:pi-valimart-desk
```

### 2. 从本仓库路径装（开发）

路径必须是 `packages/pi-valimart-desk` 这一层，不要对仓库根 `pi install`。

```powershell
cd E:\orcaWorkspace\company-harness
pi install .\packages\pi-valimart-desk
```

### 卸掉

```powershell
pi remove npm:pi-valimart-desk             # 本机 npm 安装
pi remove -l npm:pi-valimart-desk          # 项目级 npm 安装
pi remove .\packages\pi-valimart-desk      # 本机路径安装
```

## 使用

1. 公司网关已在跑（默认 `http://127.0.0.1:8790`）。
2. 开 `pi`。标题应是 **valimart pi desk**。
3. `/desk-login` 或 `/login valimart`。会先在本机 / 局域网找网关并列出可选，没有才让手填；命令行给了地址就不打扰。密码不要写进 slash 命令。
4. `/model` 选 `valimart/<目录里的聊天模型>`。思考强度用 **Shift+Tab** 循环（跟桌面端同一套网关档位：DeepSeek 是 off/high/max，Grok 是 off/low/high，GPT 是 off/low/medium/high）。
5. 需要时 `/desk-status`、`company_knowledge`、`company_tasks`。

非交互登录（密码不进 slash 历史）：

```powershell
$env:DESK_GATEWAY_URL = "http://127.0.0.1:8790"
$env:DESK_GATEWAY_USER = "emp-a"
$env:DESK_GATEWAY_PASSWORD = "emp123456"
pi
# 然后 /desk-login
```

命令：

- `/desk-login [网关URL] [账号]`（不带地址时先自动发现）
- `/desk-logout`
- `/desk-status`
- `/desk-discover`
- `/desk-sync` 同步公司盘
- `/desk-tasks` 查看任务卡列表并可选绑定
- `/desk-task [任务ID]` 绑定 / 查看当前卡
- `/desk-task-new` 交互式新建（标题、内容、指派人列表）

环境变量：`DESK_GATEWAY_URL`、`DESK_GATEWAY_USER`、`DESK_GATEWAY_PASSWORD`、`PI_AGENT_DIR` / `PI_CODING_AGENT_DIR`（状态文件目录，默认 `~/.pi/agent`）。
