# valimart claude desk

**valimart claude desk**（惠利玛）：把桌面客户端里走公司网关的登录，装进 [Claude Code](https://code.claude.com/docs/en/plugins/manifest-reference) 插件。

pi 包用状态栏显示「谁登录了」。Claude Code 的状态栏全机只有一条命令，[oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) 的 HUD 会占住它。所以本插件：

| 桌面 / pi | 本插件 |
| --- | --- |
| 公司账号登录 → 会话令牌 + 网关令牌 | `/valimart-desk:desk-login` |
| 状态栏 `valimart: 姓名` | 会话开始时的系统提示，加 `/valimart-desk:desk-status`、`/valimart-desk:desk-whoami` |
| provider `valimart`（OpenAI completions） | 本机 `127.0.0.1` 把 Anthropic `/v1/messages` 转成网关 `/v1/chat/completions` |
| OMC 无关 | 检测到 OMC 就不碰它的 `statusLine`；`/valimart-desk:desk-hud` 印一行，贴到 OMC HUD 末尾 |
| 公司盘镜像 + `company_*` Agent 工具 | 插件自带 MCP 服务 `desk`：同一套 14 个工具，镜像在 `~/.claude/valimart-drive` |

密钥仍只在网关。本机 `~/.claude/valimart-desk.json` 只存登录会话令牌和网关令牌，和 pi 的 `~/.pi/agent/valimart-desk.json` 分开。

## 安装

Claude Code 里：

```text
/plugin marketplace add E:\orcaWorkspace\company-harness\packages\claude-valimart-desk
```

这个目录本身还没有 marketplace 清单。开发期直接从目录加载：

```powershell
claude --plugin-dir E:\orcaWorkspace\company-harness\packages\claude-valimart-desk
```

装好后会话开始会多一行当前用户。未登录是「valimart 未登录」。

## 登录

1. 公司网关已在跑（默认 `http://127.0.0.1:8790`）。
2. 密码不要写进斜杠命令：

```powershell
$env:DESK_GATEWAY_PASSWORD = "emp123456"
```

3. `/valimart-desk:desk-login http://127.0.0.1:8790 emp-a`
4. `/valimart-desk:desk-status` 看姓名、账号、角色、公司、本周额度。

不带地址时，命令会先找本机和局域网网关（UDP `18790`，与桌面、pi 同一协议）。找到多个就列出来，不猜。

## 让 Claude Code 走公司网关

网关对外是 OpenAI 兼容，Claude Code 讲 Anthropic Messages。本插件在本机转一层，不改网关。

```powershell
node packages\claude-valimart-desk\scripts\cli.mjs serve
```

另一个终端：

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8799"
$env:ANTHROPIC_API_KEY = "valimart-gateway"
$env:ANTHROPIC_MODEL = "<公司默认模型>"
claude
```

`ANTHROPIC_API_KEY` 这个值是占位符。转发进程用登录态里的网关令牌，不读这个环境变量。`serve` 停了地址就失效，不要写进 `~/.claude/settings.json`。

`/valimart-desk:desk-route` 只打印上面这几行。

## 和 oh-my-claudecode 一起用

- 本插件只注册自己的 `SessionStart`，不写 OMC 的 hook，不修改 `settings.json`。
- OMC 已安装时，会话提示会写明「不要替换 statusLine」。
- 想在 OMC 那一行里也看到登录用户：把 `scripts/statusline.mjs` 的输出接到 OMC HUD 脚本末尾。它只读登录态，再附上 Claude Code 从 stdin 给的模型和上下文占用。
- 机器上没有别的状态栏时，才可以把 `statusLine.command` 指到：

```powershell
node E:\orcaWorkspace\company-harness\packages\claude-valimart-desk\scripts\statusline.mjs
```

## 命令

- `/valimart-desk:desk-login [网关URL] [账号]`
- `/valimart-desk:desk-logout`
- `/valimart-desk:desk-status`
- `/valimart-desk:desk-whoami`
- `/valimart-desk:desk-discover`
- `/valimart-desk:desk-route`
- `/valimart-desk:desk-hud`
- `/valimart-desk:desk-tasks`
- `/valimart-desk:desk-task [任务ID]`
- `/valimart-desk:desk-task-submit <审核人用户ID>`
- `/valimart-desk:desk-task-review <pass|reject> [备注]`
- `/valimart-desk:desk-task-final <pass|reject> [备注]`
- `/valimart-desk:desk-sync`

任务卡走网关同一套 `/api/tasks/:id/submit|review|final`。

## 公司盘与 Agent 工具（MCP）

插件根目录的 `.mcp.json` 注册了 stdio MCP 服务 `desk`（`scripts/mcp-server.mjs`），启用插件就会跟着每个 Claude Code 会话启动。`/mcp` 里能看到 `plugin:valimart-desk:desk`，工具全名形如 `mcp__plugin_valimart-desk_desk__company_memory_write`。

| 工具 | 用途 |
| --- | --- |
| `company_whoami` | 当前账号、公司、本周额度 |
| `company_knowledge` | 第四层检索：「公司里有没有人做过」，只给谁 / 何时 / 在哪 |
| `company_tasks`、`company_task_read` | 列任务卡、读一张（不传 ID 读绑定的那张） |
| `company_task_log`、`company_task_update` | 记工作日志、写提交内容 / 任务内容 |
| `company_task_attach` | 本机文件挂成交付物（单个 ≤ 50MB，建议绝对路径） |
| `company_task_submit`、`company_task_review`、`company_task_final` | 提交验收 → 初审 → 终审 |
| `company_memory_write`、`company_memory_read`、`company_memory_list` | 个人 / 共享记忆与岗位手册 |
| `company_drive_sync` | 立即同步镜像 |

- 镜像目录 `~/.claude/valimart-drive`（跟 `CLAUDE_CONFIG_DIR` 走），和 pi、桌面端的镜像各自独立；登录后 MCP 服务先同步一次，之后每 30 秒一次（`VALIMART_DRIVE_SYNC_MS=0` 关掉）。
- 个人区 `_office/<账号>/` 的本地修改会回推网关。同步索引落盘在镜像根 `.sync-index.json`：会话重启后仍分得清「本地新改」和「本机旧副本」，旧副本不会盖掉别处的新版本；索引丢失时先拉后推，以远端为准。
- 会话开始时 `SessionStart` 把身份、镜像分区、任务卡规则和当前绑定任务卡写进上下文（只读本机文件，不走网络）。
- 网关拒收令牌（401）时登录态标记为需重新登录，后台同步停下，直到重新 `/valimart-desk:desk-login`。

## 测试

```powershell
node --test packages/claude-valimart-desk/test/claude-desk.test.mjs
```

根目录 `npm test` 已带上这个目录。
