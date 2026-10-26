---
description: 列出我能看到的公司任务卡
---

在插件根目录执行：

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" tasks
```

用列表转述任务 id、标题、状态。未登录就提示先登录。
