# 2026-11-05 任务卡改为可选

用户要求：不要每次会话都挂任务卡，不要弹出「没有任务卡」。有绑定就用，没有就当普通会话，绑定只手动。

## 原因

SessionStart / pi `before_agent_start` / desk-host 系统提示 / VS Code 公司上下文，在没有 `currentTaskId` 时也写死「口头完成不算完成，必须 attach → submit」。模型就会去读任务卡，工具返回「没有任务卡」或自己说出来。

## 改动

- 未绑定时提示改为：不要提任务卡，不要要求绑定，不要调用 `company_task_*`。
- 已绑定时仍注入任务目录、卡内容和四格验收。
- `workflowHint(null)` 不再写「用 /desk-task 绑定一张」。
- 验收门槛没动：提交仍然必须先有交付物。

## 验证

`node --test packages/claude-valimart-desk/test/drive-mcp.test.mjs packages/claude-valimart-desk/test/claude-desk.test.mjs`：28 pass。新增「未绑定不要求任务卡」。
