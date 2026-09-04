# 会话记录 · 2026-09-04 内核门禁更新

对应设计 `docs/superpowers/specs/2026-09-04-kernel-auto-update-design.md`，
计划 `docs/superpowers/plans/2026-09-04-kernel-auto-update.md`（6 个任务）。本文件记文档与管理页收尾（Task 6）。

## 做了什么（Task 6）

- `GET /api/admin/kernel` 总监可读（员工仍 403）；`POST` prepare / publish / rollback 仍要管理员
- 管理页 `/admin`「服务器」后加「内核」：当前版本或随包保底 pin、已存表、发现表、`discoverError`；管理员有试打补丁 / 发布 / 回滚，总监只读
- README §2.5 后写 `kernel:discover` / `prepare` / `publish`、管理页、员工下次启动、未 prepare 通过不升 0.1.2
- HANDOFF：自动更新 = 内核有门禁；壳没有
- spec 状态改为已实现；§3.3 启动顺序改为 **守卫 → 解随包 → applyPendingKernel**（pending 覆盖 bundled；解压不删 `kernel-next`）

## 验收

- `npm test` 全绿（含总监 GET 200 / 员工 GET 403 / 总监 POST publish 403）
- 本轮**没有**把 `scripts/kernel/pin.json` 升到 0.1.2
