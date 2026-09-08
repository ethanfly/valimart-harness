# OpenClaw 替换 DeepSeek Harness：可行性分析

日期：2026-09-09
作者：ethan（管理员，技术部）
目的：评估以 https://github.com/openclaw/openclaw 作为核心运行时，替换当前
`@deepseek-ai/dsh` 的可行性、业务重构范围、风险与分阶段路线。
结论：**可行性高的是「OpenClaw 作为本地 Agent Runtime」；直接替换 DSH 作为
当前产品全部核心，可行性与改造量不成比例，不建议作为目标。**

## 1. 总判定

| 方案 | 可行性 | 改造量 | 建议 |
| --- | --- | --- | --- |
| OpenClaw 直接替换 DSH（同接口接管一切） | 低 | 很大 | 不采用 |
| 保留现有公司网关，OpenClaw 作为员工本机 Agent Runtime | 高 | 中 | **推荐** |
| 保留现有 UI/任务/公司盘，加 OpenClaw 适配层 | 高 | 中偏大 | 过渡路线 |
| OpenClaw 整体接管账号/额度/任务/公司盘/多租户 | 中 | 极大 | 仅接受重构时考虑 |

## 2. OpenClaw 与 DSH 的定位差异

依据：OpenClaw 仓库 README、官方架构文档、插件/模型/安全文档（见文末链接）。

- OpenClaw：长期运行的本地 **Gateway**，控制面是 **WebSocket**（默认绑
  `127.0.0.1:18789`）：`req:connect` → `req:agent` → 流式 `event:agent`；
  Session 靠 `sessionKey` 路由；设备配对 + Gateway token 认证；多宿主渠道
  （WhatsApp/Telegram/Slack/…），还有 macOS/iOS/Android/Windows 的
  **Nodes** 作为设备执行面。插件系统按工具/模型/渠道/技能扩展。
- DSH：当前产品基于的本地 agent harness，UI 走 **前端 slot/插件注入**
  （`ctx.slots.inject`、`ctx.sessions`、`ctx.tools.register`），会话有
  **父子树**（`header.parentSession`），任务绑定沿会话树向上爬。
- 两者重叠的是「会话 + Agent + 工具 + 模型路由」，但**接口形态、事件流、
  前端挂载方式、权限模型完全不同**。把 `@deepseek-ai/dsh` 直接换成
  `openclaw` 会导致宿主插件与 UI 全部失效。

## 3. 现有业务中「不需要重构」的部分

这些属于公司业务域，集中在 `server/`，**与 Agent Runtime 解耦，可原样保留**：

- 账号/部门/角色/停用（`server/src/db.js`、`server/src/api.js`）
- 登录会话与按设备网关令牌（即时吊销）
- 模型通道接入与凭据（密钥只落服务端，`server/src/channels.js`）
- 按人额度与账本（`server/src/ledger.js`、`server/src/upstream-quota.js`）
- 任务卡状态机与四格验收流（`server/src/tasks.js`）
- 交付物强制（口头完成不算，需挂公司盘文件）
- 公司盘权限 / 知识库四层检索（`server/src/drive.js`、`server/src/knowledge.js`）
- 管理页 / 网关令牌 / 生图与视频代理（`server/src/llm-proxy.js`）

## 4. 与 DSH 强耦合、需要重构/迁移的部分

| 块 | 位置 | 耦合内容 |
| --- | --- | --- |
| 宿主插件 | `plugins/desk-host/lib/index.js` | 直接 import `@deepseek-ai/dsh-*`；用 `ctx.sessions`、`ctx.tools.register`、session event、`header.parentSession` 会话树 |
| 浏览器 UI | `plugins/desk-ui/src/client/*` | `inject: ['slots','theme','sessions','workspaces']`；slot/root/layout、DSH 会话与工作区 store、Markdown primitives |
| 内核安装/打补丁 | `scripts/install-kernel.mjs`、`scripts/kernel/*`、`scripts/lib/bootstrap.mjs`、`scripts/build-payload.mjs` | 围绕 `@deepseek-ai/dsh@<pin>` 的独立前缀安装、16 处锚点补丁、profile/cordis 层 |
| 桌面启动/打包/升级 | `desktop/main.js`、`desktop/*`、`scripts/lib/client-update.mjs`、`plugins/desk-host/lib/client-update.js` | 启动编排、payload 解包、buildId 增量更新、Electron 壳 |
| 会话-任务绑定 | `plugins/desk-host/lib/index.js` | `taskOfSessionOrAncestor` 依赖 DSH 父子会话树；OpenClaw 需改用 sessionKey/runId/事件重做映射 |

## 5. 关键约束

### 5.1 多用户 ≠ 一个 OpenClaw Gateway

OpenClaw 官方安全模型：**一个 Gateway = 一个信任边界**。单 Gateway 内
session 工具默认可达所有 agent 会话、agentToAgent 默认开启，互不信任的用户
共用一个 Gateway **不受支持**；强隔离要拆 Gateway / OS 用户 / 主机。

本项目是多员工企业网关 → **不要做「全员共用一个 OpenClaw Gateway」**。

推荐形态：**每个员工桌面一份本机 OpenClaw Gateway**，公司网关仍是权限/业务
控制中心；或按互信小组分 Gateway（可作后续团队部署选项）。

### 5.2 模型调用不能被 OpenClaw 直连绕过

现状：网关令牌校验 → 周额度检查 → 上游转发 → 按人记账（`llm-proxy.js`）。
若 OpenClaw 直配真实 key 会绕过额度与记账。

路线：OpenClaw（models.providers 自定义 baseUrl，OpenAI/Anthropic 兼容）
→ 公司 LLM Proxy → 上游。关键是**请求要带当前员工身份**，不能一个全局 token
把用量全记到一个人头上。

### 5.3 公司工具必须重写为 OpenClaw 插件

`company_*` 系列工具当前注册在 DSH `ctx.tools.register`。OpenClaw 侧需要按
OpenClaw 插件 SDK 重写注册（工具可用，schema 兼容度高，但加载/生命周期/
Gateway restart 语义不同）。

### 5.4 Windows 形态

OpenClaw Windows：CLI/Gateway 原生支持（Scheduled Task 托管），另有 Windows
Hub（WinUI 伴侣）与 WSL2 Gateway 路径。与当前 Electron + 随包 node 的启动/
打包/更新模型不同，desktop 壳与分发要重做评估。

### 5.5 许可证与治理

OpenClaw：MIT（OpenClaw Foundation，2026）。上游治理为基金会模式，无付费层。
可自托管、可改、可嵌入。

## 6. 目标架构（推荐）

```
员工桌面
 ├─ valimart 公司网关客户端壳
 │    登录 / 任务 / 公司盘 / 额度（走现有 HTTP API）
 └─ 本机 OpenClaw Gateway（每员工一份）
      └─ Agent Runtime Adapter ← 会话/事件/run 与公司 UI 解耦
           ├── DshRuntimeAdapter（保留，回退用）
           └── OpenClawRuntimeAdapter（新增）
公司网关（不变）
 ├─ Auth / Users / Roles / Tokens
 ├─ Quota / Ledger / LLM Proxy（OpenClaw 经由此处转发，带员工 token）
 ├─ Tasks / Reviews / Deliverables
 └─ Drive / Knowledge
```

Runtime Adapter 最小接口草案：

```js
class AgentRuntime {
  async createSession(opts) {}
  async send(sessionId, input) {}
  subscribe(sessionId, handlers) {}
  async stop(sessionId) {}
  async getHistory(sessionId) {}
  async attachFiles(sessionId, files) {}
}
```

DSH 与 OpenClaw 各实现一个 Adapter，上层 UI/任务/公司盘逻辑不改。

## 7. 分阶段建议

1. **POC（技术验证）**：起一个本机 OpenClaw Gateway → WS 建会话 → 发消息 →
   收流式 agent 事件 → 调一个公司工具（经 LLM Proxy 转发）→ 挂一张任务卡。
   不动现有 UI。
2. **适配层**：OpenClawRuntimeAdapter + company tools 的 OpenClaw 插件 +
   用户级 runtime token + session/run/event 与任务绑定映射。DSH 并行保留。
3. **客户端替换**：DSH slot UI → 运行时无关的会话客户端；启动/打包/更新改造；
   旧会话迁移。此时才决定是否下线 DSH。

## 8. 回答原始问题（结论三行）

- 用 OpenClaw 当核心 Agent Runtime：**可行**。
- 直接替换 DSH 而业务逻辑不动：**不可行**（接口与运行模型不兼容）。
- 现有业务逻辑要不要重构：**账号/额度/任务/公司盘不用**；
  宿主插件 / 浏览器 UI / 会话树绑定 / 启动打包更新 **需要迁移或重写**。

## 9. 参考资料（OpenClaw 官方）

- 仓库/README：https://github.com/openclaw/openclaw（评估时 HEAD 44b52287；MIT）
- Gateway 架构（WS、sessionKey、pairing）：
  https://docs.openclaw.ai/concepts/architecture
- 插件：https://docs.openclaw.ai/tools/plugin（及 building-plugins 文档）
- 模型 / 自定义 provider：
  https://docs.openclaw.ai/concepts/model-providers（`models.providers` + baseUrl +
  `api: openai-completions / anthropic-messages`，非官方端点强制关闭
  `supportsDeveloperRole` 等兼容项）
- 安全（信任边界、单 Gateway 多用户边界、audit）：
  https://docs.openclaw.ai/gateway/security
- Windows：https://docs.openclaw.ai/platforms/windows
