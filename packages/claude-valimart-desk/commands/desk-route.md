---
description: 打印本会话把 Claude Code 指到公司网关的环境变量
---

在插件根目录执行：

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" route
```

把 `export` 那几行原样给我，让我自己贴进当前终端。不要写入 `~/.claude/settings.json`，也不要改已有的 `statusLine`。未登录就先提示登录。
