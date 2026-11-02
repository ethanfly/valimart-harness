# 2026-11-02 Claude 插件带上公司盘（0.2.0）

把 pi 包里的公司盘镜像和 `company_*` Agent 工具搬进 `packages/claude-valimart-desk`。Claude Code 没有 pi 那种进程内扩展，工具改由插件自带的 MCP 服务提供。

## 做了什么

- `.mcp.json`（插件根）注册 stdio 服务 `desk`：`node ${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs`。协议按行分隔 JSON-RPC 2.0，支持 initialize / ping / tools/list / tools/call。initialize 的 `instructions` 写工具怎么配合用。stdout 只写协议消息，日志走 stderr。stdin 关闭就退出。
- `lib/tools.mjs`：14 个工具，逐个从 pi 的 `extensions/index.ts`、`drive-tools.ts` 移植。只读工具带 `readOnlyHint`。处理器返回的 `details` 只在单测里用，协议层发出去前剥掉。
- 从 pi 搬来、改动很小的模块：`drive-paths.mjs`、`people-options.mjs`、`task-workflow.mjs`（提示文案换成 `/valimart-desk:desk-task`）、`drive-runtime.mjs`（日志改走 stderr；只回写 `lastSyncAt`；401 标需重新登录）、`gateway.mjs`（补 `makeApiClient` / `patchTask` / `listPeople` / `addDeliverables`）、`state.mjs`（`driveDir`、`lastSyncAt`）。
- `drive-mirror.mjs` 有实质改动：同步索引落盘到 `.sync-index.json`；每轮按盘上的重新加载；索引为空先拉后推；下载用原子写入。
- `lib/company-prompt.mjs`：pi 的 `companyDrivePrompt` 原样搬来，由 `SessionStart` 注入。
- `cli.mjs sync`、`status` 多一行镜像目录、`commands/desk-sync.md`。版本号 0.1.0 → 0.2.0（plugin / marketplace / package 三处）。README 加「公司盘与 Agent 工具」一节。

## 为什么改同步顺序

pi 和 desk-host 的 `DriveMirror` 把「上次同步的 sha」放在内存里，每轮先回推个人区、再拉取。进程刚启动时索引是空的，个人区每个文件都算「本地新改」，全推一遍。如果远端在别的电脑或别的客户端改过，本机旧副本就把新版本盖掉了。Claude Code 每个会话都要重启 MCP 进程，本机还同时有 pi、桌面端、Claude 三份互相独立的镜像，碰上的概率不低。

用 pi 原版和新版各跑一遍「同步 → 远端改成 v2 → 新实例再同步」：

```text
pi 原版: 回推 1 次；远端现在是「v1」
claude 新版: 回推 0 次；远端现在是「v2 另一台电脑写的」
```

pi 和 desk-host 这次没动，等确认后再修。

## 验证

- `node --test packages/claude-valimart-desk/test/*.test.mjs`：27 pass / 0 fail，其中新文件 `test/drive-mcp.test.mjs` 14 项。镜像层用进程内假网关；MCP 层拉起真实的服务进程，接 HTTP mock 网关。
- 全量 `npm test`（`TMPDIR` 设在仓库外）：673 项，667 pass / 3 fail / 3 skip。3 项失败和 10-30 一样，都是 Windows 专属断言：mixed-scheduler 写锁路径规范化、npm-cli 在服务 PATH 里找不到 `sh`、voice-runtime 空格路径转短路径。这 3 个测试文件都不引用本插件。
- `claude plugin details valimart-desk@valimart-harness`：MCP servers (1) desk。`claude mcp list`：`plugin:valimart-desk:desk ✔ Connected`。
- 对测试机网关 `192.168.100.71:8790` 真实调用（本机已登录态，ethan / admin）：`company_whoami` 149ms。第一次 `company_drive_sync` 远端 713 个文件，下载 698 个，回推 0，28s（另外 15 个是 `mcp list` 健康检查起的进程下好的，进程被杀后没留下临时文件，走了无索引的先拉后推）。第二次 0 下载 / 0 回推，409ms。镜像 60MB，索引 713 条。

## 没做

- pi 包、desk-host 的同类问题。
- 现有斜杠命令里 PowerShell 写法的 `$env:CLAUDE_PLUGIN_ROOT`（Linux/mac 上找不到脚本）。
- 插件还是不进 release 产物。
