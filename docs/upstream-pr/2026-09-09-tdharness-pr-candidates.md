# company-harness → TDHarness-coding 上游 PR 候选筛选报告

> 2026-09-09 · 整理人：ethan + agent · **只整理，不提交 PR**
> 目标仓库：<https://github.com/398894496-arch/TDHarness-coding>（公开，MIT；DeepSeek Harness 官方仓不收外部 PR，这里是唯一落点）
> 本报告口径：从 company-harness（55 个已提交 commit + 工作区未提交改动）相对 TDHarness-coding 基线的全部增量中，筛出**符合上游收录范围、质量达标、值得回贡献**的改动（精华），并明确剔除上游不收或方向相反的部分（糟粕）。

---

## 0. 结论摘要

- 两仓同源：上游 2026-09-03 发布时从公司产品的补丁器蒸馏（其补丁注释仍写 `see scripts/p-product-base/...`），pin 停在 `0.1.1-rc.2`；本仓已演进到 `0.1.3-alpha.2`，补丁锚点全部干净命中（prepare 实测）。
- 共享的 11 个代码 mark + 3 类预设 mark 内容**逐行一致**（已 diff 验证：fs-unc-replace、glob-missing-root、session-smbfs、goal-resume、sandbox 等均无内容差）。**真正的增量在「版本演进 + 工具链 + 3 个新 mark」上。**
- 值得提 PR 的精华共 **5 项**（P0×3 / P1×2），其中 3 项直接回应上游 BUGS.md 已挂出的认领缺口（C5、间接 C7）；**2 个新 mark** 需按规则登记 BUGS.md。
- 糟粕（不要上游化）共 **6 类**，原因多为 scope 不符或方向相反（尤其预设类补丁与 C4 方向冲突）。
- 另有 **3 条情报**适合去上游 Discussions 补评论（非代码 PR），**3 个上游坑**（C2/C6/C8）本仓也没解，如实列出不装成成果。
- 证据：本仓 `node --test scripts/test/*.test.mjs` = **246 测 / 245 过 / 1 跳 / 0 败**（2026-09-09 复跑）。

---

## 1. 筛选口径（上游自己定的规则，逐条对照）

来自 TDHarness-coding 的 CONTRIBUTING.md / BUGS.md / docs/HACKING.md：

1. 收录范围：内核锚点补丁、补丁工具、行为证明脚本（必须打出新的 `*_OK=1` 行，光 grep mark 不算）、文档。**不收**：公司登录/网关/Tailscale/Caddy/SMB 业务内容、整文件 vendor 上游源码、对活 prefix 打补丁。
2. 新 mark 必须唯一 `company-…-vN` 且在 BUGS.md 登记（「claim」或「patched」表）。
3. 流程：fork → 开 Task issue（标题带 C# id）→ PR；CI 三 job（unc 矩阵 / scan / patches）全绿。
4. 格式：路径与脚本名纯 ASCII；PR 前必跑 `prove-scan.sh`（SCAN_OK=1）、`prove-unc.js`（UNC_PROVE_OK=1）；动补丁则 `prove-patches.js`（PATCH_PROVE_OK=1）。
5. 禁发办公室 IP / 密钥 / 花名册 / 活 node_modules。

**推论**：本仓的 server/ 网关、plugins/desk-*、desktop/、installer/、发布通道等全部产品功能天然在 scope 外，不参与候选；候选只可能产自 `scripts/kernel/`、`scripts/lib/`（内核相关部分）、`scripts/test/`（内核相关部分）。

---

## 2. 精华：PR 候选清单（按优先级）

### P0-1 认领 C5：内核升版 dry-run 工具 + 多版本锚点（variants）机制 ⭐ 最高价值

**上游缺口（BUGS.md C5 原文）**：升版闸门是「锚点不唯一即硬失败」，但没有一个脚本能把更新版 dsh 装进一次性前缀、逐 mark 打印哪些补丁还活着。Done when：`prove-bump` 在现 pin 上绿，对新版本逐 mark 报 `PATCH_FAIL=anchor-not-unique|…`，且不写活 prefix。

**本仓已有资产**（完成度约 80%，需剥离公司部分）：

| 资产 | 位置 | 说明 |
|---|---|---|
| variants 多版本锚点 | `scripts/kernel/patches.mjs` `applyEdit/editVariants` | 一条编辑并列多版本源码锚点，恰好命中一条才套用；`goal-resume`、`win-junction-v3`、`smbfs import` 已带 0.1.1/0.1.2/0.1.3 双版本变体。上游 patcher 无此机制（grep 实证） |
| prepare 打版流水线 | `scripts/lib/kernel-prepare.mjs` | 版本号安全校验（拒 `../\`）→ `assertPublishedOnNpm` 挡「GitHub 有 tag、npm 没包」的半成品发布（0.1.5-alpha.1 实证踩过 ETARGET）→ 临时前缀装版 → 全量打补丁 + `missingPatches` 复核 → staging rename，**失败不留半成品** |
| 版本发现 | `scripts/lib/kernel-update.mjs` | GitHub `dsh-v*` tag 发现 + 自实现 semver 过滤（alpha<rc<正式） |
| 行为测试 | `scripts/test/kernel-patches.test.mjs`（9KB）、`kernel-update.test.mjs`（24KB） | 0.1.1 与 0.1.2 两套源码 fixture 双绿；正合上游「行为证明而非 grep」的验收观 |
| 预设双布局解析 | `patches.mjs` `presetCandidates/resolvePresetRel` | 0.1.2+ 预设文件从 `config/agent-presets/` 挪进 `node_modules/@deepseek-ai/dsh-agent-presets/presets/`，上游 patcher 只认老路径——**没有这个，上游升 pin 后 3 条预设补丁会全灭** |

**上游化形态**：新增 `scripts/prove-bump.js`（上游点名的文件名/ASCII ✓）：`node scripts/prove-bump.js 0.1.3-alpha.2` → 装到 mkdtemp 临时前缀 → 打补丁 → 逐 mark 打印 OK/`PATCH_FAIL=…` → `BUMP_PROVE_OK=1`。patcher 移植 `variants` 支持（**保留上游已有的 `--only <mark>` 与 `refuseLivePrefix`，只加不减**）。随 PR 附 0.1.2/0.1.3 锚点变体与 BUGS.md C5 标绿。
**剥离项**：discover 的网关 `/api/kernel/current`、publish/rollback HTTP（公司发布通道）不进 PR。
**工作量**：约 1–1.5 天（抽取 + 英文化 + CI 矩阵）。

### P0-2 新 mark：`company-session-events-alias-v1`（dsh-session 兼容 getter）

**问题**：dsh 0.1.2 删了 `Session.events`，社区预设（梁神 tool-bootstrap）仍读 `session.events.length`，第一轮 assemble 就 TypeError，UI 显示 UNKNOWN。
**本仓补丁**（f22337a 引入）：给 Session 加 `get events() { return this.snapshotEvents(); }`，锚点 `eventAt(seq)` 方法。
**通用性**：任何在 0.1.2+ 上用社区预设的用户都踩；与公司业务零耦合。
**上游化形态**：mark 移植进 `apply-kernel-patches.js` + BUGS.md「patched」表登记 + 最小 fixture 行为证明（断言 getter 输出 === `snapshotEvents()`）。
**依赖关系（要如实写进 issue）**：上游 pin 0.1.1-rc.2 的 dsh-session 还有 events，此补丁**只在 0.1.2+ 有意义**——应先于/随 P0-1 的 variants 机制落地，或等上游升 pin。建议与 P0-1 同 issue 不同 PR。
**工作量**：约 0.5 天。

### P0-3 新 mark：会话锁跨平台 `company-session-lock-v2` + 解压补可执行位 ⚠️ 进行中（WIP）

**问题 A**：0.1.3 的 POSIX 会话写锁改用 `fs-ext`（NAN 原生模块，安装时要 node-gyp 现场编译）。后果：① Windows 装内核编不过无用模块；② macOS 客户端在 Windows 构建机上打包，编不出 darwin 的 `fs_ext.node`，且 NAN 是 ABI 绑定找不到预编译产物。
**本仓方案**（`scripts/lib/kernel-native.mjs`，144 行）：POSIX 优先加载编译好的 fs-ext，缺失时改用 **koffi（NAPI，跨平台 ABI 稳定）直绑 libc `flock(2)`**；语义严格对齐上游（非阻塞 `LOCK_EX|LOCK_NB`，竞争报 EAGAIN → 上游抛 `SessionAlreadyOwnedError`；释放靠关 fd）。Windows 侧 `gypfile:false` 跳过 fs-ext 编译（fs-ext@2.1.1 版本不符会硬失败重审）。
**问题 B**：Windows 打出的 kernel.tar 文件全 0644 → macOS/Linux 解压后 `node-pty` 的 spawn-helper 与 `rg` 缺 +x，直接 EACCES。
**本仓方案**：`bootstrap.mjs` `chmodKernelExecutables()`（解压后按清单补可执行位，已接入首启与内核更新两条路径）。
**通用性**：所有「跨平台分发 dsh 内核 / 无编译环境安装」的用户。
**状态**：**未提交**（在当前工作区，v2 +141 行 + kernel-native.test.mjs 扩 94 行）。行动顺序：先在本仓提交并实机验证 mac 客户端 → 再上游化。上游化时决定并入 `apply-kernel-patches.js` 还是保持独立脚本（本仓是旁路通道，不计入 16 处 mark）。
**对应上游**：与 P5（mac App Translocation）同属「跨平台能跑」主题，可在 Task issue 里引用。
**工作量**：本仓收尾 0.5–1 天 + 上游化 0.5 天。

### P1-4 新 mark：`company-assistant-markdown-slot-v1`（聊天 UI 渲染插槽）

**内容**（a6adcb9 引入，5 个 edit，`dsh-client-ui-chat/lib/client.js`）：给官方聊天 UI 注册会话级插槽 `conversation.assistant.markdown`，插件可接管助手消息的 Markdown 渲染，未接管时 fallback 到官方 `MarkdownText`。
**价值**：功能型增强（非 bugfix）——目前官方聊天 UI 没有给插件留渲染扩展点；上游 HACKING.md 有 CLIENT Slot 分层概念，方向相合。
**风险**：上游 scope 是「内核补丁树」，是否愿收 UI 扩展点补丁**不确定**；且本仓动机是 desk-ui 私有需求（实现本身通用、有 fallback）。
**行动**：先开 Task issue 讨论 scope（附补丁形态说明），被认可再提 PR。不要直接砸 PR。
**工作量**：讨论 + 0.5 天。

### P1-5 Node 跨平台安装/检查器（install-kernel.mjs 上游化）

**本仓资产**（`scripts/install-kernel.mjs` + `scripts/kernel/locate.mjs`）：
- 单脚本跨 Win/macOS/Linux（上游要 setup.sh + setup.ps1 双脚本）；
- `refuseLivePrefix` 守卫比上游**多两条**：`~/.npm-global`、当前 node 自己的安装树（上游只有 `~/.local` / `~/dsh-node-rc8` / `%APPDATA%/npm`）；
- 幂等补缺（缺什么补什么）+ `--check` 只读核验（版本 == pin、18 条 mark 齐全、插件版本对，退出码 0/1）——相当于 prove-patches 的强化版；
- 装完写戳记 `.company-desk-kernel.json`；兼容复用旧 `~/.tdh-coding-prefix`。

**上游化形态（二选一，建议 B 更可能被收）**：
- A. 新增 `scripts/setup.mjs`（Node 版 setup + check）；
- B. 小 diff：把多出来的两条守卫移植进上游 `setup.sh/setup.ps1` + patcher 的 refuseLivePrefix。
**工作量**：A 约 1 天；B 约 0.5 天。

---

## 3. 糟粕：明确不上游化的部分（及原因）

| 类别 | 代表 | 不上游的原因 |
|---|---|---|
| 预设补丁：技能根钉公司盘镜像 | `company-preset-skills-v2`（standard 预设指向 `~/.dsh/desk/drive/_shared/skills`） | 上游 BUGS.md **C4 正是要「coding setup 别再钉公司技能根」**——方向相反，提过去等于添乱 |
| 预设补丁：`.company-root` 指令标记 / `company-think` 预设 | `company-preset-instr-root-v1` 的 company 部分 | 公司盘/公司预设概念，solo overlay 无此物（同属 C4 残留） |
| 公司网关全部 | `server/`（LLM 代理、OAuth 订阅、任务卡、公司盘、AnySearch key 下发、mixed-mode、model-resolver） | CONTRIBUTING 明示「Company login、Tailscale、Caddy、SMB chairs：wrong tree」 |
| 公司插件与桌面壳 | `plugins/desk-*`、`desktop/`、`installer/`、图标流水线 | 产品层，非内核补丁树 scope |
| 内核/客户端发布通道 | `update.mjs publish`、网关 `/api/admin/kernel/*`、`applyPendingKernel` 回滚链路 | 依赖公司网关登录态与 HTTP 目录，上游没有服务端 |
| 公司自有代码的 bug 修复 | drive-mirror 墓碑 Set 误用（76dab8b）、llm-proxy 断连取消等 | 修的是公司插件自有代码，非 dsh 内核，无可移植物 |

> 说明：「糟粕」= 对上游而言，不等于对本仓是坏的。其中多数是公司产品的正当功能，只是上游不收。

## 4. 不适合代码 PR、但值得做的非代码贡献

1. **0.1.5-alpha.1 npm 发布不完整（ETARGET）**：GitHub 有 tag 但 `dsh-fs-local@^0.1.5-alpha.1` 等子包没上 npm，装不了。→ 在上游 Discussions 对应发布帖评论提醒（先搜重），并在 TDH 的 C5 issue 里留作「prepare 必须查 npm 可查性」的实证依据（本仓 `assertPublishedOnNpm` 就是干这个的）。
2. **`uiWorkspace` 服务改名**（0.1.2-rc.1 起 `ctx.workspaces` → `uiWorkspace`，社区插件 `startSession` 全灭；本仓修在 desk-ui，非内核补丁）：→ 查上游 Discussions 有无对应帖，补评论；TDH docs 可加一行「0.1.2 适配注意」。
3. **`dsh web` launch token**（0.1.2+ 裸 `/` 401，需从 stdout 解析 `dsh web: …?token=`）：本仓 `scripts/lib/dsh-web-url.mjs` 是通用启动器解析器 → 同上，情报型贡献。

## 5. 如实清单：上游还开着、本仓也没解的坑

| 上游 id | 状态 | 说明 |
|---|---|---|
| C2 映射网络盘/SUBST 检测 | **未解** | 本仓与上游一样只有 grant 失败后的诊断文案（`companyGrantError`），没有授权前的映射盘探测器。不要包装成成果 |
| C6 secret scan 太窄 | **未解** | 本仓连 `prove-scan` 都没有（grep 实证），无东西可贡献 |
| C8 rg stderr 矩阵 | **未解** | 本仓 matcher 与上游逐字一致（含中文「系统找不到指定的文件」），未做收紧矩阵 |
| C7 junction 集成证明 | **部分可解** | 本仓 kernel-patches.test.mjs 已对两版 ensureSymlink fixture 做行为测试，但没有真实 `mklink` 集成脚本；可作为 P0-1 的附属品考虑（temp 目录真建 junction） |

## 6. 建议行动顺序

1. **先在 TDHarness-coding 开 Task issue 认领 C5**（标题带 C5；附计划：prove-bump.js + variants + 0.1.2/0.1.3 锚点 + CI）。
2. PR-1（P0-1）→ 落地后立即 PR-2（P0-2，同 issue 引关联）。
3. 本仓提交 WIP 的 kernel-native v2 + chmod 并实机验证 mac → PR-3（P0-3）。
4. 开 issue 讨论 UI slot scope → 认可后 PR-4（P1-4）。
5. PR-5（P1-5，建议走「守卫移植」小 diff 路线）。
6. 顺手做第 4 节的 3 条 Discussions 评论（半小时，零风险）。

**每个 PR 出门前自查**：fork 仓库而非推 main；英文撰写；脚本/路径纯 ASCII；`prove-scan.sh` / `prove-unc.js` / `prove-patches.js` 三绿；新 mark 唯一且登记 BUGS.md；不带任何公司 IP/域名（git.ethan.team）/账号/密钥；`SEE` 注释路径改成上游相对路径。

## 7. 附录 A：mark 对照总表（本仓 16 处 + 旁路 1 处 vs 上游）

| mark | 上游 0.1.1-rc.2 | 本仓 0.1.3-alpha.2 | 增量 |
|---|---|---|---|
| company-sandbox-local-unc-v1 | ✓ | ✓ | 内容一致 |
| company-skill-custom-trusted-v1 / -get-custom-trusted-v1 | ✓ | ✓ | 内容一致（上游 C3 安全复审仍开着） |
| company-skill-root-eacces-v1 | ✓ | ✓ | 内容一致 |
| company-fs-unc-acl-v1 / -unc-replace-v1 | ✓ | ✓ | 内容一致（EACCES 回退上游已有） |
| company-goal-resume-armed-v1 | ✓（单锚点） | ✓（0.1.1+0.1.2 双 variants） | **多版本锚点** |
| company-win-junction-mklink-v3 | ✓（单形态） | ✓（两种 ensureSymlink 形态 variants） | **多版本锚点** |
| company-win-junction-mklink-v4 | ✓ | ✓ | 内容一致 |
| company-glob-missing-root-v1 | ✓ | ✓ | 内容一致（含中文报错匹配） |
| company-session-smbfs-rename-v1 | ✓（单 import 锚点） | ✓（0.1.3 lstat import 变体） | **多版本锚点** |
| company-session-events-alias-v1 | ✗ | ✓ | **新 mark（P0-2）** |
| company-assistant-markdown-slot-v1 | ✗ | ✓ | **新 mark（P1-4）** |
| company-session-lock-v2（旁路，kernel-native.mjs） | ✗ | ✓ WIP | **新 mark（P0-3）** |
| company-preset-skills-v1→v2 | ✓ v1 | ✓ v2 | v2 改公司镜像路径 → 糟粕 |
| company-preset-web-fetch-v1/v2 | ✓ | ✓ | 内容一致 |
| company-preset-instr-root-v1 | ✓ | ✓ | 内容一致（company-think 部分私有） |

## 8. 附录 B：验证证据

- 本仓测试：`node --test scripts/test/*.test.mjs` → **tests 246 / pass 245 / fail 0 / skipped 1**（2026-09-09 14:2x 复跑，约 26 s）。
- 逐行 diff 验证（2026-09-09）：fs-unc-replace、goal-resume、glob-missing-root、smbfs-rename、sandbox-unc 五处共享补丁两仓内容一致；`variants` 机制上游 grep 无匹配（确认上游没有）。
- pin.json 注释实证：0.1.2-rc.1 → 0.1.3-alpha.2 升版 16 处锚点干净命中；0.1.5-alpha.1 ETARGET 不可装。

---

## 9. 已提交（2026-09-09 下午更新）

发现 fork `ethanfly/TDHarness-coding` 上已有 5 个就绪分支（9-08 抽取，Assisted-by: Crush:kimi-k3）。本轮做了全量审查（含修复 compat 分支一处重复注释后 force-push `f2da8af`）、违禁内容扫描（干净）与本地实证，然后按仓库规则开 issue + PR：

| PR | 分支 | 对应 | 本地实证 |
|---|---|---|---|
| [#9](https://github.com/398894496-arch/TDHarness-coding/pull/9) | kernel-0.1.2-compat | P0-1 variants + 0.1.2/0.1.3 锚点（issue #8） | 三版 gold（0.1.1/0.1.2/0.1.3）`PATCH_PROVE_OK=1` |
| [#10](https://github.com/398894496-arch/TDHarness-coding/pull/10) | prove-bump | **C5**（issue #6） | 0.1.1-rc.2 绿（16 mark）；0.1.2-rc.1 正确报 `resume-already-armed-noop` 锚点；假版本/注入/无参拒绝 |
| [#11](https://github.com/398894496-arch/TDHarness-coding/pull/11) | setup-coding-subset | **C4**（issue #7） | `--only` 逗号列表 + 未知 mark 硬失败实测 |
| [#12](https://github.com/398894496-arch/TDHarness-coding/pull/12) | session-events-alias | **P7**（issue #8） | 0.1.1 跳过路径绿；集成分支 0.1.2/0.1.3 落地绿 |
| [#13](https://github.com/398894496-arch/TDHarness-coding/pull/13) | assistant-markdown-slot | **P8**（issue #8） | 同上；标注为功能型补丁待 scope 讨论 |

合并顺序建议：#9 → #10 / #11（独立）→ #12 → #13（#12/#13 在 prove-patches.js 有 trivial 冲突，集成解决已本地验证）。

**待办（需要维护者账号 398894496-arch）**：5 个 PR 的 CI 状态为 `action_required`（首贡献者门禁），需要维护者在 Actions 页点「Approve and run」；通过后按上面顺序合并。

验证用 gold 前缀保留在 `E:\orcaWorkspace\tdh-gold\{0.1.1-rc.2,0.1.2-rc.1,0.1.3-alpha.2}`（纯净安装，配合 `KERNEL_PREFIX` 环境变量可直接跑 prove-patches）。

**未提交**：P0-3（session-lock-v2 + chmodKernelExecutables，WIP 未在公司仓定型）与 P1-5（install-kernel Node 版/守卫移植）——仍按本报告第 2 节节奏推进。
