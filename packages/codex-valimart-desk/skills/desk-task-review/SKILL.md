---
name: desk-task-review
description: 初审当前任务卡，decision 必须是 pass 或 reject。
---

用户参数：`$ARGUMENTS`（`<pass|reject> [备注]`）。第一段不是 pass / reject 时先询问。确认后执行 `codex-valimart-desk task-review $ARGUMENTS`，不要替用户改审核结论。
