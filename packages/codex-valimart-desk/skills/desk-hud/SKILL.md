---
name: desk-hud
description: 启用 Codex 底部 valimart 员工信息 HUD。
---

# 启用 valimart HUD

`desk` MCP 已提供 `ui://valimart-desk/footer` statusline 资源。Codex 0.170 需要先启用 experimental 自定义 statusline：

1. 在 TUI 里运行 `/experimental`，打开 **Custom status line**（功能名 `tui_extensions_statusline`），然后重启 Codex。
2. 重开后运行 `/statusline`，选择 **valimart desk HUD**。
3. 已登录时底部显示 `valimart 姓名（账号）· 角色 · 公司 · 额度`；未登录显示 `valimart 未登录`。

不要手动改用户 config 里的 `tui.status_line_provider`，让 Codex 的 `/statusline` 写入。
