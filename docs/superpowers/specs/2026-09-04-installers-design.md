# 设计：THE DIVA 安装包（客户端 + 服务端）

> 状态：已与用户确认方案（2026-09-04）。对应 `docs/HANDOFF.md` 「下次该干嘛」第 1 项。

## 1. 背景与目标

视频里的 THE DIVA 是独立桌面应用；现在的客户端靠 Edge/Chrome `--app` 模式，员工机器要装 Node 并跑
`npm run desktop`，服务端要 `npm run server`。本设计交付两个 Windows 安装包，**都不依赖目标机器上有
Node / npm / Git**，客户端首次启动**不联网**：

- `THE-DIVA-Setup-<ver>.exe`：桌面客户端，按用户安装（不需要管理员）。
- `THE-DIVA-Gateway-Setup-<ver>.exe`：公司网关，按机器安装（需要管理员），注册为 Windows 服务。

验收（来自 HANDOFF）：一台没有 Node 的 Windows 机器双击安装客户端 → 填网关地址登录 → 发一条消息 → 有回复。

## 2. 范围与非目标

做：上面两个安装包、构建脚本、启动编排、卸载/升级、README 说明、验证 checklist。

不做（v1）：自动更新、代码签名（首次运行会有 SmartScreen 提示，README 写明"更多信息 → 仍要运行"）、
macOS / Linux 包、服务端 HTTPS（归 HANDOFF 第 3 项）、内核 UI 改动。

## 3. 方案决策

| 决定 | 选择 | 为什么 |
|---|---|---|
| 客户端壳 | **Electron**（只做窗口 + 进程编排，不跑业务逻辑） | 独立窗口 / 图标 / 任务栏 / 进程名；纯 npm 依赖，构建机不需要 Rust（Tauri 需要） |
| 内核运行时 | **随包携带 `node.exe`**（从构建机 `process.execPath` 复制，v26.7.0，版本记进 `payload.json`） | 与现在 `npm run desktop` 完全同一运行时，零 ABI 风险；内核里的 koffi / node-pty / sharp / node-addon-require-builtin 都是 N-API 预编译，理论上 Electron 自带 Node 也能跑，但未验证。多 ~28 MB（压缩后）换确定性。同一份 node.exe 也给服务端包用 |
| 内核怎么进包 | **打好补丁的内核前缀打成一个 `kernel.tar` 随包**，首次启动解压到用户目录 | 公司内网未必能到 npm registry（HANDOFF 建议）；单个大文件让 NSIS 安装快很多（否则要落 3 万个小文件）；解压到短路径规避 MAX_PATH（见 §5.3） |
| 内核放哪 | `~/.company-desk/app/kernel`（**不是**开发用的 `~/.company-desk/kernel`） | 开发机上两套互不干扰；升级时整目录换新 |
| dsh profile 名 | `desk-app`（开发用 `desk`） | 同一台机器上开发与安装版并存时不互相改链接。`desk-host` 的状态目录仍是 `$DSH_HOME/desk`，登录态 / 公司盘镜像 / 会话与开发版共用 |
| 服务端安装 | **NSIS 脚本 + `node.exe` + WinSW 注册服务** | `services.msc` 可见可停、崩了自动重启、日志滚动；WinSW（MIT，单 exe，依赖 .NET Framework 4.6.1+，Win10/11/Server 2016+ 自带） |
| NSIS 从哪来 | 复用 electron-builder 下载进缓存的 `makensis.exe`（或 `MAKENSIS` 环境变量） | 不再装一套 NSIS |
| 网关地址 | 登录页现有的「公司网关」输入框；打包时 `--gateway <url>` 可预置默认值 | 客户端模型路由用的是登录时填的地址（`gateway-client.js`），不依赖服务端 `publicUrl` |

## 4. 产物与版本

- 版本号取根 `package.json` 的 `version`，两个包相同；文件名 `THE-DIVA-Setup-<ver>.exe`、`THE-DIVA-Gateway-Setup-<ver>.exe`，输出到 `dist/`。
- 客户端 electron-builder：`appId=team.ethan.thediva`、`productName=THE DIVA`、NSIS `oneClick + perMachine:false + allowElevation:false`，
  桌面与开始菜单快捷方式，卸载项在「应用和功能」。
- 服务端 NSIS：`RequestExecutionLevel admin`，MUI2 页面 欢迎 → 目录 → 安装 → 完成（显示管理页地址与种子管理员账号，
  可勾选"打开管理页"），注册表卸载项 `HKLM\...\Uninstall\TheDivaGateway`。
- 应用图标：仓库提交 `desktop/build/icon.png`（512×512，THE DIVA 字标）与 `icon.ico`（PNG 封装的 ICO，由脚本生成一次）；
  electron-builder 与 NSIS 共用。

## 5. 客户端

### 5.1 安装后布局

```
%LOCALAPPDATA%\Programs\THE DIVA\              ← 安装目录，运行期只读
  THE DIVA.exe                                  Electron
  resources\app.asar                            desktop/main.js、splash.html（很小）
  resources\payload\                            extraResources，不进 asar
    payload.json                                { buildId, version, kernel:{package,version}, node, gatewayUrl }
    runtime\node.exe
    kernel.tar                                  打好 16 处补丁的内核前缀（见 §5.3 修剪）
    plugins\desk-host\  plugins\desk-ui\        desk-ui 含已构建的 lib/client.js
    profile\cordis.patch.yml                    gatewayUrl 已按 --gateway 替换
    scripts\kernel\{patches,locate}.mjs,pin.json  scripts\lib\bootstrap.mjs

~/.company-desk/app/                            ← 运行期可变，按 buildId 整目录换
  state.json                                    { buildId, extractedAt }
  kernel\                                       kernel.tar 解出来 + 技能根已同步 + .company-desk-kernel.json 戳记
  plugins\  profile\  scripts\                  从 payload 复制
  node_modules\@deepseek-ai → junction          → ~/.dsh/profiles/node_modules/@deepseek-ai（dsh 扁平回退目录）
~/.company-desk/logs/desktop.log                bootstrap + 内核 stdout/stderr，5 MB 滚动保留 3 份
~/.dsh/profiles/desk-app/                       manifest + cordis.patch.yml + node_modules/@company-desk/* → junction 到 app/plugins/*
~/.dsh/desk/                                    desk-host 状态（不变：登录态、公司盘镜像、产物索引）
```

### 5.2 启动流程（`desktop/main.js`）

1. `app.requestSingleInstanceLock()`；第二个实例只把已有窗口置前。
2. 显示启动页（无边框 420×260：字标 + 状态行 + 转圈；首次启动提示"首次启动需要解压内核，约半分钟"）。
3. 用 `payload\runtime\node.exe` 跑 `scripts/lib/bootstrap.mjs --packaged --payload <dir> --app-dir ~/.company-desk/app --dsh-home <DSH_HOME>`，
   stdout 逐行 NDJSON `{ step, status, detail }`，Electron 转成启动页状态行。bootstrap 只做准备、不长驻：
   - **app 目录**：`state.json.buildId ≠ payload.json.buildId`（或缺）→ 删 `app/` 重建：`tar.exe -xf kernel.tar -C app/kernel`
     （Windows 10 1803+ 自带 `%WINDIR%\System32\tar.exe`；缺失则报错说明）、复制 plugins / profile / scripts、写 `state.json`。
   - **技能根**：读 `app/kernel/.company-desk-kernel.json`，`skillsDir ≠ <DSH_HOME>/desk/drive/_shared/skills` → 调
     `applyKernelPatches({ kernelRoot, skillsDir })`（16 处 mark 都在，只会同步技能根路径；现有补丁逻辑已支持"路径变了就同步"）
     → 重写戳记。
   - **profile**：`~/.dsh/profiles/desk-app/`：manifest（`file:` 指向 `app/plugins/*`）、`pnpm-workspace.yaml`、复制 patch yml、
     junction `node_modules/@company-desk/*`；跑一次 `node.exe <kernel bin> --profile desk-app --dump-default-config` 让 dsh 自愈扁平回退目录；
     junction `app/node_modules/@deepseek-ai` → 回退目录。仅在 buildId 变化或 profile 缺失时重做。
   - 最后一行 `{ step:"ready", kernelBin, dshHome, profile:"desk-app" }`。
4. 选端口：3470 空闲则用，否则 3471…3479 顺延，再不行随机空闲端口（端口变会让 dsh 页面的 localStorage 偏好重置，README 说明）。
5. `spawn(node.exe, [kernelBin, '--profile','desk-app','--no-open','--port',N], { env:{ ...env, DSH_HOME } })`；轮询 `http://127.0.0.1:N/` 就绪（≤ 60 s）。
6. 主窗口 1280×820、最小 960×640、`autoHideMenuBar`、标题 THE DIVA、图标；`loadURL`；关闭启动页。
   `setWindowOpenHandler` 与 `will-navigate` 离开 `127.0.0.1` 的都交给系统浏览器。F12 切换 DevTools、F5 重载（支持排障）。
7. 主窗口关闭 → `taskkill /pid <kernel> /T /F` → `app.quit()`。内核意外退出 / 就绪超时 / bootstrap 非零退出 → `dialog.showMessageBox`
   （原因 + 日志路径 + 「打开日志目录」按钮）→ 退出，不留子进程。

开发模式：`electron desktop/ --payload build/payload` 走同一条路径，不需要先出安装包。

### 5.3 kernel.tar 的构建与修剪

- 来源：本机 `~/.company-desk/kernel` 版本等于 `pin.json` 且 `missingPatches` 为空 → 直接用；否则 `install-kernel.mjs --prefix build/kernel-stage` 重装（要网络）。
- 复制到 `build/kernel-stage/`，**修剪**只删运行期绝不加载的东西：`*.d.ts`、`*.d.ts.map`、`*.js.map`、`*.cjs.map`、`*.mjs.map`、
  `node-pty/prebuilds/` 里非 `win32-x64` 的平台目录。不删 LICENSE / `.js` / `.node`。修剪后再跑一遍 `missingPatches` 与
  `node --check` 确认 9 个补丁文件完好。
- `tar.exe -cf build/payload/kernel.tar -C build/kernel-stage .`（bsdtar，pax 格式，长文件名无问题）。
- MAX_PATH：内核最长相对路径 193 字符（`.map` / `.d.ts`，修剪后会更短），解到 `C:\Users\<用户>\.company-desk\app\kernel`（~47 字符）
  最长 ~240 < 260。Node 本身访问文件用 `\\?\` 前缀不受 260 限制，只有解压器需要注意；bsdtar 支持长路径。

## 6. 服务端

### 6.1 安装后布局

```
%ProgramFiles%\THE DIVA Gateway\
  runtime\node.exe
  server\src\*.js  server\config.json  server\package.json      不带 data/、test/
  config.local.json                    安装时由 init.js 生成（已存在则不动）
  service\TheDivaGateway.exe           WinSW 改名
  service\TheDivaGateway.xml           init.js 按安装目录渲染：id/name/description、executable=runtime\node.exe、
                                       arguments=server\src\index.js、env DESK_GATEWAY_DATA、workingdirectory、
                                       onfailure restart、log roll-by-size（%ProgramData%\THE DIVA Gateway\logs）
  service\init.js                      安装脚本（见 6.2）
%ProgramData%\THE DIVA Gateway\
  data\                                users / login-sessions / gateway-tokens / tasks / usage / channels / drive
  logs\
```

`config.local.json` 初始内容：`host: "0.0.0.0"`、`port: 8790`、`publicUrl: "http://<COMPUTERNAME>:8790"`、
`dataDir: "<ProgramData>\\THE DIVA Gateway\\data"`。`publicUrl` 只用于管理页显示与 `/api` 信息，不影响客户端路由。
上游密钥仍走现有三条路：管理员在客户端「设置 → 同事 → 模型通道」接入（落 `data/channels.json`）、`config.local.json` 里
`upstreams.<id>.apiKey`、或服务 XML 里加 `<env>`。服务跑在 LocalSystem 下，`~/.dsh/.credentials.yaml` 这条路不可用，README 写明。

### 6.2 安装 / 升级 / 卸载

安装（`installer/gateway.nsi`，NSIS 只做复制与调用，逻辑都在 `init.js` 里便于测试）：

1. 若服务已存在：`TheDivaGateway.exe stop`（忽略失败）。
2. 复制 `runtime\`、`server\`、`service\`。
3. `runtime\node.exe service\init.js "<INSTDIR>"`：建 ProgramData 目录；`config.local.json` 缺失才写；渲染 XML（每次都重写，路径以 INSTDIR 为准）。幂等。
4. `TheDivaGateway.exe uninstall`（忽略失败）→ `install` → `start`。
5. 防火墙：先删同名规则再 `netsh advfirewall firewall add rule name="THE DIVA Gateway" dir=in action=allow protocol=TCP localport=8790`
   （端口改了要手动改规则，README 说明）。
6. 完成页：`http://<COMPUTERNAME>:8790/admin`、种子管理员 `boss / boss123456`（提示尽快改密码）。

升级 = 覆盖安装（同一流程，`config.local.json` 与 ProgramData 不动）。

卸载：stop → uninstall 服务 → 删防火墙规则 → 删安装目录与注册表项；**保留 `%ProgramData%\THE DIVA Gateway`**（凭据、公司盘），
卸载器最后一页说明路径。

## 7. 构建流水线

根 `package.json` 新增：

```
"dist:client":  "node scripts/build-payload.mjs && npm --prefix desktop run dist"
"dist:gateway": "node scripts/build-gateway-installer.mjs"
"dist":         "npm run dist:client && npm run dist:gateway"
```

- `scripts/build-payload.mjs [--gateway <url>] [--kernel-prefix <dir>]`：清空 `build/payload/`；复制 `process.execPath` → `runtime/node.exe`；
  按 §5.3 产出 `kernel.tar`；`build-client.mjs` 后复制 `plugins/`（去掉 `desk-ui/src`）；`profile/cordis.patch.yml` 替换 `gatewayUrl`；
  复制 `scripts/kernel/*`、`scripts/lib/bootstrap.mjs`；写 `payload.json`（`buildId` = 时间戳 + 内核版本 + 内容摘要）。
- `desktop/`：独立 npm 子项目（`package.json` devDeps 仅 `electron`、`electron-builder`；`main.js`、`splash.html`、`electron-builder.yml`、`build/icon.*`）。
  `npm --prefix desktop run dist` = `electron-builder --win nsis --config.extraMetadata.version=<根版本>`，
  `extraResources: [{ from: ../build/payload, to: payload }]`，`compression: normal`，产物到 `../dist/`。
- `scripts/build-gateway-installer.mjs`：暂存 `build/gateway/`（`runtime/node.exe`、`server/{src,config.json,package.json}`、
  `service/{TheDivaGateway.exe(WinSW), init.js}`）；找 `makensis`（`MAKENSIS` 环境变量 → electron-builder 缓存 `%LOCALAPPDATA%\electron-builder\Cache\nsis\*\Bin\makensis.exe` → PATH；
  都没有则报错"先跑 npm run dist:client 或安装 NSIS"）；`makensis /DVERSION=<ver> /DSTAGE=<dir> installer/gateway.nsi` → `dist/`。
- 第三方二进制锁定在 `installer/pins.json`：WinSW（下载 URL + SHA256，缓存到 `build/cache/`）。Electron / electron-builder 工具链下载支持镜像
  `ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR`（README 给 npmmirror 的值）；构建机已缓存 Electron 40.10.2 可作为离线兜底版本。
- `.gitignore` 增加 `build/`、`dist/`、`desktop/node_modules/`、`desktop/dist/`。

## 8. 仓库内代码改动

- **新增 `scripts/lib/bootstrap.mjs`**：把 `launch.mjs` 与 `setup-profile.mjs` 里「确认内核 → profile → 起客户端 → 等就绪」抽成函数
  （`ensureKernel`、`ensureProfile`、`startClient`、`waitHttp`、`findFreePort`），支持两种模式：
  - 开发模式（现状）：内核在 `--prefix`，缺了跑 `install-kernel.mjs`；profile `desk`；插件链接到仓库 `plugins/`。
  - 打包模式（`--packaged`）：§5.2 的流程；profile `desk-app`；永不联网。
  `launch.mjs`、`setup-profile.mjs` 改成薄壳；`ensureProfile` 接收已定位好的内核，不再二次调用 `install-kernel`（消掉 HANDOFF 小项"跑两次"）。
  `npm run dev` / `npm run setup` 的外部行为不变。
- 新增 `desktop/`、`installer/`（`gateway.nsi`、`gateway/init.js`、`gateway/TheDivaGateway.xml.tpl`、`pins.json`）、
  `scripts/build-payload.mjs`、`scripts/build-gateway-installer.mjs`、`scripts/make-icon.mjs`（SVG → PNG/ICO，一次性）。
- 服务端源码不改。README 新增「安装包」一节（构建、镜像、SmartScreen、端口、密钥放哪、卸载保留什么）；HANDOFF 更新。

## 9. 错误处理

| 场景 | 行为 |
|---|---|
| `tar.exe` 不存在 | bootstrap 退出码 2，提示"需要 Windows 10 1803 及以上" |
| 解压 / 复制失败（磁盘满、权限） | 删掉半成品 `app/`，报错带路径 |
| 技能根重打补丁锚点不匹配 | `PATCH_FAIL <code>`，提示重装 |
| 端口全被占 | 报错列出尝试过的端口 |
| 内核 60 s 未就绪 / 意外退出 | 对话框 + 日志路径 + 「打开日志目录」，收干净子进程后退出 |
| 网关不可达 | 不是启动错误：客户端照常打开，登录页显示离线（现有行为） |
| 服务端 `init.js` 失败 | NSIS 显示 stderr 并中止，不注册服务 |

## 10. 验证

- 自动：`npm test` 12/12 不变；新增 `scripts/test/bootstrap.test.mjs`（临时目录：`init.js` 幂等 / 配置不覆盖、`findFreePort`、
  `payload.json` 生成、修剪不会删掉补丁文件）用 `node --test`，加进 `npm test`。
- 本机手动：`npm run dist:client` → 安装 → 任务管理器确认内核进程是 `...\payload\runtime\node.exe`（不是 `D:\service\nodejs`）→ 登录 → 发消息有回复
  → 关窗无残留 → 再开一次（不再解压，秒开）→ 卸载。`npm run dist:gateway` → 安装（需 UAC）→ `services.msc` 运行中 → 客户端填 `http://<本机名>:8790` 登录 → 管理页可开 → 卸载后 ProgramData 仍在。
- 最终验收：另一台没有 Node 的 Windows 机器按 README checklist 走一遍，由用户执行。

## 11. 风险

- **Electron / electron-builder 工具链下载**：网络慢（内核 200 MB 花了 17 分钟）。缓解：镜像变量；本机已有 Electron 40.10.2 缓存。
- **WinSW 在目标机器缺 .NET Framework**：Win10/11/Server 2016+ 自带 4.6.1+；更老的系统不在支持范围。
- **bsdtar 长路径**：实现时用一个刻意很长的基路径实测解压，不行就换 Node 自写 tar 读取器（pax 头，约 100 行）。
- **安装体积**：客户端约 120 MB 安装包 / 约 500 MB 落盘（Electron 110 + node 98 + `kernel.tar` ~150 修剪后 + 解压副本 ~150；
  `kernel.tar` 要留着给换用户 / 修复时重新解压）。内网 / U 盘分发可接受；再省要动内核依赖，v1 不做。
