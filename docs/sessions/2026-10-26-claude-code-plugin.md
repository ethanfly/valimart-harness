# 2026-10-26 Claude Code 插件 valimart-desk

给 Claude Code 加一个对标 `packages/pi-valimart-desk` 的公司网关插件，目录 `packages/claude-valimart-desk`。

## 做了什么

- 登录态放 `~/.claude/valimart-desk.json`（可用 `VALIMART_DESK_STATE` 改位置），只存会话令牌和网关令牌，和 pi 的状态文件分开。
- 斜杠命令：`desk-login` / `logout` / `status` / `whoami` / `discover` / `route` / `hud` / `tasks` / `task` / `task-submit` / `task-review` / `task-final`。密码只认 `DESK_GATEWAY_PASSWORD`。
- 当前用户出现在三处：`SessionStart` 的 `additionalContext` 和 `systemMessage`、`/desk-status`、状态栏脚本 `scripts/statusline.mjs`。
- 本机桥 `cli.mjs serve` 听 `127.0.0.1:8799`，把 Anthropic `/v1/messages`（含 tool_use）转成网关 `/v1/chat/completions`。占位环境变量 `ANTHROPIC_API_KEY=valimart-gateway` 不是密钥。
- OMC：只检测 `installed_plugins.json` 和插件缓存里的 `oh-my-claudecode`。检测到就不建议替换 `statusLine`。hook 只有自己的 `SessionStart`。

## 验证

`node --test packages/claude-valimart-desk/test/claude-desk.test.mjs`：**13 pass / 0 fail**。覆盖用户行不含令牌、工具回合互转、流式事件、OMC 已装时不认领状态栏、未登录 401、假网关往返时 Authorization 用的是网关令牌而不是占位符。

已装到本机：`claude plugin marketplace add` 这个目录，再 `claude plugin install valimart-desk@valimart-harness --scope user`。`claude plugin list` 显示 enabled，读的就是仓库目录。登录态从 pi 的 `valimart-desk.json` 同步（不新签令牌）；网关 `GET /api/auth/me` 200，用户冯一宸 / ethan / admin，公司 ValimartHarness，默认模型 grok-4.7。本机没有 OMC，状态栏原为空，已把 `~/.claude/settings.json` 的 `statusLine.command` 指到 `scripts/statusline.mjs`。现有 `ANTHROPIC_BASE_URL=http://127.0.0.1:3425` 没改。

未跑全量 `npm test`。

## 未做

- 发布流程不打包这个目录（marketplace 只为本机安装）。
- 公司盘镜像没搬过来。
- 思考档位没有从网关目录映射到 Anthropic `thinking`。
