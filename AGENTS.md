# AGENTS.md

企业交付工作台 **valimart harness**（npm 包名仍是 `company-desk`）。公司网关 + Electron 桌面客户端 + pi CLI 包 + VS Code 插件，内核是外部依赖 `@deepseek-ai/dsh`（由本仓库安装并打公司补丁，不需要克隆上游）。

- 需求与运行方式见 `README.md`（详尽，中文）。
- **交接状态、当前在哪、下次该干嘛、以及大量「关键决定 / 别轻易推翻」的清单在 `docs/HANDOFF.md`**——改代码前先读它，尤其是顶部最近的日期段。
- 过程记录按会话落在 `docs/sessions/`；设计与计划在 `docs/superpowers/{specs,plans}/`。

## 环境与命令

Node.js ≥ 22（建议 25.x）。安装脚本与内核补丁大量使用 Node 内置能力（`node:sqlite`、`node --test`），无运行时第三方依赖。

**Shell 是 Windows PowerShell 5.1**：不支持 `&&`，用 `;`。含中文的提交信息用 `git commit -F <UTF-8 无 BOM 文件>`，不要直接 `-m`。

```powershell
npm install                       # esbuild / playwright / mdast
npm run setup                     # 装锁定内核到 ~/.company-desk/kernel 并打补丁
npm run dev                       # 网关 :8790 + 客户端 :3470 + 桌面窗口
npm run server                    # 只起网关 http://127.0.0.1:8790（管理页 /admin）
npm run client                    # 只起内核 Web（浏览器 http://127.0.0.1:3470）
npm run build                     # 打包 desk-ui 浏览器 bundle（改 src/ 后必须重打）
npm test                          # node --test 服务端 + 脚本 + pi 包
npm run test:e2e                  # Playwright（默认用本机 Edge）
```

其他常用：`npm run desktop`、`npm run dist:client`、`npm run dist:gateway`、`npm run dist`、`npm run dist:client:mac`、`npm run dist:vscode`、`npm run kernel:check`、`npm run probe:channels`、`npm run backup -- ...`。

开发种子账号（仅源码 `server/config.json`，安装版不播种演示用户）：`boss/boss123456`（管理员）、`director/director123`、`emp-a/emp123456`。

## 架构与数据流

```
Electron 壳 (desktop/) / 浏览器 :3470
   │  登录令牌 · 会话 · 任务 · 公司盘镜像
   ▼
公司网关 (server/ Node :8790)  ← 上游密钥、账本、任务卡、公司盘只在这里
   │
   ▼
上游模型 / 生图 / 搜索 (DeepSeek · Grok · ChatGPT · 通义 · AnySearch …)
```

- `server/src/index.js` 是网关组装入口：`createGateway(overrides)` 构建 `Db`/`Ledger`/`Drive`/`Tasks`/`LlmProxy`/`Channels`/`Knowledge` 等，然后 `registerApi` + `registerAdminPage` 挂路由。测试通过 `overrides` 注入 mock 上游、`port: 0`、临时 `dataDir`。
- 业务接口在 `server/src/api.js`（`/api/*`，Bearer 令牌），模型代理在 `server/src/llm-proxy.js`（`/v1/*`）。`http.js` 是自写的路由/JSON/错误助手（`HttpError`、`sendJson`、`readBody`）。
- 持久化默认 SQLite（`node:sqlite`，见 `store.js`），`DESK_GATEWAY_STORE=json` 回退；集合接口统一 `load/save/update/append`。首次打开空库时把同目录遗留 `*.json` 迁入，旧文件不删。
- 本机 host 插件 `plugins/desk-host`：登录网关、把网关注册成模型路由、`/desk/api/*` 本机接口、公司盘镜像、Agent 工具（`company_memory_*` / `company_task_*`）、Mixed 混合模式、内核/客户端更新。`plugins/desk-ui` 是浏览器外壳；`plugins/desk-image` 走网关生图。
- dsh profile 补丁层 `profile/cordis.patch.yml`：关官方外壳与直连适配器、插公司三个插件、默认权限预设 `danger-full-access`。`setup-profile.mjs` 会把它复制到 `$DSH_HOME/profiles/desk/cordis.patch.yml`。
- `scripts/lib/bootstrap.mjs` 是开发启动与安装版首次解压的共用编排库；`scripts/launch.mjs` 是开发启动器；`desktop/main.js` 是 Electron 主进程。两者都调用 bootstrap，改动影响面大。

## 内核（@deepseek-ai/dsh）—— 最高风险区

- 锁定版本在 `scripts/kernel/pin.json`（只改这里）。补丁锚点是按该版本源码写的。
- `scripts/kernel/patches.mjs` **锚点式编辑**，不是整文件覆盖：`from` 片段必须恰好命中 1 次，否则硬失败。升内核时锚点对不上**必须人工重审补丁**，不要用整文件覆盖绕过。补丁幂等（按 mark 跳过）。
- `npm run kernel:check` 报告缺哪条补丁。`kernel:discover` → `kernel:prepare` → 管理页发布是公司门禁更新流程；客户端下次启动才切换。
- 补丁里同时保留旧/新 `variants`（如 0.1.5 / 0.1.7 签名），恰好命中一条才套用。
- 第三方插件（`@anweat/dsh-browser`、`@anysearch/anysearch-dsh`）随内核前缀离线分发，见 `pin.json` 的 `profilePlugins`（带 `prune` 白名单）。内核按 peer 范围跳过不兼容 bundle，豁免写进 profile 本地 `compatibility.json`。
- 内核 tar 很大（0.1.7 起自带 LibreOffice 包），网关分发件用 gzip；上传限额在 `server/src/api.js`。

## profile 与路径约定

两套并存、故意共用登录态：

| | 开发版 | 安装版 |
|---|---|---|
| profile 名 | `desk` | `desk-app` |
| 内核前缀 | `~/.company-desk/kernel` | `~/.company-desk/app/kernel` |

共用 `~/.dsh/desk`（登录令牌、公司盘镜像）与 `~/.dsh/sessions`。安装版 Electron userData 在 `~/.company-desk/app/electron`；网关数据在 `%ProgramData%\valimart harness Gateway\data`（`DESK_GATEWAY_DATA` 注入）。

## 关键 gotcha

- **改了 `plugins/desk-ui/src/**` 必须 `npm run build`**（bundle `plugins/desk-ui/lib/client.js` 是生成物、不入库）。`launch.mjs` 发现源码更新会自动重打。改 `plugins/desk-host/lib/**` 需重启客户端进程。
- **`preparePackaged` 用例依赖 `build/payload/kernel.tar`，没有会 skip**——别把 skip 当通过。全量测试的 `TEMP`/`TMP` 要设在仓库外（如 `E:/orcaWorkspace/dsh-test-temp`），否则「非 Git 工作区」测试会误探测到仓库父级 `.git`。
- `npm test` 用临时数据目录，不碰 `server/data/`。`server/data/`、`server/config.local.json`、`deploy/raspberry-pi/subscriptions.yaml` 含凭据，**绝不入库**。
- 安装版数据与开发版共用 `~/.dsh/desk`；在开发机测安装版时看到已登录 / 有账号预填是正常的。
- 网关令牌绑「登录会话 = 一台电脑」，不是一人一枚；管理页登录不签桌面令牌。改动涉及登录/吊销时看 `docs/HANDOFF.md` 的「关键决定」表。
- 改 `server/src/**` 后已启动的网关进程要重启（`launch.mjs` 不会热重载）。
- 打安装包：改了 `scripts/lib/bootstrap.mjs`、`scripts/kernel/*`、`plugins/**`、`profile/cordis.patch.yml` 要重跑 `dist:client`；改了 `server/src/**`、`server/config.json`、`installer/**` 要重跑 `dist:gateway`。
- 装 Electron 用 `npm --prefix desktop install`（**不要**加 `--allow-scripts=electron`，npm 11.19 报 EALLOWSCRIPTS）。
- `npm run dist:gateway` 依赖 electron-builder 缓存里的 makensis：先跑过一次 `dist:client`，或设 `MAKENSIS`。
- macOS 包**不要**用 electron-builder `--mac`（Windows 上直接拒绝且 7z 会毁 `.app` 链接/可执行位），走 `npm run dist:client:mac`。
- 构建机网络打不开 GitHub 时脚本默认走 npmmirror；Electron/electron-builder 二进制镜像同理。
- 本仓库注释和文档主要是中文；保持与周边一致的中文注释/文案。

## 测试写法

- `node --test`，用临时数据目录 + mock 上游，不依赖网络（见 `server/test/gateway.test.js` 的 `createGateway` overrides 模式）。
- 服务端测试在 `server/test/*.test.js`，脚本在 `scripts/test/*.test.mjs`，pi 包在 `packages/pi-valimart-desk/test/*.test.mjs`，一起被根 `npm test` 跑。
- e2e 在 `e2e/*.spec.js`（Playwright，`config` 默认本机 `msedge`，workers 1）。完整内核桌面页要先设 `DESK_SMOKE_URL=http://127.0.0.1:3470`。
- pi 包单测在 `packages/pi-valimart-desk`；VS Code 插件测试独立：`npm --prefix packages/vscode test`。

## 改完自检

1. 跑相关 `npm test`；涉及 UI/Bundle 时 `npm run build`。
2. 涉及内核补丁时 `npm run kernel:check`。
3. 更新 `docs/HANDOFF.md`（活文档，每次会话结束更新）并在 `docs/sessions/` 追加过程记录。
