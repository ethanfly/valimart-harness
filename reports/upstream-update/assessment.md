# 上游更新可行性评估（t3）

- **任务**：形成更新可行性结论与实施建议
- **生成时间**：2026-09-10 17:05 +08:00（本轮复核刷新；上一轮 16:55）
- **证据基线（as-of）**：
  - 目标仓 `E:/orcaWorkspace/company-harness`：HEAD `94b9a2c`（2026-09-10 14:58 +0800），工作树 19 个已修改（M）+ 4 个未跟踪（??，含本任务 `reports/` 与并发文件 `e2e/mixed-dock-align.spec.js`）
  - 上游仓 `E:/orcaWorkspace/TDHarness-coding`：本地 HEAD `d02046a`（2026-09-09 09:25 -0700），本地 fetch 止于 2026-09-10 13:14 +0800；**本轮 HTTPS 核验 GitHub `commits/main` sha=`d02046a`（2026-09-10 17:05），与本地一致**；PR 页 5 Open（#9–#13）+ 2 Closed merged（#3/#5）
- **证据来源**：`reports/upstream-update/baseline.json`（t1）、`reports/upstream-update/impact.json`（t2）、本轮只读 git + HTTPS 复核（见 §12）
- **机器可读决策**：`reports/upstream-update/decision.json`

---

## 1. 简明结论

**结论：附条件更新（conditional）。现在不能整仓合并；满足前置条件后建议选择性吸收。**

现在**不能**执行"整仓更新/合并"——两仓本地 git 对象史互不相通（`git merge-base` 退出码 128，无共同祖先），不存在可计算的 merge-base；所谓"更新"只能是**选择性代码移植 + 文档参照**。而在满足下列前置条件后，**建议**实施选择性吸收，其中**必须吸收**的是上游唯一的功能性修复（C1/C2 沙箱预检 v1→v2，对应本仓高风险项 r-01）与低成本的仓库卫生项（`.gitattributes`，r-04）；**暂缓**的是 C3 安全裁决相关项（r-03，上游未闭环）与 prove CI（adapt-2，runner 可用性未验证）。

判定理由（基于已取证证据）：

1. **不是"追版本"**：上游 pin 仍停在 `0.1.1-rc.2`，本仓已 pin `0.1.5-rc.1`（工作树，未提交），增量窗口内 0 个内核版本变化、0 个 npm 依赖变化——本仓在内核版本线上**领先**上游，依赖级"落后"不存在（impact.json `coverage.dependencies`）。
2. **增量价值真实且已定位**：上游 6 个增量提交（d8ffc77..d02046a）中，功能性核心只有 C1/C2——把 mapped 网络盘/SUBST 别名工作区在 ACL grant **之前**拒绝，补齐本仓 sandbox v1（仅拦字面 UNC 前缀）的预检缺口（r-01，severity=high）；本仓默认 `danger-full-access` 预设下，workspace-write 沙箱路径检查仍是实际生效的边界，该缺口不是纯理论问题。
3. **不判"直接建议更新"的原因**：
   - 本仓工作树有 23 处未提交改动（19 M + 4 ??），其中至少 8 个文件已现 CRLF 翻转警告（r-04），任何吸收动作都会与之纠缠，必须先落地（commit/stash）并分离本任务报告文件。
   - 功能核心 sandbox v2 backport（adapt-1）属**需人工适配**：锚点须按 0.1.5-rc.1 重验、现有前缀因 v1 mark 在位会被 legacy 守卫硬失败（须全新前缀重装）、引入 PowerShell 5.1 + Add-Type 运行时硬依赖（r-02，受限环境会拒绝全部本地工作区）、dev 工作区 node_modules 存在未受管的已打补丁内核副本（r-08）——上述工作清单**全部未执行、未验证**。
   - 快照时效性（r-09，现为 low-medium）：本轮 HTTPS 已确认线上 main 仍是 d02046a，但实施吸收前窗口仍可能前进。
4. **不判"暂不更新"的原因**：C2 缺口是本仓当前真实暴露面，`.gitattributes` 吸收成本极低且能立即止住未提交改动的行尾污染；完全冻结现状没有证据支持。
5. **不判"证据不足"的原因**：两仓已完成全量只读检查（git 对象/文件树/补丁器逐 mark 比对/已装内核 mark 定位/依赖与构建声明比对），且本轮用 HTTPS 核验了线上 HEAD 与 PR 开闭；增量窗口、mark 分叉面、三分类均已量化。缺失项（运行验证、Add-Type 预检）是**执行前置条件**，不构成判断能力缺口。

**本次未合并、未构建、未部署、未运行任何项目脚本**；本文件与 decision.json 本身是"建议"，不是"已执行更新"的证明。

---

## 2. 版本基线摘要（引自 t1 baseline.json）

| 项 | 目标仓（本项目） | 上游仓（TDHarness-coding） |
|---|---|---|
| HEAD | `94b9a2c`（main，2026-09-10 14:58 +0800） | `d02046a`（main，2026-09-09 09:25 -0700） |
| 线上核验 | origin（git.ethan.team）未 fetch；本地领先 a6adcb9 共 12 提交 | GitHub `commits/main` sha=`d02046a`（2026-09-10 17:05 HTTPS，与本地一致） |
| 内核 pin | `scripts/kernel/pin.json` = **0.1.5-rc.1**（工作树；HEAD 值 0.1.3-alpha.2） | `kernel.yml` = **0.1.1-rc.2**（未随增量 bump） |
| 仓库形态 | npm 应用（company-desk 0.1.0）+ 内置补丁器 + 安装包流水线 | 内核 pin 配方仓（kernel.yml/overlays/patches/runtime），**无 package.json** |
| 工作树 | 19 M + 4 ?? | clean（0 改动） |
| 远端 | git.ethan.team 自有仓（fetch/push 同 URL） | GitHub 上游 + ethanfly fork（PR #9–#13 仍 open；#3/#5 已 merged） |
| 共同祖先 | **无法确定**（对象史不相通，merge-base 128） | 同左 |

派生关系为**代码级同源**（上游 2026-09-03 首次发布时从公司补丁器蒸馏，补丁注释仍引用 `scripts/p-product-base/...`），不是 git fork；因此**任何"更新"都不可能是 git merge/rebase**。

## 3. 上游增量内容摘要（引自 t2 impact.json）

增量窗口 = 首次发布提交 d8ffc77（2026-09-03）之后至快照 HEAD d02046a，共 6 个提交：

| 提交 | 内容 | 吸收相关性 |
|---|---|---|
| dbbd81c / 0e4ae6f | README/PRODUCT 英文化、截图、中文页 | 无 |
| 6128f12 | BUGS.md 缺陷清单、prove CI、issue 模板 | 低（C5–C8 开放项与本仓相关） |
| **95e8204（#3 已并入）** | C1：沙箱路径 helper 抽成 `patches/lib/network-path.js`（单一事实源）+ UNC 归一化判定 + prove-unc.js 行为证明 + CI | 高 |
| **3e15cb3（#5 已并入）** | C2：mark 升 `company-sandbox-local-drive-v2`；Windows 驱动探测（PowerShell 5.1 + Add-Type P/Invoke）；mapped/SUBST 工作区在 `materializeAclGrant` 首个原操作前拒绝；probe 失败=拒绝（新错误码 `COMPANY_WORKSPACE_PROBE_FAILED`）；legacy 守卫（v1-only 前缀硬失败）；prove-windows-drives.js | **高（本增量唯一功能核心）** |
| d02046a | `.gitattributes`（8 行，LF pin + 二进制标记） | 中（本仓无 .gitattributes 且已现 CRLF 警告，r-04） |

增量窗口内**无文件重命名/删除**；两仓同路径重叠仅 `.gitignore` 与 `README.md` 两个文档文件且同名不同文——**无文本冲突**（r-10，verified）。但注意 r-10 的排除性结论：**无文本冲突 ≠ 功能兼容**，真正的重叠在补丁器代码层（sandbox mark 分叉 v1/v2 是核心分叉点；本仓另有 target-only 代码 mark + variants 机制 + kernel-native 层）。

本轮复核确认：target `scripts/kernel/patches.mjs` L43 仍为 `company-sandbox-local-unc-v1`；上游 `patches/apply-kernel-patches.js` L61 仍为 `company-sandbox-local-drive-v2` 且 L477–478 有 legacy 守卫；已装内核 `node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js` L543 仍含 v1 mark。

## 4. 必须满足的前置条件（blockers）

**任何吸收动作（包括 `.gitattributes`）之前**，以下条件必须满足：

1. **B1 快照再核（r-09/und-2）**：实施前再核一次 GitHub `commits/main`（HTTPS 即可，不必 git fetch）；若 d02046a 之后有新提交，重跑增量分析。本轮 17:05 核验已把"线上是否已前进"从未知降为**当时对齐**；B1 变为实施窗口内的再确认，不再阻塞本可行性结论本身。
2. **B2 工作树落地**：本仓 19 M + 4 ?? 先提交或 stash（`reports/` 与本任务产物分离）；被 CRLF 警告的文件在 `git add` 前明确行尾处置（建议与 P1 的 `.gitattributes` 独立提交协同，避免功能 diff 被行尾改写污染，r-04/r-05）。
3. **B3 环境预检（仅 sandbox v2 backport 需要，r-02）**：在目标机实测 Windows PowerShell 5.1 下 `Add-Type`（P/Invoke `QueryDosDeviceW`/`GetDriveTypeW`）可用性并写入安装文档；若存在 ConstrainedLanguage/管控策略禁用 Add-Type 的环境，须先与上游讨论 probe 失败降级语义，**不得**默认 backport（否则 probe 失败将拒绝全部本地工作区，相对 v1 是行为降级）。
4. **B4 dev 内核副本定性（r-08/und-3）**：确认 `node_modules/@deepseek-ai/*` 0.1.5-rc.1 副本的来源与运行时角色（非 package-lock 成员、仓根无完整前缀布局、已含 v1 mark）；若为实际运行内核根，backport 工作清单必须包含对它的全新重装+重打补丁（v1 mark 在位，legacy 守卫会硬失败）。
5. **B5（可选项门槛，adapt-2）**：prove CI 引入前，先确认自托管 git.ethan.team 的 CI runner 可用性；不可用则跳过。

## 5. 关键风险（引自 t2 impact.json，按 severity 排序）

| ID | 风险 | 级别 | 状态 |
|---|---|---|---|
| r-01 | sandbox 补丁 v1↔v2 分叉：本仓仍带 C2 已修复的 mapped/SUBST 预检缺口；两补丁器持续分叉将累积再分叉成本 | **high** | not-verified（静态比对；本轮复核 mark 仍分叉） |
| r-02 | v2 backport 引入 PowerShell 5.1 + Add-Type 硬依赖；受限环境 probe 失败→拒绝全部本地工作区 | medium | not-verified（未执行探测） |
| r-03 | C3 安全评审未闭环：本仓持有与上游相同的两个 privilege-shaped patch（skill custom trusted + fs-unc-acl） | medium | not-verified |
| r-04 | 本仓无 .gitattributes，至少 8 个未提交文件已现 CRLF 翻转警告；吸收 .gitattributes 有一次性 renormalize 成本 | low-medium | not-verified |
| r-09 | 快照时效性：本轮 HTTPS 已确认线上 main=d02046a，实施前窗口仍可能前进 | **low-medium**（由 medium 下调） | **partial**（HEAD/PR 开闭已核验） |
| r-05 | 未合并 PR #9–#13（线上仍 open）与本仓未提交改动同源（variants/0.1.5 锚点变体）；同步策略未定则易出三方分叉 | low | partial（开闭已核验；CI 细节未核） |
| r-06 | C2 已知局限随 backport 带入：junction 不解析、30s 重映射窗口、precheck 非 NTFS 隔离证明 | low | not-verified（引用上游文档） |
| r-07 | C8 同源隐患：rg exit-2 空结果映射可能掩盖真实 IO/权限错误（本仓 matcher 还多一条中文分支，暴露面略大） | low | not-verified |
| r-08 | dev 工作区 node_modules 存在未受管的已打补丁内核副本，backport 时易漏处理 | low | not-verified |
| r-10 | 文本冲突面：同路径重叠仅 2 个文档文件，无文本冲突——**不得据此推断功能兼容**（排除性结论，防误读） | none | **verified**（只读文件树交集 2/33 vs 284） |

未定事项：und-1 C3 裁决、und-2 CI 细节与此后线上前进、und-3 dev 副本来源——均不阻塞本可行性结论，但分别阻塞 C3 跟进、吸收执行与副本处置。

## 6. 需要保留的本地定制（backport 时的"不得动"清单）

1. **target-only 代码 mark**：`company-assistant-markdown-slot-v1`（对应未合并 PR #13）、`company-session-events-alias-v1`（对应未合并 PR #12）——backport 只允许触碰 sandbox mark 及其 helper，不得覆盖。
2. **editVariants/applyEdit 锚点变体机制**（对应 PR #9）：含 0.1.5-rc.1 `MarkdownText` pathImages 属性变体；v2 移植须沿用该机制承载新锚点变体。
3. **kernel-native 会话锁适配层**（`scripts/lib/kernel-native.mjs`，fs-ext v1/v2 + 0.1.5 flock 跳过逻辑）：上游 patcher 无此层（靠 runtime shim/overlay），不可用上游文件整体替换。
4. **预设 pin 扩展**：`company-think` / `company-think-eval` 的 instr-root（上游只处理 standard/code）。
5. **profile 定制**：`profile/cordis.patch.yml`（官方外壳关闭、全模型走公司网关、默认 danger-full-access）与上游 overlays/solo.yml 不相关，不动。
6. **产品层超集**：Mixed 混合模式（plugins/desk-host/lib/mixed/* + server/src/mixed-*）、公司网关 30+ 模块、插件体系（desk-host/desk-ui/desk-image）、安装包 pin（WinSW 2.12.0 + node v25.2.1 linux-x64 含 sha256）——与上游增量零交集，天然保留。
7. **同步策略建议（r-05）**：以 **target 补丁器为权威** + 定期向上游 PR（本仓已领先多版本线且 variants 机制更完整），避免"等待上游合并后反向吸收"造成双重重做。PR #9–#13 本轮确认仍 open。

## 7. 建议的整合方式及其适用前提

**整合方式：选择性代码移植（selective backport）+ 文档参照，明确排除 git merge/rebase（无共同祖先，不可行）。**

| 项 | 方式 | 适用前提 |
|---|---|---|
| `.gitattributes`（abs-1，d02046a） | 直接吸收：加文件 + `git add --renormalize .` 独立提交；binary 标记按本仓资产核对（png/jpg 已覆盖 assets 与 docs/evidence） | B2 满足；renormalize diff 与 19 处未提交改动**分离处理**，独立提交；实施前再核 B1 |
| BUGS.md 的 C1/C2 记录与 C2b/C3/C8 开放项（abs-2） | 仅知识参照存档（本仓无 BUGS.md 对应文件，不做文件级合并） | 无 |
| sandbox v2 backport（adapt-1） | 人工移植：① `patches/lib/network-path.js` 8 个 helper 按 target 的 HELPERS 模板机制移植（CJS→ESM 或保持字符串嵌入）；② MARK v1→v2 + 与上游同形的 legacy 守卫分支；③ 对 0.1.5-rc.1 重验 `materializeAclGrant` 两处锚点；④ 全部既有前缀（~/.company-desk/kernel + dev 副本）全新重装后重打补丁；⑤ PowerShell 环境预检与文档化；⑥ 参照 prove-unc/prove-windows-drives 的 fixture 方式补 target 侧行为测试 | **B1–B4 全部满足**；且"无文本冲突"绝不作为可合并依据（r-10） |
| prove CI 四 job（adapt-2，可选） | 改写为本仓约定（pin.json 源、~/.company-desk/kernel 前缀）后引入 | B5 满足（自托管 runner 可用） |

**明确不吸收/暂缓**：内核版本 bump（上游 pin 更旧，无"追"的语义）；C3 相关 patch 的改动（等上游裁决，r-03/und-1）；C8 matcher 收紧（等上游收敛结论，r-07）；overlays/solo.yml（不适用于本仓）。

## 8. 分阶段更新顺序

- **P0 前置（不产生代码变化）**
  1. B1：实施前再核 GitHub `commits/main`；若已前进则重跑 t2 分析（结论标注新 as-of）。
  2. B2：落地本仓未提交改动（commit 到独立提交或 stash 列表）；`reports/` 与本任务产物不入该提交。
  3. 备份（见 §9）：git tag + 前缀快照 + pin.json 记录。
- **P1 低风险卫生（独立提交，可单独回退）**
  4. 吸收 `.gitattributes`（abs-1）：加文件 → renormalize → 独立提交 → `git diff --stat` 复核归一 diff 面（未验证项，实施时记录）。
  5. BUGS.md 知识存档（abs-2，docs 引用）。
- **P2 功能核心（本增量唯一功能价值）**
  6. sandbox v2 backport（adapt-1 六步工作清单，§7）：helper 移植 → mark v1→v2 + legacy 守卫 → 全新前缀重装 0.1.5-rc.1 + 锚点重验（`npm run kernel` 流水线，含 node --check）→ PowerShell 预检（B3）→ target 侧新行为测试 → dev 副本处置（B4）。
  7. 在 target 文档中如实记录 C2 局限（r-06：junction/30s 窗口/precheck 语义）。
- **P3 可选**
  8. prove CI（adapt-2），仅当 B5 满足。
- **P4 验证与收尾**
  9. 跑完 §10 构建/测试清单并留档；C3（r-03）、C8（r-07）进入观察跟踪（不阻塞）；回贡献 PR 基线按 §7 策略更新。

顺序约束：P1 与 P2 必须分开提交（卫生 diff 与功能 diff 不纠缠）；P2 完成前不得触碰任何运行中前缀（target 补丁器纪律：`locate.mjs refuseLivePrefix`）。

## 9. 备份与回退策略

**实施前备份（P0 第 3 步）**：

1. `git tag pre-upstream-absorb-20260910` 打在当前 HEAD `94b9a2c`；
2. 未提交改动以独立中间提交或 stash 列表保存（B2），并记录 `git status --porcelain` 快照；
3. 内核前缀 `~/.company-desk/kernel` 整目录快照（robocopy /MIR 到本机备份位）；
4. dev 工作区 `node_modules/@deepseek-ai/` 副本快照（r-08，先定性再处置）；
5. 记录 pin.json 当前值（0.1.5-rc.1）与补丁计数（16 处干净命中基线）。

**回退（按吸收项粒度，每项独立提交→可独立 `git revert`）**：

- 代码层：revert 对应吸收提交；若 renormalize 提交造成意外面，回退该独立提交即可，不影响功能提交。
- 内核层：用备份的前缀快照恢复，或走现有流水线全新重装旧 pin（0.1.5-rc.1）+ 重打 v1 补丁；本仓内核更新链（`scripts/kernel/update.mjs` + bootstrap 的 kernel-next 校验失败回退旧内核）已具备该能力，本次未验证其对新前缀的适用性。
- 数据层：本增量 0 内核版本变化 → 会话 jsonl / sqlite / 账本数据格式零变化，**无需数据回退**。
- 环境层：若 B3 预检发现目标机 Add-Type 受限且已部分推进，整体回退 P2（revert + 前缀恢复），不得保留"半迁移"状态。

## 10. 后续构建/测试清单（授权实施时执行；本次全部未执行）

| # | 命令/动作 | 目的 |
|---|---|---|
| 1 | `npm run kernel:check` | 既有前缀健康检查（backport 前后各一次） |
| 2 | `npm run kernel` | 全新前缀安装 0.1.5-rc.1 + 锚点补丁 + node --check 语法校验（backport 后应含 v2 锚点） |
| 3 | PowerShell 5.1 有界探测（Add-Type P/Invoke，参照上游 prove 脚本） | B3：确认目标机 probe 依赖可用 |
| 4 | **新增** target 侧 sandbox v2 行为测试（fixture 方式，参照 prove-unc/prove-windows-drives，含 UNC 拒绝/本地放行/临时 SUBST 拒绝与拆除负向对照） | 替代上游 CI 在本仓的等价验证 |
| 5 | `npm test`（node --test server/test/*.test.js scripts/test/*.test.mjs） | 服务端与脚本层回归（含 kernel-patches/kernel-native 双锚点变体测试） |
| 6 | `npm run build`（esbuild 客户端 bundle） | 客户端构建不回归 |
| 7 | `npm run test:e2e`（playwright，含既有 spec 与并发新增的 mixed-dock-align） | 桌面端 E2E 回归 |
| 8 | `npm run dev` / 桌面端启动冒烟：本地固定盘（E:\...）workspace-write 行为不变；有条件时人工验证 mapped 盘被拒 | 运行时行为验证（r-01 修复生效性的最终证据） |
| 9 | `npm run dist:client` / `npm run dist:gateway`（发布前） | 安装包构建不回归 |
| 10 | `git diff --stat`（renormalize 后）+ 抽样抽查行尾 | 验证 P1 归一 diff 面（r-04 未验证项） |

`package.json` 脚本名本轮复核均真实存在（kernel / kernel:check / kernel:prepare / test / test:e2e / build / dist:* / dev）。

## 11. 尚未执行的验证（明确边界）

以下项**均未执行**，任何"已通过"的说法都不成立：

- git fetch / pull / checkout / reset / stash（本轮未做；线上 HEAD 改用 HTTPS 只读核验，已确认 d02046a）；
- 本仓 origin（git.ethan.team）远端当前状态（最后 fetch 的 origin/main=a6adcb9 为 HEAD 祖先，本地领先 12 提交）；
- 一切合并尝试（git merge/rebase/diff --merge）——两仓无共同祖先；
- 一切构建（npm run build / dist:* / installer）与一切项目脚本运行（install-kernel / kernel:prepare / node --test / playwright / 桌面端启动）；
- PowerShell 5.1 Add-Type 探测、真实 NTFS ACL 与 mapped 盘行为验证、`git add --renormalize` 行尾归一；
- v2 helper 在 0.1.5-rc.1 内核上的任何运行行为（锚点重验/全新前缀/probe 时序）；
- GitHub Actions 门禁页逐条 Approve 状态。

**宿主命令核验的边界（必须声明）**：宿主对本任务的验收命令只能证明**交付物结构完整**（四个文件存在于 `reports/upstream-update/`、JSON 可解析、verdict 取值合法、`actualUpdatePerformed=false`），**不代表**上游更新兼容性已通过任何运行验证；兼容性判断的依据仍是 §2–§5 的静态分析与只读检查证据。限制：本机指纹检测不覆盖其他机器/编辑器的并发修改。

## 12. t3 自身执行的检查（只读 + 本任务允许的报告写入）

1. 读 t1/t2 上一轮产物全文，并与本轮只读 git 对照；
2. 只读 git：两仓 `rev-parse` / `status --porcelain` / `log -1` / `merge-base` / `cat-file` / `ls-files` 交集 / `merge-base --is-ancestor`（6 条 fork 分支）——结果：target 仍 `94b9a2c`（23 条：19 M + 4 ??），upstream 仍 `d02046a` 且 clean，与上一轮快照一致；共同祖先仍不可计算（exit 128）；
3. HTTPS 只读：GitHub `commits/main` HTTP 200 sha=`d02046a`；pulls 页 5 Open（#9–#13）+ 2 Closed merged（#5/#3）；
4. 读 `package.json` 脚本段、工作树/HEAD `pin.json`、`patches.mjs` MARK、上游 `apply-kernel-patches.js` MARK + legacy 守卫、已装内核 L543 v1 mark、`package-lock.json` 中 `@deepseek-ai` 条目数=0；
5. 抽查 `git diff` CRLF 警告（installer.nsh / pin.json / kernel-native.mjs / admin-page.js / 4 个 e2e/test 文件）。

**t3 未执行**：git fetch、合并、构建、运行项目脚本、Add-Type 探测、renormalize。写入范围仅限 `reports/upstream-update/` 四份交付物。

---

*本报告结论覆盖 2026-09-10 实际取得的证据（上游快照 d02046a 经 17:05 HTTPS 核验仍为线上 main、目标 HEAD 94b9a2c 及各自工作树状态）；所有 not-verified 项在实施前必须按 §4/§10 补验证。限制：本机指纹检测不覆盖其他机器/编辑器的并发修改。*
