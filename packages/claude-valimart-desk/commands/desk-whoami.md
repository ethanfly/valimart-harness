---
description: 只看当前登录的公司用户
---

在插件根目录执行：

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" whoami
```

只转述姓名、账号、角色、公司。未登录就说未登录。
