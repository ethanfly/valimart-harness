---
description: 把当前任务卡提交验收（须已有交付物，审核人不能是自己）
argument-hint: "<审核人用户ID>"
---

先确认当前任务已绑定、已有交付物，审核人是同事的用户 ID 而不是我自己。然后执行：

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" task-submit $ARGUMENTS
```

参数为空就不要猜审核人，先问我。把网关返回的状态原样告诉我。
