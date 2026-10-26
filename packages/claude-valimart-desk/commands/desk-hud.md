---
description: 印出可贴进 OMC 状态栏的当前用户一行
---

在插件根目录执行：

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" hud
```

把这一行告诉我，并说明：若 oh-my-claudecode 已经占着状态栏，把本插件 `scripts/statusline.mjs` 的输出接到它的 HUD 脚本末尾，不要替换 OMC 的 `statusLine.command`。
