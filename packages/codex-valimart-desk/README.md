# valimart codex desk

给 Codex CLI 补上公司网关接入：公司盘本机镜像、企业知识检索、个人 / 共享记忆、任务卡四格。实现参考 Claude Code 与 pi 包，但登录态和设备名独立。

## 安装

开发仓库可直接：

```bash
codex plugin marketplace add packages/codex-valimart-desk
codex plugin add valimart-desk@valimart-harness-codex
```

发布后的 npm 包也是 marketplace。全局安装并注册：

```bash
npm install -g codex-valimart-desk
codex-valimart-desk install
```

新开 Codex 会话后，`desk` MCP 会启动并每 30 秒同步公司盘。首次登录：

```bash
DESK_GATEWAY_PASSWORD=... codex-valimart-desk login [网关URL] [账号]
```

登录态保存在 `~/.codex/valimart-desk.json`（0600），公司盘镜像在 `~/.codex/valimart-drive`。可用 `CODEX_HOME`、`VALIMART_DESK_STATE`、`VALIMART_DRIVE_DIR` 覆盖。

## 工具

- `company_knowledge`：公司手册、共享经验、个人记忆和任务卡检索。
- `company_memory_read/list/write`：公司盘记忆与手册读写。
- `company_drive_sync`：手动同步；MCP 启动后默认自动同步。
- `company_task_*`：任务卡读取、交付物、工作日志、更新、提交、初审和终审。

任务卡默认不强制，也不自动绑定。需要绑定时先运行：

```bash
node packages/codex-valimart-desk/scripts/cli.mjs task <任务ID>
```
