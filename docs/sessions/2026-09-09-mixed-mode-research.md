# Mixed 模式：插件推荐与适配方案

调研日期：2026-09-09。用户明确本轮先交付推荐和方案，不实施 mixed、不安装插件。

后续已细化为 [Mixed 详细实施计划](../superpowers/plans/2026-09-09-mixed-mode-implementation.md)。进一步核对发现 team-gui 的任务图和阶段接口不适合直接包装；详细计划以公司 Mixed 服务管理状态、官方子代理接口执行为主路线，按明确条件评估公司 fork。下文保留初次候选调研，具体实施以详细计划为准。

## 结论

有现成的 DeepSeek Harness 社区插件。优先评估 **dsh-agent-team-gui**：已有角色模型、自动规划、依赖调度、审核返修、会话模式及运行记录，最贴近客户端三个模型配置。**dsh-cortex** 是复杂任务递归拆解、动态选小模型、成本治理方向的备选。两者均需要适配，当前没有证据证明能原样满足本项目全部要求。

这不是 Codex 插件市场里的连接器；它们应安装到本项目的 DSH profile。生产集成应复用本仓库锁版、离线打包链路，而不是让员工单独执行安装命令。

## 候选与证据

### 1. dsh-agent-team-gui：首选做客户端产品集成

- 官方仓库：https://github.com/toolclub/dsh-agent-team-gui
- 读取的源码版本：package 1.0.1，commit `561ddf5b55c433a594310f0ae6a5e21036fbcbcd`。
- `src/types.ts`：AgentRecord 有 provider/model/toolScope；SquadRecord 有 leaderAgentId、自动触发、上下文策略、并发和超时；qualityGate 有 reviewerAgentId、repairAgentId、最多 0–2 轮返修。
- `src/index.ts`：通过 agent/pre-step 接入普通发送；会话 Team/Solo 模式、持久化运行与消息去重可复用。
- `src/tools/application/execution-service.ts`：实际通过官方 subagents.start 创建指定模型的执行者和审核者。不是只写角色提示词。
- README 宣称 v1.0.1 在 DSH 0.1.1-rc.2 验证；本项目 pin 和本机内核实际为 **0.1.3-alpha.2**。尚未进行安装/运行兼容测试，不能把声明的版本范围当作通过验证。

必须处理的差距：

1. 普通消息触发时 createAutomaticPlan 使用当前 parent.options.provider/model；leaderAgentId 不会自动覆盖它。mixed 应显式使用配置的 planner 路由。
2. 内置 quality gate 给审核者的 toolFilter 是空白名单，只传 bounded handoffs 和原始目标；它是摘要质量判断，不能证明代码、文件或测试真实通过。应增加独立审查步骤，读取产物/diff/测试记录，再给结构化结论。若允许审核跑测试，需要受控命令与工作区权限，不能把“可执行 shell”称为严格只读。
3. 派发异常时原实现允许主模型直接继续；mixed 应明确失败状态并由用户选择重试/切回普通模式，防止静默变成全程大模型执行。
4. 规划 assignments 按成员 agentId 建模。将复杂任务拆成任意数量的可追踪 taskId、同一小模型执行多个子任务，需要进一步评估/扩展，不能将成员 DAG 等同于任意任务树。
5. 最后仍有父模型生成用户回复的一次请求，要纳入模型归属和成本记录。

源码证据：https://github.com/toolclub/dsh-agent-team-gui/blob/561ddf5b55c433a594310f0ae6a5e21036fbcbcd/src/tools/application/execution-service.ts

### 2. dsh-cortex：递归任务树和成本路由更强

- 官方仓库：https://github.com/iguowz/dsh-cortex
- 读取的源码版本：package 0.2.2，commit `2ab53e3f9f0f0ecca5753af9cdb0f9abf5723f02`。
- 主模型调用 cortex_start/decompose/execute/review/recover；支持任务树、依赖、分级执行模型、质量门控、预算和恢复。
- 更适合“按任务能力动态选择多个便宜模型”，复杂度高于固定三个模型。
- 主模型兼任规划与监督验收；evaluatorModel 是另一个质量评估环节，不能直接等同于独立最终审核模型。
- `activeEvaluatorModel()` 在指定模型不可用时会回退其他 active 模型。若产品要求审核必须使用指定大模型，应改成明确报错，不能静默回退。
- 自带单独 Web 控制台；需要与本项目设置、公司网关和会话模式整合。尚未实测当前内核。

源码证据：https://github.com/iguowz/dsh-cortex/blob/2ab53e3f9f0f0ecca5753af9cdb0f9abf5723f02/lib/service.js

### 3. 其他方案

- https://github.com/thedeveloper256/dsh-model-router ：根代理/子代理按角色路由；适合轻量规划大模型、执行小模型，但路由本身不足以提供独立审核闭环。
- https://github.com/Khellendros97/dsh-better-plan-reviewer ：人工确认计划时切换执行模型；没有自动最终审核链。

## 建议的产品行为

会话入口增加 **Mixed · 混合**，与现有会话控制协同。开启后使用固定工作流：

需求 → 规划模型生成任务及验收标准 → 小模型依赖顺序实施与测试 → 审核模型检查实际证据 → 通过后交付；不通过则小模型返修 → 再审核。默认最多两轮返修，耗尽后显示“待处理”，不冒充完成。

客户端设置增加“混合模式”，三个选项均来自公司网关模型目录：

- **规划模型（大模型）**：拆解需求、依赖、风险、验收标准。
- **实施模型（小模型）**：执行每个子任务、修改文件、运行测试、提交交接证据。
- **审核模型**：独立复查；初始可与规划模型相同，但存储为独立配置。

每项存 provider + model；大小是角色定位，不依据名字猜模型能力。密钥仍仅在网关，沿用 desk-gateway-<provider> 路由与个人额度。

运行时将三项配置快照到 run；设置修改影响下一次运行。会话显示当前阶段、实际模型、子任务进度、取消、错误及审核结论。普通模型选择器在 mixed 下应清楚显示“由混合配置管理”，避免产生两个相互冲突的控制入口。

规划、执行、审核共享目标和验收标准；阶段间传递有界上下文与文件引用。任务记录至少包含 taskId、dependsOn、目标、验收条件、产物、测试证据、状态和审核反馈。首版串行执行，确认文件冲突策略后再开放并发。

## 仓库适配位置

1. `plugins/desk-host/lib/`：增加 mixed 适配模块、三模型配置读写、公司目录校验、运行状态与取消入口；通过现有 `/desk/api` 暴露。优先复用选定插件的服务接口，所需补丁单独锁定和维护。
2. `plugins/desk-ui/src/client/index.jsx`：新增设置页注册与会话入口。新建 mixed 设置组件和阶段状态组件，沿用现有样式/轮询架构。
3. `scripts/kernel/pin.json`：锁定通过验证的插件版本/发布包及完整性信息；使用现有 profilePlugins 安装、离线分发链路。
4. `profile/cordis.patch.yml` 与 `scripts/lib/bootstrap.mjs`：按最终打包方式挂载插件及公司适配层；检查宿主 peer 和客户端模块解析。

不要因 README 中旧版本说明而升级或降级内核；以 pin 和运行包为准。当前工作树有其他 macOS 打包改动，后续实施需要保留。

## 实施顺序与验收

1. 在隔离测试 profile 安装锁定版本的 team-gui，验证 0.1.3-alpha.2 的宿主服务、前端槽位及三条公司模型路由。失败再决定适配分支或 Cortex，不同时装两套接管会话。
2. 做一个完整小任务的三阶段验证，检查请求记录中模型路由是否确实不同；验证实际文件变化与审核证据。人工制造缺陷，确认审核退回和返修再审生效。
3. 补 mixed 模式与三项设置，配置持久化、每次运行快照；扩展独立 taskId 调度和实际证据审核。
4. 覆盖取消、模型下架、超时、非法审核输出、两轮返修失败、客户端断开和宿主重启。重启后必须恢复或明确标为中断，不能重复实施同一个已认领任务。
5. 验证离线安装包与公司额度计量，并确认普通模式不受影响。

本轮完成的是源码与文档调研；未安装候选插件、未调用真实模型做集成测试、未实现 mixed。推荐是适配优先级判断，不是兼容性或成本效果保证。
