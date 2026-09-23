# valimart harness for VS Code

本仓库 [`company-harness`](https://github.com/ethanfly/valimart-harness) 的 VS Code 客户端（目录 `packages/vscode`）。用公司账号登录网关，侧边栏对话，Agent 改当前工作区。安装包见 [Releases](https://github.com/ethanfly/valimart-harness/releases/latest) 的 `valimart-harness-*.vsix`。

## Setup

```bash
npm install
npm run compile
```

Press F5 (`Run Extension`) to open an Extension Development Host.

## Use

1. Start a company-desk gateway (`http://127.0.0.1:8790` by default).
2. Open the **valimart harness** activity-bar view (or command **valimart harness: Open Chat**).
3. The login pane finds the gateway by itself (本机 → 局域网 UDP 广播 → `/health` 网段扫描, same protocol as the desktop client). Pick another one from the list if several are found, or type the URL by hand.
4. Sign in with username and password. The extension stores `sessionToken` and `gatewayToken` only — never upstream model API keys.
5. Type a prompt. The agent calls `POST /v1/chat/completions` with a catalog model id and can read/write/patch workspace files. The current editor file and selection are attached as context.
6. Switch **model** and **思考强度**, watch **剩余额度**, attach **images**, start a **新会话**, switch or rename past sessions, and use the two inline palettes: type **`@`** to reference a workspace file, or **`/`** for commands `/goal`, `/model`, `/effort`, `/new`, `/rename`, `/status`, `/sync`, `/drive`, `/help`。只有这些已知命令会被当作命令；`/src/...` 这类以斜杠开头的普通文本原样发给 Agent。**Enter 发送**，**Ctrl / ⌘ + Enter 换行**。点击 **停止** 可取消当前生成。
7. Open the **任务卡** tab for list/create, 四格验收, deliverables, session bind, submit/review/final。
8. **公司盘**（与桌面客户端同一套镜像）：登录后同步到扩展 `globalStorage/drive/`。命令 **同步公司盘** / **打开公司盘**，斜杠 `/sync` `/drive`。Agent 可用 `read_file` 读 `_shared/…` `_office/…` `projects/…`；写共享走 `company_memory_write`；个人记忆回推网关。

## Tests

```bash
npm test
npm run compile
```

## Package

```bash
npm run package
```

Install the generated `valimart-harness-0.3.1.vsix` in VS Code: **Extensions → … → Install from VSIX…**

## 0.3.1 公司盘本机镜像（对齐桌面客户端）

登录后把可见公司盘拉到 `globalStorage/drive/`：共享经验、手册、个人记忆、任务 inbox。每 30 秒静默同步；个人区本地改动能回推。任务卡写入 `_task-card.md` / `_worklog.md`。Agent 工具补齐 `company_task_submit` / `review` / `final` / `company_tasks` / `company_whoami`。

## 0.3.0 工作台：对照 DeepSeek Harness for VS Code

对照社区项目 [deepseek-harness-for-vscode](https://github.com/skymecode/deepseek-harness-for-vscode)（README.zh-CN）补齐工作台体验。**没有**内嵌 `@deepseek-ai/dsh` 或自带 Node 运行时：模型、额度、公司盘、任务卡仍然只走公司网关。迁过来的是侧边栏工作台交互。

- **可分离工作台**：命令 **valimart harness: 在编辑器区打开工作台**（侧栏标题栏「弹出」）把同一套对话开到编辑器区，可再拖到另一个窗口。快捷键 `Ctrl+Alt+H` / `Cmd+Alt+H` 打开侧栏。
- **完整会话管理**：历史写在扩展 `globalStorage/chats.json`，按公司账号分桶；重启 VS Code 或重新登录同一账号能切回来。顶栏可 **切换 / 新会话 / 重命名 / 删除**；`/rename 标题` 之后不再被自动标题覆盖。图片 dataUrl 不落盘。
- **会话自动命名**：首条用户消息生成单行标题（去 Markdown、超长截断）；手动重命名后锁定。
- **Markdown 流式回复**：公司网关 `stream: true` 时边到边显示；非 SSE 的 JSON 回退仍一次出全文。支持表格、有序列表、代码块一键复制、http(s) 外链，以及可点击的工作区路径（`src/foo.js:12`）。
- **阅读友好的滚动**：上滑查看历史时停止自动跟随，回到底部后恢复。
- **思考过程折叠**：推理内容收进「过程」区；工具次数和停止原因留在同一折叠行，最终结论与改动卡片保持可见。
- **停止生成**：思考条上的「停止」或命令 **valimart harness: 停止生成** 会取消当前 `/v1` 请求，并留下可见收尾（已改动的文件 / 调用过的工具），不抛错、不静默。
- **诊断日志**：命令 **valimart harness: 显示日志** 打开 Output 频道，记录网关请求与耗时；不含令牌或密钥。

未移植（有意保留公司网关边界）：免部署 DSH 运行时、插件中心、官方 Agent Preset、本机 API Key、系统通知、导入 DSH/ChatGPT ZIP。这些能力属于内嵌 Harness，不适用于公司桌面网关。

## 0.2.5 改动预览 + 轮次上限可配置

- **改完文件就能看 diff**：Agent 每次 `write_file` / `apply_patch` 之后，回复下方会出现改动卡片（`路径 +N −M`，新建标「新建」，超大文件标「文件较大」）。点卡片或点工具消息里的文件名，就在 VS Code 里打开**原生左右对照 diff**（左边是改动前，右边是当前文件），不是纯文本贴一份。
  - 同一个文件在一条会话里被改多次时，卡片展示的是**整段会话累计的改动**（最早的 before + 最新的 after）。
  - 改动前的正文只存在扩展内存里（每个文件最多 512 KB），不落盘、不进模型上下文、不发给网关；工具返回给模型的结果仍然只有路径和字节数。
  - 读取类工具（`read_file` / `list_dir`）的文件名点开是直接打开文件。
- **轮次默认不限制**（`设置 → valimart harness`）：

  | 设置 | 默认 | 说明 |
  | --- | --- | --- |
  | `valimartHarness.maxTurns` | `0` | 单轮任务最多几次模型往返；**0 = 不限制**。若设正数（1–500），到上限会收尾汇报而不是静默停止 |
  | `valimartHarness.maxMinutes` | `8` | 单轮任务最长墙钟时间（分钟），1–120 |

  **它是什么**：一次「模型往返」= 发一次 `/v1/chat/completions` + 执行它要求的工具，不是「思考时间」。默认不封顶，模型自己停或点「停止」。需要安全阀时再把 `maxTurns` 设成正数。
  **到上限会发生什么**（仅设了正数时）：不会静默停止——先发一次**不带工具**的收尾请求，让它用中文说清「已完成什么、还差什么、下一步做什么」；收尾也失败就本地兜底列出改动过的文件和调用过的工具。接着发「继续」就能带着上下文往下做。

## 0.2.4 自动发现局域网网关

与桌面客户端（company-desk）**同一套发现协议**，两边找到的是同一批网关：

1. 先探本机 `http://127.0.0.1:8790` 和 `http://localhost:8790` 的 `/health`（开发网关 / Windows 服务）。
2. 再往 UDP `18790` 发 `{product:'valimart-harness', proto:1, type:'hello'}`（单播本机 + 广播 + 组播 `239.255.87.90`），网关回 `type:'here'`，带公司名、可达 URL 列表和 `instanceId`。
3. 前两步都没结果才回退 HTTP `/24` 网段扫描（并发 32、每地址 400ms 超时），且只扫真正的私网网段。

- 登录页一出现就自动找；找到多台列成卡片，当前选中那台高亮，点「自动搜索」强制重扫。结果 30 秒内复用，不会反复扫网段。
- 选中的地址记进本地 `desk-state.json`，下次打开登录页直接填好；**手动改过地址后，发现结果不再覆盖输入框**。
- 协议本身不带账号、令牌或密钥，只广播公司名与 URL；扩展只读未鉴权的 `/health`。
- 择优顺序：本机 → 上次用过 → 同网段（优先真正的私网地址，避开 `198.18/198.19` 这类虚拟网卡段）→ 其余。

## 0.2.3 @ 引用文件 + 输入框改版

- **`@` 引用工作区文件**：输入框里敲 `@` 弹出文件补全面板，按整条路径模糊匹配（文件名前缀 > 文件名包含 > 路径包含 > 子序列），浅层、短路径优先；空查询给最近改动过的文件。`node_modules`、`.git`、`out`、`dist`、`media-fonts` 等目录不进面板。↑↓ 选择、Enter/Tab 插入、Esc 收起，中文输入法组词期间不抢键。
  - 发送时该文件的正文直接内联进**这一轮**请求（单文件 24,000 字符、单轮 8 个文件、合计 96,000 字符封顶，超出部分标注截断），Agent 不再为了看一眼文件去调 `read_file`；系统提示里也写明「正文已随消息给出，别重复读」。
  - 内联正文只进这一轮：气泡里仍只显示你打的那句话，历史重放不会反复带上几十 KB 文件内容。
  - 读不到（不存在、是目录、二进制、越出工作区、没打开文件夹）时在消息流里留一条中文说明，请求照发，让 Agent 自己按需去读。邮箱（`a@b.com`）、裸 `@`、句尾标点都不会被误当成提及。
- **图片按钮与发送按钮不再一大一小**：两个按钮改用同一套 `.icon-btn`（30×30 圆形、同边框同阴影同过渡），换成了图形符号，鼠标悬停有说明；选择器与按钮同高、同一条基线。
- **输入框布局**：正文区随内容自动长高（2～5 行），下方一行「模型 / 思考强度」在左、两个动作按钮在右，最底行是快捷键提示；整块在聚焦时亮起一圈强调描边。≤350px 的窄栏里选择器换行、按钮靠右，不再互相挤压。
- **样式打磨**：面板改为浮层卡片（阴影 + 圆角 + 选中行左侧强调条），标签页改成胶囊，气泡圆角与错误条配色统一，思考指示器缩小并加了分隔虚线、耗时右对齐，滚动条改细。

## 0.2.2 修复

- **首字母是 `/` 就报「没有命令」**：只有 `/goal` `/model` `/effort` `/new` `/status` `/help` 这 6 个已知命令才走命令分支，其余以斜杠开头的输入（`/src/lib/session.js 讲一下`、`/api/users`、`//`、`/123`）原样作为普通消息发给 Agent。斜杠面板在无可匹配命令时改为提示「不是斜杠命令，将作为普通消息发送」；已带参数的已知命令显示用法而不是报错。面板新增键盘操作：↑↓ 选择、Enter/Tab 补全、Esc 收起，中文输入法组词期间不抢键。
- **转半天工具之后停住、没有任何返回**：
  - 回合用尽不再抛错。原来超过 8 轮直接 `throw`，异常贴到界面上又被随后的整屏重绘抹掉，看起来就是「静默停止」。现在默认 16 轮，到上限（或超过 8 分钟墙钟）后改发一次**不带工具**的收尾请求，让模型交代「已完成/还差什么/下一步」；收尾也失败时本地兜底，列出已改动的文件与调用过的工具。
  - 中断错误现在写进会话（transcript）本体再重绘，红色一条留在消息列表里，不会再消失。
  - 回放的 assistant 消息只保留 `role/content/tool_calls`（丢掉 `reasoning_content` 等厂商字段、补齐缺失的 `tool_call_id`），避免第二轮起被上游拒绝；单个工具结果超过 24,000 字符会截断并标注，防止上下文被一次 `read_file` 撑爆。
  - 模型返回空内容时不再产生空气泡；网关返回空 `choices` 明确报错。
  - `/v1/chat/completions` 超时由 120 秒放宽到 300 秒，并在超时文案里写清等待时长；等待期间侧边栏显示「正在载入公司知识 / 模型思考中 · 第 N/16 轮 / 工具 x 已返回」和已用秒数，不再是一个不动的转圈。

## 0.2.0 使用说明

- 在输入框按 **Ctrl+V / ⌘+V** 粘贴截图或复制的图片；支持 PNG、JPEG、WebP、GIF，每次最多 6 张、每张最多 10 MB。预览右上角可移除，纯文本粘贴保持正常。**Ctrl+Enter / ⌘+Enter** 发送。
- 任务卡下拉框选择的是**验收审核人**，显示其他同事的姓名、角色和部门（不限总监）。没有可用人员、名单加载失败会明确提示；不能选择本人。先添加交付物并选择审核人，再提交验收。提交会保存当前填写的任务内容与提交内容，审核按钮按状态和权限显示。
- 顶部额度默认折叠；公司资料状态在「公司知识」中查看。登录、重新打开视图和每次发送前自动读取当前账号可见的手册、团队经验、个人记忆和技能目录，每轮也会检索相关知识（90 秒内连续发送复用上一次结果，点「刷新公司资料」可强制重拉）。单轮最多载入 20 个文件、正文合计 32,000 字符（单文件最多 6,000），优先混合各类资料；其余内容可由 Agent 调用工具按需读取。
- 默认在每次成功回复后，用当前模型整理值得复用的个人经验。没有可复用内容则不写；生成或保存失败会显示「未保存」。这会额外使用模型额度，可在「公司知识」中关闭**自动整理个人记忆**。记忆写入公司盘 `_office/<账号>/_memory/04-reviews/`，换客户端、换电脑仍可加载。
- Agent 可使用 `company_knowledge`、`company_memory_read/list/write`、`company_task_read/log/update/attach`。共享区权限与追加限制由公司网关校验。新会话会解除上一会话的任务绑定，登出会清空当前内存中的公司资料。

对照 `company-harness/plugins/desk-host/lib/index.js`：参考客户端通过本机镜像、系统提示和工具让 Agent 按需沉淀经验，并不保证每轮自动生成记忆。此插件采用网关直接读取并增加回合后的自动整理。插件尚不提供桌面客户端的离线公司盘镜像、跨重启会话历史和独立多进程工作区；上述功能不应被理解为已完整移植桌面内核。

## Additional verification

```bash
npm run test:company
npm run test:ui
npm run test:vscode
```

`test:company` requires the sibling `../company-harness` source and its installed dependencies. It starts its real gateway with temporary data and mock model responses, verifies context injection, memory persistence, permissions, task tools and logout isolation. It fails if only the compatibility stub is available. `test:ui` requires installed Chrome and runs headless with the webview's Content Security Policy, checking paste payloads, reviewer states, the slash palette (普通 `/xxx` 文本按普通消息发送) and 280–800px layouts. `test:vscode` boots a real extension host twice to confirm activation. Screenshots go to `out/evidence/` and are excluded from the VSIX.
