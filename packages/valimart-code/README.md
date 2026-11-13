# valimart code

**valimart code**（惠利玛）：基于 [Qwen Code 1.0](https://github.com/QwenLM/qwen-code)（v1.0.0-preview.1）二次开发的公司网关终端客户端。界面、Agent、工具、会话沿用 Qwen Code；登录、模型目录、公司盘、任务卡换成公司网关。命令名 `valimart`。

1.0 是 Bun 编译的原生可执行文件：**不用装 Node.js**，解压即用。功能对标 pi 包 [`pi-valimart-desk`](../pi-valimart-desk)：

| 桌面客户端 / pi 包 | valimart code |
| --- | --- |
| 公司账号登录 → 会话令牌 + 网关令牌 | `valimart login`（先找本机 / 局域网网关，没有才手填，密码不回显）；启动时没登录会先要求登录 |
| 局域网发现网关 | 同一套 UDP 18790 协议，另外探一遍本机 pi / Claude 插件 / 桌面客户端记下的网关 |
| provider `valimart`（OpenAI completions） | 1.0 的 `providers.valimart`：`baseUrl` 是网关 `/v1`，`model` 是公司默认模型，思考档位映射到 `capabilities.thinking` |
| 公司默认模型 / 快速推理模型 | 公司默认模型写 `model.name`（用户 `/model` 选过就保留）；快速推理模型写 `providers.valimart.routing.utility` |
| `company_knowledge` 等 14 个 Agent 工具 | 自带 MCP 服务 `desk`（`/mcp` 可见），与 Claude 插件同一套工具 |
| 公司盘镜像 | `~/.valimart/valimart-drive/`（MCP 服务每 30 秒同步，`/desk-sync` 立刻同步） |
| 任务卡四格 | `/desk-tasks`、`/desk-task`、`/desk-task-new`、`/desk-task-submit`、`/desk-task-review`、`/desk-task-final`（Tab 补全任务卡号、审核人） |
| 状态栏「valimart: 姓名」 | 1.0 的 `statusLine`：`valimart 姓名 (账号) @公司 · 模型 · 任务 tk-…` |
| TUI 身份 | 产品名 `Valimart Code`、命令 `valimart`、配置目录 `~/.valimart`（构建期白标，不是运行时改字） |
| 公司交付简报技能 | `company-briefing`（`~/.valimart/skills/`） |

网关令牌只在本机 `~/.valimart/`（登录态 `valimart-desk.json` 与 0600 的 `launch-settings.json` / `settings.json`），上游密钥仍只在网关。

## 安装

两种方式任选其一。装好后都是同一个命令 `valimart`，数据都在 `~/.valimart`，与原版 `qwen` 互不影响。

| 方式 | 适合谁 | 需要 |
| --- | --- | --- |
| A. npm 安装（推荐） | 电脑上已有 Node.js | Node.js ≥ 18；Windows 首次运行要能访问 github.com |
| B. 下载压缩包 | 没装 Node.js，或不想用 npm | 无 |

支持的平台：Windows x64、Linux x64、macOS Apple 芯片（M 系列）。Intel Mac 和 ARM 版 Linux/Windows 暂不支持。

### A. npm 安装

1. 安装：

   ```sh
   npm install -g valimart-code
   ```

   不要加 `--omit=optional`，否则装不上对应平台的程序。

2. 确认装好：

   ```sh
   valimart --version
   ```

   能看到 `valimart-code <版本>（Qwen Code …）` 就成功了。

   **Windows 第一次运行**会先从 GitHub 下载程序（约 76 MB，只下这一次），存到 `%LOCALAPPDATA%\valimart-code\<版本>\`。期间提示「正在下载」，等它结束即可。下载失败会显示原因，通常是连不上 github.com，换个网络重试，或改用方式 B。

3. 升级：`npm install -g valimart-code@latest`。卸载：`npm uninstall -g valimart-code`（Windows 再手动删 `%LOCALAPPDATA%\valimart-code`）。

### B. 下载压缩包

到 GitHub Release [`latest`](https://github.com/ethanfly/valimart-harness/releases/latest)（或介绍页 <https://ethanfly.github.io/valimart-harness/#valimart-code> 的直链）下载对应平台的文件：

| 平台 | 文件 |
| --- | --- |
| Windows x64 | `valimart-code-<版本>-windows-x64.zip` |
| Linux x64 | `valimart-code-<版本>-linux-x64.tar.gz` |
| macOS Apple 芯片 | `valimart-code-<版本>-darwin-arm64.tar.gz` |

下面以版本 `0.2.3` 为例，换成你下载的版本号。

#### Windows（PowerShell）

zip 里直接是 `bin\`、`lib\`，没有外层目录，所以要解压到一个专门的文件夹：

```powershell
$dir = "$env:LOCALAPPDATA\Programs\valimart-code"
Expand-Archive .\valimart-code-0.2.3-windows-x64.zip -DestinationPath $dir -Force
[Environment]::SetEnvironmentVariable('Path', "$dir\bin;" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')
```

**关掉 PowerShell 再打开一个新的**，然后：

```powershell
valimart --version
```

程序没有代码签名，第一次运行如果弹出 SmartScreen「已保护你的电脑」，点「更多信息」→「仍要运行」。

#### Linux / macOS

压缩包里有一层 `valimart-code/` 目录。解压到固定位置，再把它的 `bin` 加进 `PATH`：

```sh
mkdir -p ~/.local/opt
tar -xzf valimart-code-0.2.3-linux-x64.tar.gz -C ~/.local/opt      # macOS 换成 darwin-arm64 的文件
echo 'export PATH="$HOME/.local/opt/valimart-code/bin:$PATH"' >> ~/.bashrc   # zsh 用户写到 ~/.zshrc
source ~/.bashrc                                                     # 或重开终端
valimart --version
```

不要用 `ln -s` 把 `bin/valimart` 软链到别处：入口脚本按自身所在目录找 `valimart-host`，软链后会找不到。

macOS 版是临时（ad-hoc）签名，没有 Apple 开发者证书，从网上下载的文件会被标记隔离，第一次运行前先去掉标记，否则会提示「无法验证开发者」：

```sh
xattr -dr com.apple.quarantine ~/.local/opt/valimart-code
```

#### 升级与卸载

- 升级：下载新版，按上面同样的命令解压到同一位置覆盖。
- 卸载：删掉解压目录（Windows 的 `%LOCALAPPDATA%\Programs\valimart-code`，Linux/macOS 的 `~/.local/opt/valimart-code`），再把 `PATH` 里那一项去掉。

两种方式升级、卸载都不会动 `~/.valimart`（登录态、公司盘镜像、会话）。要彻底清除就把它也删掉。

### 装好之后

1. 确认公司网关已经在跑（向管理员要地址，例如 `http://192.168.1.10:8790`）。
2. 登录：`valimart login`。它会先自动找局域网里的网关，找不到再让你填地址，然后输入公司账号和密码。
3. 启动：在项目目录里运行 `valimart`。第一次进某个目录会问是否信任这个文件夹，选信任才能读写文件。

### 常见问题

| 现象 | 处理 |
| --- | --- |
| `valimart: command not found` / 不是内部或外部命令 | `PATH` 没生效：重开终端；方式 B 检查 `PATH` 里是否有 `…/valimart-code/bin` |
| 提示「没有装上 valimart-code-<平台>」 | npm 漏装了平台包：`npm install -g valimart-code` 重装，别加 `--omit=optional` |
| 提示「没有 xxx 的安装包」 | 当前系统或芯片不在支持列表里，见上面的平台说明 |
| Windows 首次运行下载失败（HTTP 4xx/5xx 或超时） | 连不上 github.com：换网络重试，或改用方式 B |
| 启动后要求登录 | 还没登录或登录已过期：`/quit` 退出，运行 `valimart login`，再 `valimart --resume` 接着聊 |

## 使用

1. 公司网关已在跑（默认 `http://127.0.0.1:8790`）。
2. `valimart login`：选网关 → 公司账号 → 密码。命令行给了的项不再问：`valimart login http://192.168.1.10:8790 emp-a`。
3. `valimart` 进 TUI；`valimart -p "…"` 非交互。其余参数同 Qwen Code（`--resume`、`--yolo`、`mcp`、`plugins` …）。
4. 会话里：
   - `/desk-status`：账号、额度、模型目录、公司盘、绑定的任务卡
   - `/desk-sync`：立刻同步公司盘
   - `/desk-tasks [状态]`、`/desk-task [任务ID|off]`、`/desk-task-new <标题> [@账号]`
   - `/desk-task-submit <审核人账号>`、`/desk-task-review pass|reject [意见]`、`/desk-task-final pass|reject [意见]`
   - `/desk-discover [地址]`、`/desk-login`、`/desk-logout`
   - Agent 工具 `company_*` 由 MCP 服务 `desk` 提供，工具调用照 Qwen Code 的审批模式确认
   - `/auth`、`/logout` 改成了公司网关提示；Qwen / Qoder 账号登录在这里关掉

终端子命令：

```text
valimart login [网关地址] [账号]   登录（非交互：设置 DESK_GATEWAY_URL / DESK_GATEWAY_USER / DESK_GATEWAY_PASSWORD）
valimart logout                     登出
valimart status                     登录态、额度、模型目录、公司盘
valimart discover                   找公司网关
valimart sync                       同步公司盘镜像
```

登录或令牌是启动时注入的：会话里 `/desk-login` 之后要 `/quit` 再 `valimart`（`--resume` 接着聊）。网关回 401 时同样处理。

## 和原版 Qwen Code 的区别

- 产品名 / 命令名 / 配置目录 / 环境变量前缀全用构建期白标（`BRAND_*`）：`Valimart Code`、`valimart`、`~/.valimart`、`VALIMART_`。
- 默认登录类型改成 `openai`（公司网关 provider）；`/auth`、`/logout` 换成提示，不提供 Qwen / Qoder 账号登录。
- 关掉使用统计（`privacy.usageStatisticsEnabled`）与自动更新（`general.enableAutoUpdate`）。
- 每次启动按登录态重写 `~/.valimart/launch-settings.json`，用 `--settings` 注入（provider、desk MCP、SessionStart hook、状态栏、遥测开关）。

## 目录

```text
valimart-code/
  bin/valimart        入口（sh；Windows 用 valimart.cmd）
  bin/valimart-host   白标宿主（原 Qwen Code，Bun 编译）
  lib/lib/            启动器、网关客户端、公司盘、任务卡、/desk-* 命令
  lib/runtime/        入口、desk MCP、SessionStart hook、状态栏
~/.valimart/
  valimart-desk.json     登录态（会话令牌 + 网关令牌）
  valimart-drive/        公司盘镜像
  launch-settings.json   启动器生成的 --settings（含网关 provider 与 desk MCP）
  settings.json          Qwen Code 用户设置（/model 选择等，启动器只改 providers）
  skills/company-briefing/  随包技能（valimart 管理，别手改）
  …                      其余是 Qwen Code 的会话、历史等
```

环境变量：`VALIMART_HOME`（根目录，默认 `~/.valimart`）、`DESK_GATEWAY_URL` / `DESK_GATEWAY_USER` / `DESK_GATEWAY_PASSWORD`（非交互登录）、`VALIMART_DRIVE_SYNC_MS`（公司盘后台同步间隔，0 关掉）。

## 开发

不克隆上游。`pin.json` 锁定 [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) 的 tag、commit 与源码 tarball sha256；构建时取源码、打锚点补丁、白标、用 Bun 编出原生宿主，再和启动器一起归档。和 dsh 内核补丁同一套规矩。

```powershell
npm install                 # 仓库根
bun install -g bun@1.4.2    # 与上游 .bun-version 一致（本机 1.4.4 也能编，产物内嵌运行时不同）
npm run dist:valimart-code  # → dist/valimart-code-<版本>-<平台>.tar.gz|.zip（中间产物 build/valimart-code/）
node --test packages/valimart-code/test/patches.test.mjs
```

- `lib/`：登录态、网关客户端、发现、公司盘镜像、`company_*` 工具、模型目录映射、启动设置、启动器、斜杠命令
- `runtime/`：入口包装要跑的启动器入口（`valimart.mjs`）、`desk-mcp.mjs`、`session-context.mjs`、`statusline.mjs`、`commands.mjs`
- `scripts/patches.mjs`：对 1.0 源码的锚点补丁（白标 env、`/desk-*` 注入、`/auth` 提示、默认登录类型）
- `scripts/build.mjs`：取源码 → 补丁 → npm ci → bun 编译 → 归档

平台：原生依赖（node-pty / sharp / ripgrep）只能装宿主平台的预编译，所以**每个平台在自己的 runner 上编**（release.yml 的三平台 matrix），不要交叉编译。

升级 Qwen Code：改 `pin.json`（tag / version / commit，`sourceSha256` 留空会自动回填），跑构建。锚点对不上会硬失败，按新源码重审 `scripts/patches.mjs`，再用新版本冒烟一遍 TUI。
