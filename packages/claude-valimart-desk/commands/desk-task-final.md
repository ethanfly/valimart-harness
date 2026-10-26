---
description: 终审当前任务卡（管理员或派单总监）
argument-hint: "<pass|reject> [备注]"
---

执行：

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" task-final $ARGUMENTS
```

第一段必须是 `pass` 或 `reject`。权限不够时原样转述网关错误，不要换接口重试。
