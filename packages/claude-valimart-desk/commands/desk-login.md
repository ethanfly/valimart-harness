---
description: 登录公司网关（先找局域网网关；密码只从环境变量读）
argument-hint: "[网关URL] [账号]"
---

用本插件的命令行登录公司网关，不要把密码写进对话。

参数：`$ARGUMENTS`（第一段是网关 URL，第二段是账号；都可以空）。

在插件根目录执行（根目录由会话上下文里的 `CLAUDE_PLUGIN_ROOT` 给出，没有就用本仓库 `packages/claude-valimart-desk`）：

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" login $ARGUMENTS
```

规则：

- 密码只认 `DESK_GATEWAY_PASSWORD`。参数里多出来的第三段也不是密码，脚本会丢弃。
- 没给地址时脚本先发现本机和局域网网关；发现多个就列出，不要猜。
- 把脚本印出的「当前用户」原样告诉我。失败就原样转述，不要重试把密码写进命令。
