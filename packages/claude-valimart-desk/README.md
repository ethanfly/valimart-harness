# valimart claude desk

**valimart claude desk**（惠利玛）：把桌面客户端里走公司网关的登录，装进 [Claude Code](https://code.claude.com/docs/en/plugins/manifest-reference) 插件。

pi 包用状态栏显示「谁登录了」。Claude Code 的状态栏全机只有一条命令，[oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) 的 HUD 会占住它。所以本插件：

| 桌面 / pi | 本插件 |
| --- | --- |
| 公司账号登录 → 会话令牌 + 网关令牌 | `/valimart-desk:desk-login` |
| 状态栏 `valimart: 姓名` | 会话开始时的系统提示，加 `/valimart-desk:desk-status`、`/valimart-desk:desk-whoami` |
| provider `valimart`（OpenAI completions） | 本机 `127.0.0.1` 把 Anthropic `/v1/messages` 转成网关 `/v1/chat/completions` |
| OMC 无关 | 检测到 OMC 就不碰它的 `statusLine`；`/valimart-desk:desk-hud` 印一行，贴到 OMC HUD 末尾 |

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

任务卡走网关同一套 `/api/tasks/:id/submit|review|final`。公司盘镜像仍由桌面客户端或 pi 包同步，本插件不拉盘。

## 测试

```powershell
node --test packages/claude-valimart-desk/test/claude-desk.test.mjs
```

根目录 `npm test` 已带上这个目录。
