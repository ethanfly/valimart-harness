---
name: desk-task-final
description: 终审当前任务卡，decision 必须是 pass 或 reject。
---

用户参数：`$ARGUMENTS`（`<pass|reject> [备注]`）。第一段不是 pass / reject 时先询问。确认后执行 `codex-valimart-desk task-final $ARGUMENTS`，原样转述终审结果。
