# 交接：现在在哪、下次该干嘛

> 活文档。每次会话结束更新这里；过程记录放 `docs/sessions/`。

## 现在在哪（2026-09-04）

- 仓库：<https://git.ethan.team/ethanfly/company-harness>，分支 `main`
- 目标：复刻视频里的「企业交付工作台」THE DIVA —— 统一服务端 + 共享模型 token + 桌面客户端
- 状态：视频里出现的功能全部落地并有截图证据（`docs/evidence/00–18`），服务端 12 个端到端用例全绿，
  内核由仓库自己安装打补丁（`scripts/install-kernel.mjs`），**不再依赖 `TDHarness-coding` 仓库**
- 跑起来：`npm install && npm run dev`（首次会从 npm 下载内核，约 20 秒）；账号见 README §3

### 关键决定（别轻易推翻）

| 决定 | 为什么 |
|---|---|
| 网关令牌绑定「登录会话 = 一台电脑」，不是一人一枚 | 一人一枚时管理页/第二台电脑一登录就把桌面端悄悄踢下线，且客户端心跳查不出来。现在：换电脑不互踢、管理页不签令牌、登出只收本机、管理员吊销一次收全部 |
| 「个人」工作区一人一座 | 同一台电脑换人登录，前一个人的个人格子从列表收起（目录和会话日志保留） |
| 内核补丁用锚点式编辑，锚点对不上就硬失败 | 整文件覆盖会在升内核时悄悄吃掉上游修复。升版本只改 `scripts/kernel/pin.json`，失败的那条补丁必须人工重审 |
| 内核前缀独立（`~/.company-desk/kernel`），拒绝写全局 npm / node 目录 | 不碰任何正在被别的东西用的树；老机器上 `~/.tdh-coding-prefix` 有内核则复用 |
| 上游密钥只在服务端；客户端只拿网关令牌 | 「共享 token」的本质：公司统一持有密钥/订阅，全员共用额度但按人记账限额 |
| `server/data/` 不入库 | 里面有通道凭据、令牌、密码哈希；首次启动按 `config.json` 自动播种 |

## 下次该干嘛（按优先级）

### 1. 打成安装包（与视频差距最大的一项）

视频里是独立桌面应用；现在是 Edge/Chrome `--app` 模式，员工机器要有 Node 并跑 `npm run desktop`。

- 方案：Electron 或 Tauri 壳，内嵌 Node 运行时（或随包携带 node 二进制），启动时做 `launch.mjs` 现在做的事
  （确保内核 → profile → bundle → 起 dsh → 打开窗口）
- 内核仍用 `install-kernel.mjs` 装到用户目录（首次联网），或把打好补丁的前缀直接打进安装包（离线可装，
  包体大一些）——建议后者，公司内网未必能访问 npm registry
- 切入点：`scripts/launch.mjs`（启动编排逻辑都在这）、`scripts/install-kernel.mjs`
- 验收：一台没有 Node 的 Windows 机器双击安装 → 登录 → 发一条消息 → 有回复

### 2. 用真实账号跑一次 ChatGPT / Claude 通道

目前只有 DeepSeek 与 Grok 真跑过完整对话。ChatGPT / Claude 的接入流程、目录更新、凭据不外泄在测试里有覆盖，
但没用真实订阅验证过上游协议细节（尤其是 Anthropic 的 messages 格式与流式事件）。

- 切入点：`server/src/channels.js`（通道种类与探测）、`server/src/llm-proxy.js`（请求改写 / 流式透传）
- 验收：设置 → 同事 → 模型通道 接入 → 客户端模型菜单出现分组 → 发消息有流式回复 → 账本有记录

### 3. 服务端从演示级到可部署

- HTTPS：加反向代理（Caddy / Nginx）说明，或服务端直接支持证书；客户端 `gatewayUrl` 已经是任意 URL
- 数据层：现在是 JSON 文件 + JSONL（`server/src/store.js`），单实例。人多之后换 SQLite（`node:sqlite`，
  Node 22+ 自带）最省事；`db.js` / `tasks.js` / `ledger.js` 的读写都经过 `store.js`，从那里换
- 备份：`server/data/` 与公司盘 `server/data/drive/` 的定时备份

### 4. 小项

- 公司技能目录 `_shared/skills/` 根路径已接好（预设补丁 `company-preset-skills-v2`），放一个示例
  `SKILL.md` 并验证 Agent 能列出、能用
- 客户端自动化测试：现在全靠浏览器走查。可以用 Playwright 对 `/desk/api/*` + 页面做几条冒烟
  （登录遮罩 → 登录 → 新会话 → 任务新建 → 提交验收）
- UI 像素级对齐视频（现在是按画面还原，不是逐像素）
- `launch.mjs` 里 `install-kernel` 会被跑两次（launch 一次、setup-profile 一次），无害但可以合并

## 注意事项

- 改了 `plugins/desk-ui/src/**` 要重新打包（`npm run build`，或 launch 自动），bundle 不入库
- 改了 `profile/cordis.patch.yml` 后 launch 会自动刷新 profile；改 `plugins/desk-host/lib/**` 要重启客户端进程
- 升内核版本前先读 `scripts/kernel/patches.mjs` 头部说明；`npm run kernel:check` 能告诉你缺哪条
- 测试用 `npm test`，用的是临时数据目录，不碰 `server/data/`
- 演示机上的网关 8790 与客户端 3470 若还在跑，改服务端代码后要重启网关进程
