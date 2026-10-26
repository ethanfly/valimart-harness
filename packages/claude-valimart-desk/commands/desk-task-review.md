---
description: 初审当前任务卡（pass 或 reject）
argument-hint: "<pass|reject> [备注]"
---

执行：

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" task-review $ARGUMENTS
```

第一段必须是 `pass` 或 `reject`。不要替我改结论。把网关返回的状态告诉我。
