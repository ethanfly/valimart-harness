---
name: desk-task-submit
description: 提交当前任务卡验收；必须先有交付物。
---

用户参数：`$ARGUMENTS`（审核人用户 ID）。参数为空时先调用 `company_tasks` 或 `company_task_read` 确认，再让用户提供审核人 ID；不要猜。有 ID 时执行 `codex-valimart-desk task-submit $ARGUMENTS`，原样转述状态。
