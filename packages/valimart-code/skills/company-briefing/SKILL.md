---
name: company-briefing
description: 公司交付工作台在 valimart code 里怎么用：登录网关、任务卡、四层知识库、模型通道。接到「公司流程 / 怎么交活 / 知识库分几层」类问题时先读本技能。
---

# 公司交付简报（valimart code）

你在 valimart harness 企业网关上帮同事干活，宿主是 valimart code（基于 Qwen Code 的终端客户端），不是 Electron 桌面客户端。先按公司已有结论做，不要发明流程。

## 登录与模型

1. 登录在终端里做：`valimart login`（先找本机 / 局域网网关，没有才手填地址，密码不回显）。valimart 启动时没登录也会先要求登录。
2. 会话里 `/desk-status` 看账号、公司默认模型、本周额度；额度满了网关回 429。
3. `/model` 里是公司网关目录里的模型，公司默认模型排第一。真实密钥只在网关，本机只有网关令牌。
4. 登录失效（401）时让用户 `/quit`，运行 `valimart login`，再 `valimart` 后 `/resume` 接着聊。

## 交付（四格验收）

任务卡不强制。没有手动绑定就按普通会话做，不要提醒用户去挂，也不要自己新建。用户要挂时自己用 `/desk-task <任务ID>` 绑定（Tab 可补全）；绑上之后才走下面的四格。

1. 以已绑定的任务卡为准。口头说做完了不算完成。`company_tasks` 只在用户要看列表时用。
2. 产物放进公司盘 `projects/inbox/<任务ID>/`，用 `company_task_attach` 挂卡；结论写 `company_task_update`；过程记 `company_task_log`。
3. 交活：`company_task_submit`（或用户自己 `/desk-task-submit <审核人账号>`）选审核人（任意同事，不限总监，不能是自己）→ **待审**。没有交付物网关会拒。
4. 初审：`company_task_review` / `/desk-task-review pass|reject`（pass → 待终审，reject → 驳回）。
5. 终审：`company_task_final` / `/desk-task-final pass|reject`（管理员或派单总监）。
6. 驳回后补证据再交同一张卡，不要另开。

## 四层知识库

公司盘镜像在 `~/.valimart/valimart-drive/`（desk MCP 服务每 30 秒同步，也可 `/desk-sync`）。记忆用 `company_memory_write`。

开工前先用 `company_knowledge` 问「公司里有没有人做过」：

1. `_shared/handbook` — 岗位手册（全员只读）
2. `_shared/_memory` — 共享经验（员工只能往 `05-logs` 追加）
3. `_office/<账号>/_memory` — 个人记忆（跟人走）
4. `company_knowledge` — 检索层：只回谁 / 何时 / 在哪 / 一小段上下文，不拷贝别人的会话

技能文件在 `_shared/skills/<名字>/SKILL.md`。
