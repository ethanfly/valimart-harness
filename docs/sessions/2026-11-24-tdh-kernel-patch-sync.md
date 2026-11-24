# 2026-11-24 同步上游 TDHarness 内核补丁（C8 v2 / C3 v2 / C2b）

## 起因

用户要求「更新 tdh 核心」：本仓基于上游 TDHarness（本地克隆 `~/Work/TDHarness`）二次开发，要把上游内核补丁的修复同步过来。

## 对比

- `git fetch` 后上游 main = `36d6f27`（2026-11-18）；`patches/` 最后改动是 `01cf9d5`（2026-10-11）。上游 `kernel.yml` 仍锁 0.2.1-alpha.1，本仓 `pin.json` 是 0.2.2-rc.5，比上游新，所以不升内核版本，只看补丁差集。
- 上游有、本仓没有的 mark 共 12 个。逐个对 0.2.2-rc.5 源码核对后：
  - 移植：`company-glob-missing-root-v2`（C8）、`company-fs-unc-acl-v2`（C3）、`company-sandbox-linux-cifs-v1`（C2b）。
  - 不移植：`company-sandbox-local-drive-v2`（C2，PowerShell 5.1 + Add-Type 探测，B3 门槛要求先在目标机预检）；另外 7 个是上游 desk 自身的界面 / 启动问题，逐条核对见下节。
  - 用常量定义 mark 的几条也核对过了：`company-skill-custom-trusted-v1` 本仓已有；`company-assistant-markdown-slot-v1` 本仓已有，而且上游那份是 `maxKernel 0.1.6`。

## 未移植补丁逐条核对（0.2.2-rc.5）

- `settings-namespace-compat-v1/v2`：在内核前缀（含 profilePlugins）里 `rg settingsNamespace`，除 `dsh-settings` 本身外没有其他文件引用；本仓 `plugins/`、`packages/`、`profile/` 也没有。上游服务的 dsh-better-sidebar、ego-browser 不在前缀里。0.2.2 的 `dsh-settings` 导出行仍是 `export { SettingsConflictError, SettingsForms, SettingsForms as default, redactSecrets };`，锚点还在，只是没有调用方。
- `subagent-tool-once-v1`：`dsh-tool-subagent` 的 `const mount = (subagentProvider) => {` 锚点仍在（L360）。但官方 `dsh-web-app/cordis.patch.yml` 的「agent plane moves behind agent presets」段把 base 层的 `tool-subagent-control`、`tool-subagent`、`tool-subagent-fork` 都设成了 `disabled: true`，每个会话只挂预设里那一份。上游会重复，是因为它的 `desk/pack/mac/presets/cordis/agent.cordis.yml` 自带预设，宿主又挂了一份。本仓 `profile/cordis.patch.yml` 和 `~/.dsh/profiles/desk` 都没有 subagent 相关条目。
- `loopback-web-auth-v1`：上游的场景是壳写死不带令牌的地址。本仓 `scripts/launch.mjs` 用 `createDshWebUrlWatcher` / `resolveDshWebUrl` 拿到带令牌的地址；`desktop/main.js` 在 `did-finish-load` 时检测到「authentication required」就改用 `tokenUrl` 重开。不移植可以保留 loopback 上的 cookie 鉴权。
- `models-header-v1`、`models-key-discover-v1`、`models-key-unlocked-v1`：`profile/cordis.patch.yml` 禁用了 `ui-settings-models` 与 `llm-deepseek`。0.2.2 `dsh-client-ui-settings-models/lib/client.js` 里只有 `settings.models.footer` 还在；`const keyLocked = keyState?.writable === false;`、`operations.storeCredential(keyRef, keyValue)`、`children: t("title")` 都是 0 次命中。desk-ui 也没有用 `settings.models.*` 槽。
- `win-junction-mark-v5`：上游注释说明它只是给 AppHost exe 留的 `win-junction-failed` 字符串，防止整包 RestoreProduct。本仓 `desktop/`、`scripts/`、`installer/`、`plugins/` 都没有 AppHost / RestoreProduct；`dsh-app-boot` 的 junction 继续由本仓 v3/v4 处理。
- 0.2.2 上的前提核对：
  - C8：`runRipgrep` 作用域里有 `argv`、`stdout`、`stderr`（带 `.text` / `.lossy`）；glob 与 grep 的 argv 都以 `parts.push("--", input.path)` 收尾，满足「`--` 恰在倒数第二位」的判定。原始锚点与上游 `from` 一致。
  - C3：`copyFileDacl(absolutePath, tempPath)` 只在 `existingDestination` 时调用，临时文件与目标同目录，正常写入两端类型一致。
  - C2b：`import { spawnSync } from "node:child_process";\n` 与 `\tasync confine(argv, policy, signal) {\n` 各命中 1 次；policy 字段就是 `mode` / `workspaceRoot`；探测放在 `canonicalPath` 与两条 runner 路径之前。

## 改动

- `scripts/kernel/patches.mjs`：
  - 新增并导出 `companyRgPathMissing(stderr, argv)`、`companyFsIsUnc(p)`、`companyAssertLinuxWorkspace(policy, platform, statfs)`，从上游 `patches/lib/*.js` 原样移植，`toString()` 嵌进内核。
  - C3、C8 的 mark 升到 v2，补丁对象加 `supersedes` 记录 v1 的 append 与编辑。
  - 在 sandbox-local 补丁之后新增 C2b 补丁对象（import 编辑 + confine 进门检查，sync / async 两个变体）。
  - 新增 `revertSuperseded()`，并接进 `applyKernelPatches`：旧 mark 在位时先精确退回官方源码再打新版；形状不对就报 `legacy-patch`，文件不动。上游的做法是硬拒、要求重装；本仓改成自动迁移，开发前缀和构建机缓存前缀不用重装。
- `scripts/test/kernel-patches.test.mjs`：新增 8 个用例，矩阵移植自上游 `prove-search-errors.js`、`prove-privilege-patches.js`、`prove-linux-cifs.js`，打完补丁的片段在 vm 里跑。真实 rg 用例找不到 rg 时 skip（可用 `DESK_TEST_RG` 指定）；`DESK_TEST_CIFS_ROOT` 可指向真 CIFS 挂载做额外断言。
- `scripts/kernel/pin.json` 的 `$comment`、`docs/HANDOFF.md` 顶部段。

## 验证

- 演练：把 `~/.company-desk/kernel` 整个拷到临时目录跑 `applyKernelPatches`：BEFORE 缺 3 个 mark → `PATCHED` 3 处（fs-local、fs-search 两处带 `migrated v1→v2`）→ AFTER 不缺 → 二次运行 applied 0。逐文件 diff 只动了目标位置。
- 实打：`npm run setup`，输出「新打 3 处，已有 22 处」，三文件与演练逐字节一致；`npm run kernel:check` 报 22 处补丁齐全（原 21）。v1 版三文件临时备份在会话 scratchpad，需要时可用 `install-kernel.mjs --force` 重装代替。
- 真实模块：三个包 `import()` 正常；`LocalSandboxProvider.prototype.confine.call(...)`：本地工作区 → 返回 bwrap argv；不存在的根 → `COMPANY_WORKSPACE_PROBE_FAILED`；read-only → 不探测。
- `node --test scripts/test/kernel-patches.test.mjs` 27/27（真实 rg 用例实跑，未 skip）。
- `npm test` 715 项 709 pass / 3 fail / 3 skip；3 个失败是既有的 mixed-scheduler 写锁、npm-cli PATH、voice-runtime 空格路径，3 个 skip 是 Windows 专属用例。

## 待办

- 提交后走 CI release 重打 `dist:client`，再到管理页发布。
- C2 drive-v2 等 B3 预检（目标机 PowerShell 5.1 + Add-Type 是否可用）后再议。
