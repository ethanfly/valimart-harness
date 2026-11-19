---
name: desk-login
description: 登录 valimart 公司网关；密码只从 DESK_GATEWAY_PASSWORD 环境变量读取。
---

# 登录公司网关

用户请求参数：`$ARGUMENTS`（第一段是网关 URL，第二段是账号）。

1. URL 或账号缺失时，先运行 `codex-valimart-desk discover`，找到多个就列出让用户选择。
2. 密码缺失时告诉用户先在启动 Codex 的终端执行 `export DESK_GATEWAY_PASSWORD=...`，再重开会话或明确说已设置；不要让用户把密码写进对话。
3. 密码已设置时执行 `codex-valimart-desk login $ARGUMENTS`。
4. 原样转述「已登录」、姓名、账号、公司和额度；失败只转述错误，不把密码写进命令或日志。
