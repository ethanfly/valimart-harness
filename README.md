# THE DIVA · 企业交付工作台

基于 `@deepseek-ai/dsh`（DeepSeek Harness）内核的**公司内部交付工作台**。内核由本仓库自己安装并打补丁
（`scripts/install-kernel.mjs`），**不依赖任何其他仓库**——克隆这个目录、`npm install`、`npm run dev` 即可。

> 接手先看 [`docs/HANDOFF.md`](docs/HANDOFF.md)（现在在哪、关键决定、下次该干嘛）；过程记录在 [`docs/sessions/`](docs/sessions/)。

- **桌面客户端（THE DIVA）**：左侧「会话 / 任务」双栏，个人与团队工作区，会话页可选模型、切换标准模式、
  `Full access` 权限，输入框「文件」芯片把本机文件放进工作目录并作为 `@` 引用；Agent 在本机执行，
  流式输出。
- **任务卡**：新建 / 列表 / 详情（概览、工作日志），提交信息、交付物（公司盘）、
  四格验收流 `待初审 → 待终审 → 通过 / 退回`，可指定审核人；只说做完了不算完成，必须有交付物。
- **设置**：通用、账号、同事（每人每周模型额度、7 天账本、模型花费、通道接入）、Agent 预设、
  人员（按部门分组、改角色、停用、吊销令牌）、订阅。
- **公司知识库（四层通道）**：① 岗位手册 `_shared/handbook`（全员只读）② 共享经验 `_shared/_memory`
  （六个子层，员工只能追加日志）③ 个人记忆 `_office/<账号>/_memory`（一人一座，跟人走）
  ④ 检索层 `company_knowledge`：开工前问「公司里有没有人做过」→ 谁 / 何时 / 在哪 / 一小段上下文，
  不拷贝别人的会话。Agent 工具与服务端管理页都能用。
- **公司网关（服务端）**：公司账号登录、每台登录设备一枚可即时吊销的网关令牌、模型密钥代理
  （密钥只在服务端，按人记账 / 限额）、按人隔离的公司盘、任务与验收流持久化、
  管理页 `/admin`（状态 / 公司盘 / 模型通道 / 知识库查询）。

```
company-desk/
├─ server/                 # 公司网关（Node.js，无第三方依赖）
│  ├─ config.json          # 默认配置：账号种子、额度、上游模型、通道目录
│  ├─ src/                 # http 路由 / 登录令牌 / LLM 代理 / 账本 / 任务 / 公司盘 / 通道
│  └─ test/gateway.test.js # 端到端测试（node --test）
├─ plugins/
│  ├─ desk-host/           # dsh 宿主插件：网关登录态、模型路由、公司盘镜像、任务工具、/desk/api
│  └─ desk-ui/             # dsh 浏览器端插件：THE DIVA 外壳、侧栏、任务页、设置页、登录遮罩
├─ profile/cordis.patch.yml# dsh "desk" profile 补丁层（关官方外壳、插公司插件、默认全访问）
└─ scripts/
   ├─ kernel/
   │  ├─ pin.json          # 内核锁定版本（@deepseek-ai/dsh@0.1.1-rc.2）
   │  ├─ patches.mjs       # 内置的公司内核补丁集（锚点式编辑，幂等；锚点对不上即失败）
   │  └─ locate.mjs        # 找内核前缀 / 兼容 Windows 与 POSIX 的 npm 目录布局
   ├─ install-kernel.mjs   # npm 装锁定版本的 dsh 到独立前缀并打补丁（npm run kernel / kernel:check）
   ├─ setup-profile.mjs    # 把 profile + 插件装进 ~/.dsh/profiles/desk（先确保内核就位）
   ├─ build-client.mjs     # esbuild 打包 desk-ui 浏览器端
   └─ launch.mjs           # 一条命令拉起 网关(可选) + 客户端 + 桌面窗口（缺内核/profile/bundle 都自动补）
```

## 1. 环境要求

- Windows 10/11（macOS / Linux 也可，桌面窗口靠 Edge / Chrome 应用模式）
- Node.js ≥ 22（开发时用的是 25.x），自带 npm
- 首次安装需要能访问 npm registry（下载内核）；之后离线可用

## 2. 安装

```powershell
cd company-desk
npm install                 # 只有 esbuild 一个开发依赖
npm run setup               # ① 装内核 ② 安装 desk profile 到 ~/.dsh/profiles/desk（launch.mjs 缺了也会自动补）
npm run build               # 打包 desk-ui 浏览器端（launch.mjs 发现源码更新会自动重打）
```

### 内核（自带，不依赖别的仓库）

`npm run setup`（或第一次 `npm run dev`）会执行 `scripts/install-kernel.mjs`：

1. `npm install -g @deepseek-ai/dsh@<pin> --prefix ~/.company-desk/kernel` —— 装进**独立前缀**，
   绝不碰全局 npm / `~/.local` / node 自己的目录（脚本会拒绝这些路径）；
2. 对该前缀应用 `scripts/kernel/patches.mjs` 里的 16 处公司补丁（见下表），每处在文件尾留 mark，
   再跑只补缺的，`node --check` 保证语法；
3. 写 `<前缀>/.company-desk-kernel.json` 戳记。

```powershell
npm run kernel:check        # 只检查：版本对不对、16 处补丁齐不齐（退出码 0/1）
npm run kernel              # 幂等：缺什么补什么
node scripts/install-kernel.mjs --force   # 重新 npm 安装再打补丁
```

前缀可用 `--prefix` / `DESK_KERNEL_PREFIX` 指定；旧机器上 `~/.tdh-coding-prefix` 里若已有内核会直接复用。
换内核版本只改 `scripts/kernel/pin.json`——补丁锚点对不上会硬失败并指出哪一条，逼着重审那条补丁，
而不是悄悄半套用。

| mark | 包 / 文件 | 一句话 |
|---|---|---|
| `company-sandbox-local-unc-v1` | `dsh-sandbox-local` | 拒绝把 UNC 路径当 `workspace-write` 根；ACL 授权失败给出诊断 |
| `company-skill-custom-trusted-v1` / `-get-custom-trusted-v1` | `dsh-skill-filesystem` | 公司技能目录走 Node fs 读取（列表与读取都行） |
| `company-skill-root-eacces-v1` | `dsh-skill-filesystem` | 一个根 EACCES 只当空，不拖垮整个技能提供者 |
| `company-fs-unc-acl-v1` / `-unc-replace-v1` | `dsh-fs-local` | 公司 SMB 上跳过 DACL 复制与 `ReplaceFileW`，改 rename |
| `company-goal-resume-armed-v1` | `dsh-goal` | 重复 resume 已激活的 goal 视为 no-op，不中断回合 |
| `company-win-junction-mklink-v3` / `-v4` | `dsh-app-boot` | Windows 用 `mklink /J`（无需开发者模式），cwd 固定为 SystemRoot |
| `company-glob-missing-root-v1` | `dsh-tool-fs-search` | rg 搜索根不存在 → 空结果而非硬失败 |
| `company-session-smbfs-rename-v1` | `dsh-session-persistence-jsonl` | 会话落盘 `link` ENOTSUP 时回退 rename；吞目录 fsync 的 ENOTSUP |
| `company-preset-skills-v2` | 预设 `standard` | 技能根只看公司盘 `_shared/skills` 的本机镜像（`~/.dsh/desk/drive/_shared/skills`） |
| `company-preset-web-fetch-v2` | 预设 `standard` / `code` | 会话开 `web_fetch`，放宽超时 |
| `company-preset-instr-root-v1` | 预设 `standard` / `code` | 指令文件项目根标记 `.company-root`，不往上翻到 `$HOME` |

把 `SKILL.md` 放进公司盘 `_shared/skills/<名字>/`，同步到每个人后 Agent 即可使用。

### 上游模型密钥（只放服务端）

网关从 **环境变量** 或 `~/.dsh/.credentials.yaml` 读取上游密钥，客户端永远拿不到：

```powershell
$env:DEEPSEEK_API_KEY = "sk-..."        # 或写进 ~/.dsh/.credentials.yaml： DEEPSEEK_API_KEY: sk-...
```

没有任何密钥时，目录里仍有 `mock-echo`（离线演示用）。管理员也可以在客户端
**设置 → 同事 → 模型通道** 里接入 Grok / ChatGPT / Claude 订阅或 OpenAI / Anthropic / DeepSeek key，
凭据写入 `server/data/channels.json`，全员模型目录即时更新。

### 本机覆盖

- `server/config.local.json`：覆盖 `config.json` 任意字段（不入库），例如改端口、公司名、额度。
- 环境变量：`DESK_GATEWAY_HOST` / `DESK_GATEWAY_PORT` / `DESK_GATEWAY_DATA`（网关），
  `DESK_GATEWAY_URL`（客户端指向的网关）、`DESK_PORT`（客户端端口）、`DESK_STATE_DIR`（客户端状态目录）。

## 3. 启动

单机演示（网关 + 客户端 + 桌面窗口，一条命令）：

```powershell
npm run dev                 # = node scripts/launch.mjs --with-server --desktop
```

分开跑：

```powershell
npm run server              # 网关 http://127.0.0.1:8790
npm run client              # 客户端 http://127.0.0.1:3470（浏览器打开）
npm run desktop             # 客户端 + 独立桌面窗口（Edge/Chrome 应用模式，关窗即退出）
```

`launch.mjs` 参数：`--port <n>`、`--gateway <url>`、`--no-open`、`--prefix <dir>`、`--dsh-home <dir>`、
`--with-server`、`--desktop`。

### 种子账号（`server/config.json`）

| 账号 | 密码 | 角色 / 部门 |
| --- | --- | --- |
| `boss` | `boss123456` | 管理员 · 管理层 |
| `boss-b` | `boss123456` | 管理员 · 管理层 |
| `director` | `director123` | 总监 · 内容部 |
| `emp-a` / `mingan` | `emp123456` | 员工 · 内容部 |
| `zhangzhang111999` / `quan` | `emp123456` | 员工 · 电商部 |
| `xiaoman` | `emp123456` | 员工 · 设计部 |

首次打开客户端会出现登录遮罩，用公司账号登录；登录后本机拿到一枚网关令牌（`~/.dsh/desk/desk-state.json`），
所有模型请求都经 `desk-gateway-<厂商> → http://127.0.0.1:8790/v1` 代理并按人记账；
模型菜单按厂商分组（DeepSeek / Grok / …），管理员在网关上接入或断开通道后，全员客户端在一个心跳内自动重写路由。

令牌规则：

- 令牌绑定「这次登录的这台电脑」。换电脑登录不会把上一台踢下线；网页管理页登录不签令牌，也不影响桌面端。
- 登出只收回本机令牌；管理员「吊销令牌」/「停用账号」一次收回这个人所有电脑上的令牌，
  对方的模型请求立刻 401，客户端在下一次心跳弹回登录遮罩并说明原因。
- 「个人」工作区一人一座：同一台电脑换人登录，前一个人的「个人」格子会从列表收起
  （目录与会话日志保留，那个人再登录时自动挂回）。

### 服务端管理页

浏览器打开 `http://127.0.0.1:8790/admin`，用管理员 / 总监账号登录（员工不可用）：
网关状态（人数 / 在线 / 有效令牌 / 7 天成本）、公司盘三区统计、模型通道、
知识库查询（同 `company_knowledge`，输入关键词得到「谁 / 何时 / 在哪」）、知识·工具合集。

## 4. 走一遍视频里的流程

1. **登录**：遮罩里输入 `boss / boss123456`；左下角显示头像、部门、在线状态。
2. **会话**：侧栏「会话」Tab → 团队工作区「新会话」→ 选模型（DeepSeek V4 Pro / Flash、
   接入的 Grok 等）→ 「文件」芯片选本机文件，文件落到 `<工作目录>/_attachments/`，草稿里出现 `@文件名` 芯片 →
   发送，Agent 在本机流式执行（读文件 / 跑命令 / 写交付物）。会话标题由模型自动生成。
3. **任务**：侧栏「任务」Tab → 新建任务（标题、任务内容 / 验收标准）→ 「打开进程」为任务在公司盘
   `projects/inbox/<任务ID>/` 建工作格子并开会话；Agent 通过 `desk:task` 工具更新提交信息 / 日志 / 交付物，
   窗口产物可一键附带到任务卡 → 选审核人「提交验收」进入 `待审` → 审核人「初审通过」进入 `待终审` →
   管理员「终审通过」或「驳回」（驳回后可修改再提交）。四格验收条随状态推进，工作日志记录每一步；
   交付物可直接打开公司盘路径。
4. **设置 → 同事**：每人本周额度、已用金额、7 天账本按人 / 按模型汇总、模型通道接入与断开。
5. **设置 → 人员**：按部门分组，改角色、停用、吊销令牌（对方下一次请求即 401 并被登出）。
6. **设置 → 订阅**：套餐、席位、各通道状态。
7. **四层通道**：团队工作区新会话问「公司里有没有人做过 ×××？谁做的、什么时候、放在哪？」→
   Agent 调 `company_knowledge` 检索，再用 `company_task_read` / `company_memory_read` 读任务卡与手册，
   回答谁 / 何时 / 在哪，并说明知识库分几层、先看哪层。

### 运行证据（`docs/evidence/`）

| 文件 | 对应视频画面 |
| --- | --- |
| `00-home-hero.png` | 首页：THE DIVA 字标、个人 / 团队工作区、模型 · 标准模式 · Full access · 文件 |
| `01-login-mask.png` | 公司账号登录遮罩 |
| `02-session-agent-reply.png` | 会话页流式回复（本机 Agent） |
| `03-task-new.png` → `06-task-approved.png` | 新建任务 → 打开进程 → 审核人初审 → 终审通过 |
| `07-model-picker-grouped.png` | 模型菜单按厂商分组（DeepSeek / Grok） |
| `08-settings-subscription.png` | 订阅：套餐 / 席位 / 通道表 |
| `09-settings-colleagues.png` | 同事：每人额度、7 天账本、模型通道 |
| `10-settings-people.png` | 人员：按部门分组、改角色、停用、吊销令牌 |
| `11-task-overview-with-process.png` | 任务概览 + 右侧任务进程列 |
| `12-task-worklog-sessions.png` | 工作日志 + 关联进程（+ 关联 / 撤销） |
| `13-server-admin.png`、`14-server-admin-knowledge-search.png` | 服务端管理页与知识库查询 |
| `15-knowledge-session-toolcalls.png` | Agent 调 `company_knowledge` / `company_task_read` |
| `16-knowledge-session-result.png` | 检索结果：谁做的 / 什么时候 / 放在哪 / 状态 |
| `17-knowledge-session-four-layers.png` | 「企业知识库分四层、先看哪层」 |
| `18-fresh-kernel-install.png` | 全新前缀 + 全新 `DSH_HOME` 用本仓库自带安装器装内核后拉起的客户端（登录、公司盘同步、5 个模型） |

## 5. 测试

```powershell
npm test                    # node --test server/test/*.test.js
```

覆盖：登录 / 令牌 / 吊销即失效、令牌按登录设备绑定（换电脑 / 管理页不打断桌面端，登出只收本机，吊销收全部）、
模型代理与按人记账限额、公司盘按人隔离、任务四格验收流、通道接入 → 全员目录更新 → 凭据不外泄 → 断开即下架、
知识检索（第四层）、关联进程、管理页可达性、周额度 429。

内核安装器的验证方式：`node scripts/install-kernel.mjs --prefix <空目录> --dsh-home <空目录>` 真装一遍
（npm 下载 + 16 处补丁全部 `PATCHED`），再用 `launch.mjs --prefix/--dsh-home` 指向它拉起客户端登录；
打完补丁的 9 个内核文件与旧前缀逐字节一致（只有注释里的出处和技能根路径不同）。

## 6. 数据落盘

- 网关：`server/data/`（`users.json`、`login-sessions.json`、`gateway-tokens.json`、`tasks.json`、
  `usage.jsonl`、`channels.json`）与公司盘 `server/data/drive/`：
  `_shared/`（共享经验、岗位手册，全员只读）、`_office/<账号>/`（个人记忆，仅本人读写）、
  `projects/inbox/<任务ID>/`（任务交付物，相关人可读、提交人可写）。
- 客户端：`~/.dsh/desk/`（`desk-state.json` 登录态与令牌、`drive/` 公司盘本机镜像、
  `produced-index.json` 会话产物索引），会话记录在 `~/.dsh/sessions/`（dsh 原生）。
- 内核：`~/.company-desk/kernel/`（打过补丁的 `@deepseek-ai/dsh`，`.company-desk-kernel.json` 是安装戳记）；
  profile 在 `~/.dsh/profiles/desk/`。删掉这两处再 `npm run setup` 即可重装，不影响会话与登录态。
