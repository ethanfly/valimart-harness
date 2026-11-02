---
description: 立即同步公司盘本机镜像（回推个人记忆 + 拉取可见文件）
---

调用本插件 MCP 服务 desk 的 `company_drive_sync` 工具，把结果（远端文件数、下载、回推、本机镜像目录）告诉我。

工具不可用时（`/mcp` 里 desk 没连上），改为执行：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" sync
```

未登录就说明要先 `/valimart-desk:desk-login`。不要打印令牌。
