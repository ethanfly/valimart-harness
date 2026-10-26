---
description: 绑定或查看当前任务卡
argument-hint: "[任务ID]"
---

在插件根目录执行：

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" task $ARGUMENTS
```

没给任务 ID 时，脚本会印出当前绑定。把结果告诉我，不要另造一张卡。
