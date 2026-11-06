---
name: company
description: 按 valimart harness 公司网关约定开工（登录、知识库、任务卡）
---

先确认已登录公司网关（`/desk-status`）。密钥只在网关，不要问我要 API key。

开工前用 `company_knowledge` 查有没有人做过类似的。任务卡不强制：只有已经用 `/desk-task` 手动绑定后，才挂交付物 → 写提交内容 → `company_task_submit` 选审核人。没绑定不要提醒用户去挂，也不要自己新建。初审 `company_task_review`，终审 `company_task_final`。
