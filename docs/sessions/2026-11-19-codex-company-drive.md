# Codex 公司盘插件

- 新增 `packages/codex-valimart-desk`，复用 Claude / pi 的公司盘协议，但提供 Codex 专属 stdio MCP、登录态、设备名和 SessionStart 上下文。
- 插件 manifest 是 `.codex-plugin/plugin.json`；MCP 在 `.mcp.json`，hook 在 `hooks/hooks.json`，本地 marketplace 清单在 `.agents/plugins/marketplace.json`。
- 登录态写 `~/.codex/valimart-desk.json`（0600），镜像写 `~/.codex/valimart-drive`，可用 `CODEX_HOME`、`VALIMART_DESK_STATE`、`VALIMART_DRIVE_DIR` 覆盖。
- SessionStart 读取 hook 载荷的 `cwd` 写入 `projectDir`，让 `company_task_attach` 在 Codex 里也能解析相对路径。MCP 启动后默认 30 秒后台同步。
- 0.1.1 提供 15 个 `company_*` 工具；新增 `/valimart-desk:desk-*` skills（登录、登出、状态、发现、同步、任务列表 / 绑定 / 三段审核），并用 MCP `resources/read` 提供 Codex custom statusline。已登录 HUD 显示 `valimart 姓名（账号）· 角色 · 公司 · 额度`。任务卡默认不强制、不自动绑定，只有 CLI 绑定后才进入四格。
- Codex 0.170 的自定义 statusline 要先在 `/experimental` 打开 `tui_extensions_statusline`，重启后在 `/statusline` 选择 `valimart desk HUD`；这是宿主当前限制，不是插件可以静默打开的 UI。

## 验证

- 包内 `node --test packages/codex-valimart-desk/test/*.test.mjs`：10 pass（新增 npm 发布布局检查）。
- 临时 `CODEX_HOME` 里执行 `codex plugin marketplace add packages/codex-valimart-desk` 和 `codex plugin add valimart-desk@valimart-harness-codex`：插件安装并 enabled，`codex mcp list` 显示 `desk`。
- 安装缓存里 MCP initialize 返回协议 `2025-06-18`、版本 `0.1.0` 和 instructions；SessionStart hook 正确注入未登录提示并把 cwd 记到 `projectDir`。
- 根 `npm test`：579 项里 565 pass / 11 fail / 3 skip。失败为既有 Linux 环境问题（8 个 mixed 测试文件、npm PATH、voice 路径），新增包没有失败。
- `npm pack` 得到 `codex-valimart-desk-0.1.0.tgz`，23 个文件、19.6 kB，隐藏的 `.agents` / `.codex-plugin` / `.mcp.json` 都在包内。临时 prefix 全局安装后 `codex-valimart-desk install` 成功，插件 enabled 且 MCP `desk` 注册成功。
- release workflow 新增 `npm-codex`；介绍页新增 Codex 导航、卡片、完整 section 和安装步骤。
- 发布提交 `a8225f7` 后，`npm-codex` 发布 `codex-valimart-desk@0.1.0`；tarball integrity 是 `sha512-icLu7Ha8tWlEsXDgDa4Ya44xRAQQL3GIaizI/N7i9/TYN5q+JspdSb8T9TxpFJSUyFp+qzs3SBk2P8pZzh2kRA==`。release 和 pages workflow 都成功。
- npm 包正式可用后，本机 `~/.local` 安装了 npm 0.1.0，并移除仓库 marketplace 后改用 `~/.local/lib/node_modules/codex-valimart-desk`。当前 Codex 会话能发现 `mcp__desk__company_whoami`，调用返回未登录，符合未登录状态。
