---
description: 查看当前登录用户、公司和本周额度
---

在插件根目录执行：

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" status
```

把「当前用户」那几行原样告诉我。未登录就说明要先 `/valimart-desk:desk-login`。不要打印令牌。
