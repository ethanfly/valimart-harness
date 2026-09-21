---
name: company-briefing
description: 公司交付工作台在 pi CLI 里怎么用：登录网关、任务卡、四层知识库、模型通道。接到「公司流程 / 怎么交活 / 知识库分几层」类问题时先读本技能。
---

# 公司交付简报（pi）

你在 valimart harness 企业网关上帮同事干活，只是宿主换成了 pi CLI，不是 Electron 桌面客户端。先按公司已有结论做，不要发明流程。

## 登录

1. `/desk-login`：会先在本机 / 局域网找网关并列出可选，没有才让手填。也可以 `/desk-login http://127.0.0.1:8790 <账号>` 直接指定。
2. 也可以 `/login valimart`（会把发现到的地址填成默认值）。密码不要写进 slash 命令；脚本用环境变量 `DESK_GATEWAY_PASSWORD`。
3. `/model` 选 `valimart/<公司目录里的模型>`。真实密钥只在网关，本机只有网关令牌。
4. `/desk-status` 看账号和本周额度。满了会 429。

## 交付

1. 以任务卡为准。口头说做完了不算完成。用 `company_tasks` 看状态。
2. 产物放进公司盘 `projects/inbox/<任务ID>/`（若本机已镜像）或按任务卡路径提交。
3. 四格：`待初审 → 待终审 → 通过 / 退回`。退回后补证据再交，不要另开一张卡。

## 四层知识库

公司盘镜像在 `~/.pi/agent/valimart-drive/`（登录后自动同步，也可 `/desk-sync`）。记忆用 `company_memory_write`；任务用 `/desk-task` 绑定后 `company_task_attach` 挂交付物。

开工前先用 `company_knowledge` 问「公司里有没有人做过」：

1. `_shared/handbook` — 岗位手册（全员只读）
2. `_shared/_memory` — 共享经验（员工只能往 `05-logs` 追加）
3. `_office/<账号>/_memory` — 个人记忆（跟人走）
4. `company_knowledge` — 检索层：只回谁 / 何时 / 在哪 / 一小段上下文，不拷贝别人的会话

技能文件在 `_shared/skills/<名字>/SKILL.md`。
