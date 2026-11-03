# 2026-11-03 pi 启动后回车要等一两分钟，顺手修掉旧副本覆盖

## 怎么定位的

`pi --version` 三个入口都只要 0.35s，慢的不是二进制。用 PTY 起真实 pi：

- `--no-extensions`：界面 0.3s 出来，1s 时打的字立刻回显。
- 带全部扩展：界面同样快，但状态栏「盘 714」要到 111s 才出现。
- 探针扩展 `session_start` 里 sleep 8s，再挂一个 `input` 事件：1.7s 回车的 `pingprobe` 到 8.5s 才被处理，`[Extensions]` 资源列表也是这时才出。结论是 pi 把提交的输入排队，等所有 `session_start` 跑完。`!` 命令不排队，所以用 `!` 探测会误判成没卡。

会话 JSONL 对得上：今天 13:42 那次第一条 user 消息比 session 头晚 146s，11-02 晚 284s，10-30 只有 24~32s（那时个人目录还没这么大）。

## 两层原因

1. `packages/pi-valimart-desk/extensions/index.ts` 的 `session_start` 里 `await fetchMe()` 再 `await syncDriveQuiet()`。
2. `DriveMirror` 的 `index` 只在内存里，`sync()` 先推后拉。新进程 index 为空，`_office/ethan/` 555 个文件（59 MB，含一个 14 MB mp4）全部当成改过的逐个 PUT。网关不慢：`/api/auth/me` 0.07s，`/api/drive/snapshot` 0.5s（714 文件）。

同一份内存索引还造成 11-02 交接里标的那个问题：pi 没开期间别处改过的个人记忆，下次开 pi 会被本机旧副本覆盖。用改动前的代码跑「同步 → 远端改 v2 → 新进程再同步」，两个文件都被重传。

## 改了什么

- `extensions/index.ts`：`session_start` 不再 await 网络。网关刷新和首次同步放 `refreshAfterStart` 后台跑，回调前用 `sessionGen`（`session_shutdown` 加一）确认会话没被 `/new`、`/resume` 换掉。pi 文档写明被替换的 `pi` / `ctx` 一用就抛错。
- 同步索引落盘抽到 `scripts/lib/drive-mirror-index.mjs`，pi、`plugins/desk-host`、`packages/vscode` 三份 `DriveMirror` 用 `Object.assign` 挂上。索引写镜像根 `.sync-index.json`，每轮 `reloadIndex()` 以盘上的为准；索引为空时先拉后推；下载走 `writeFileAtomic`。Claude 插件那份是自己的实现，这次没动。
- pi 包 `0.1.11` → `0.1.12`，没发 npm。本机 `~/.pi/agent/settings.json` 的 `packages` 指的是仓库路径，重开 pi 即生效。

## 验证

- `node --test packages/pi-valimart-desk/test/*.test.mjs packages/vscode/test/drive-mirror.test.js packages/claude-valimart-desk/test/*.test.mjs scripts/test/drive-mirror.test.mjs`：61 pass。
- 真实 pi（PTY，真实网关）：资源列表 0.6s，回车立即处理，首次同步 1.2s、0 重传。再跑一次 1.4s。
- 真实网关：先同步（pulled 715、pushed 0），直接 PUT 一个探针文件模拟别的客户端，新 `DriveMirror` 再同步 pulled 1、pushed 0，本地内容等于远端新版本。探针文件随后 DELETE，确认 404。
- `scripts/test/drive-mirror.test.mjs` 的排队测试原来断言「先推后拉」，已改成断言无索引时先拉后推，并确认推送进行中后到的 pull 仍排队。

## 没做

- 没跑全量 `npm test`（10-30 起就有 3 项在 Linux 上过不了，与这次无关）。
- 没 `npm publish` pi 包，没重打桌面端 / vscode 安装包。desk-host 和 vscode 都直接读仓库源码，下次启动生效；发给别人的安装包要重打才带上。
- Claude 插件的 `drive-mirror.mjs` 仍是独立实现，行为和这次对齐，但没合并成同一份。
