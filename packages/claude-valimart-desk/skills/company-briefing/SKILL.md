---
name: company-briefing
description: 公司交付工作台在 Claude Code 里怎么用：登录网关、看当前用户、任务卡、四层知识库。接到「公司流程 / 怎么交活 / 我是谁登录的 / 知识库分几层」类问题时先读本技能。
---

# 公司交付简报（Claude Code）

你在 valimart harness 企业网关上帮同事干活，宿主是 Claude Code，不是 Electron 桌面客户端，也不是 pi。先按公司已有结论做，不要发明流程。

## 登录和当前用户

1. `/valimart-desk:desk-login`：先在本机 / 局域网找网关；命令行给了地址就用那个。密码不要写进 slash 命令，脚本用环境变量 `DESK_GATEWAY_PASSWORD`。
2. `/valimart-desk:desk-status` 看当前登录用户、公司和本周额度。界面底部的 valimart 行也显示同一个人；没登录就显示「未登录」。
3. 真实密钥只在网关。本机 `~/.claude/valimart-desk.json` 只存登录会话令牌和网关令牌。
4. 模型经本机 `127.0.0.1` 转发到公司网关。`/valimart-desk:desk-route` 只打印本会话要 export 的变量，不改 `~/.claude/settings.json`。

## 和 oh-my-claudecode 并存

本插件只挂自己的 `SessionStart`。不写 OMC 的 hooks，不安装、不替换状态栏命令。OMC 的 HUD 继续占状态栏时，当前用户改由 `/valimart-desk:desk-hud` 印出一行，贴到 OMC 状态栏脚本末尾即可，两边同时可见。

## 交付（四格验收）

1. 以任务卡为准。口头说做完了不算完成。`/valimart-desk:desk-task` 绑定；`company_tasks` 看状态。
2. 产物放进公司盘 `projects/inbox/<任务ID>/`，用 `company_task_attach` 挂卡；结论写 `company_task_update`；过程记 `company_task_log`。
3. 交活：`company_task_submit`（或 `/valimart-desk:desk-task-submit`）选审核人（任意同事，不限总监，不能是自己）→ **待审**。没有交付物网关会拒。
4. 初审：`company_task_review` / `/valimart-desk:desk-task-review`（pass → 待终审，reject → 驳回）。
5. 终审：`company_task_final` / `/valimart-desk:desk-task-final`（管理员或派单总监）。
6. 驳回后补证据再交同一张卡，不要另开。

## 四层知识库

开工前先用 `company_knowledge` 问「公司里有没有人做过」：

1. `_shared/handbook` — 岗位手册（全员只读）
2. `_shared/_memory` — 共享经验（员工只能往 `05-logs` 追加）
3. `_office/<账号>/_memory` — 个人记忆（跟人走）
4. `company_knowledge` — 检索层：只回谁 / 何时 / 在哪 / 一小段上下文，不拷贝别人的会话

技能文件在 `_shared/skills/<名字>/SKILL.md`。公司盘镜像不在本插件里同步，要看文件用桌面客户端或 pi 包。
