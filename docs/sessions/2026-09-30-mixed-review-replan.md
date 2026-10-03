# 2026-09-30 Mixed 审核不通过回规划

## 问题

审核结论 `changes_requested` 在任务级返修（`maxRepairRounds`，默认 2）用完后，`#reviewLoop` 直接返回，run 落 `blocked`。审核写的期望 / 实际 / 返修指令只进错误横幅，规划模型看不到，小模型也不会按新计划再做。

## 做法

返修耗尽后不先停。`#replanFromReview` 把最近一轮审核（摘要、未过验收、findings）交给 `planPrompt` 的 `replan.review`，走已有 `#replan` / `applyReplan` 出新 planVersion，再 `executeTaskGraph`，再审。

三处必须一起改，否则新计划是空转：

1. 状态机：`reviewing` 原先不能到 `planning`。
2. `applyReplan` 的 stale 集原先只有失败任务的后继。审核点名的任务自己已是 `executed`，会被原样保留，小模型不会再跑。
3. 返修轮计数是整段 `#reviewLoop` 共用的。新计划落盘后要把 `round` 置回 -1，否则下一轮审核立刻再次判定「返修耗尽」。

次数用 `#reviewReplans` 对上既有 `maxReplans`（默认 1）。用尽、或审核结论是 `blocked`、或审核输出两次非法，仍 `blocked`。

## blocked 之后

同一次运行的规划预算用尽后才会停在 `blocked`。用户点面板「按改进继续」（仍是 resume continue，不另开 rerun）时，`#resumeEntry` 把最近一轮 `changes_requested` 放进 `carryReview`，`#reviewReplans` 归零，再走 `#replanFromReview`。每次继续给一轮规划。审核结论是 `blocked`（无法继续）的恢复仍拒绝。

## 验证

`node --test scripts/test/mixed-review.test.mjs scripts/test/mixed-recovery.test.mjs scripts/test/mixed-panel.test.mjs`：52 pass / 0 fail。`npm run build` 已重打 desk-ui bundle。

未打安装包。`plugins/desk-host/lib/**` 要重启客户端进程才加载。
