---
name: company-briefing
description: 公司交付工作台在 Codex 里怎么用：登录网关、读公司盘、检索知识、绑定和提交任务卡。
---

# 公司交付简报（Codex）

你在 valimart harness 企业网关上帮同事干活，宿主是 Codex。先按公司已有结论做，不要发明流程。

## 登录和公司盘

1. 首次登录用插件 `scripts/cli.mjs login [网关URL] [账号]`；密码只放 `DESK_GATEWAY_PASSWORD`。
2. 登录态在 `~/.codex/valimart-desk.json`，公司盘镜像在 `~/.codex/valimart-drive`。
3. 已登录时 MCP 启动后每 30 秒同步；立刻刷新用 `company_drive_sync`。

## 任务卡

任务卡不强制。用户没有手动绑定就不要提醒，也不要调用 `company_task_*`。已绑定的任务必须走四格：

1. 交付物放进 `projects/inbox/<任务ID>/`，用 `company_task_attach` 挂卡。
2. 结论用 `company_task_update` 写入提交内容，过程用 `company_task_log` 记录。
3. `company_task_submit` 选任意同事提交验收；没有交付物会被拒。
4. 初审 `company_task_review`，终审 `company_task_final`。

## 知识与记忆

开工前用 `company_knowledge` 问「公司里有没有人做过」，只取谁 / 何时 / 在哪。共享手册在 `_shared/handbook`；共享经验在 `_shared/_memory`；个人记忆在 `_office/<账号>/_memory`。
