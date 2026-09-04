# 设计：THE DIVA 安装包（客户端 + 服务端）

> 状态：已与用户确认方案并**实现完成**（2026-09-04，提交 `ba2d0b6..4f016a2`，计划 `docs/superpowers/plans/2026-09-04-installers.md`）。
> 对应 `docs/HANDOFF.md` 「下次该干嘛」第 1 项。正文已按实际实现校正；与最初设计不同的地方在 §0 汇总并在原处标 ⚠。使用说明见 README §2.5。

## 0. 实现后与原设计的差异（2026-09-04）

| 原设计 | 实际 | 原因 / 裁定 |
|---|---|---|
| 客户端装到 `%LOCALAPPDATA%\Programs\THE DIVA` | `%LOCALAPPDATA%\Programs\the-diva-desktop`（`desktop/package.json` 的 `name`） | electron-builder 26 在 oneClick + 按用户模式下有意用包名作目录，yml 无选项可改；快捷方式 / 卸载项 / 窗口标题仍是「THE DIVA」，接受不改 |
| 安装 Electron：`npm --prefix desktop install --allow-scripts=electron` | `npm --prefix desktop install` | npm 11.19 上该 flag 报 `EALLOWSCRIPTS`（项目内不允许）；Electron 44.1.1 没有 postinstall，二进制首次 `electron .` / electron-builder 时惰性下载 |
| Electron 40.10.2 缓存作离线兜底 | Electron 44.1.1 + electron-builder 26.15.3；GitHub 直连下载失败，走 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`（npmmirror），`build-client-installer.mjs` 未设置时默认之 | 这个网络到 GitHub Releases 的 HTTP/2 流会被掐 |
| `dist:client` = `build-payload.mjs && npm --prefix desktop run dist` | `build-payload.mjs && node scripts/build-client-installer.mjs`（包一层：传根版本号 `--config.extraMetadata.version`、默认镜像、`CSC_IDENTITY_AUTO_DISCOVERY=false`、校验产物） | 版本号与镜像逻辑放脚本里，`desktop/package.json` 的 `dist` 仅供手动调试 |
| makensis 在 `%LOCALAPPDATA%\electron-builder\Cache\nsis\*\Bin\makensis.exe` | `Cache\nsis-<ver>\nsis-<ver>-<随机后缀>\Bin\makensis.exe`（同级还有个 2.5 KB 的壳 `makensis.exe`，不能用）；`findMakensis()` 遍历，`MAKENSIS` 环境变量优先 | 缓存布局与设想不同 |
| Electron userData 默认位置（`%APPDATA%\THE DIVA`） | `~/.company-desk/app/electron`（`app.setPath('userData' / 'sessionData')`，在单实例锁之前） | 守住「客户端运行期状态只在 `~/.company-desk/{app,logs}` 与 `~/.dsh`」 |
| bootstrap 重新解压时删整个 `app/` 重建 | 只删自己创建的六个条目 `kernel plugins profile scripts node_modules state.json`；内核 `package.json` / bin 缺失也触发重解压 | `--app-dir` 误指到有用目录（如 `~/.company-desk`）时不能连开发内核、日志一起删 |
| `ready` 行 `{ step, kernelBin, dshHome, profile }` | `{ step:'ready', status:'ok', kernelBin, kernelRoot, kernelVersion, profileName, appDir, buildId, nodeExe }` | Electron 端只用 `kernelBin` / `profileName`，其余进日志 |
| 网关 `config.local.json` 在安装目录根；脚本叫 `init.js`，放 `service\init.js` | `server\config.local.json`（`server/src/config.js` 只认 `server/` 下的）；`installer/gateway/init.mjs`，安装到 `service\init.mjs`；另生成 `server\package.json`（`type: module`） | 与服务端配置加载逻辑对齐；仓库是 ESM |
| 上游密钥第三条路「服务 XML 里加 `<env>`」 | 机器级环境变量（变量名 = `config.json` 里该上游的 `apiKeyEnv`，如 `DEEPSEEK_API_KEY`，`setx /M` 后重启服务） | XML 每次安装 / 升级由 `init.mjs` 重生成，手改会丢 |
| 卸载「删安装目录」 | 只删 `runtime\ server\ service\ README.txt Uninstall.exe`，最后非递归 `RMDir $INSTDIR` | `RMDir /r $INSTDIR` 在用户选了已有目录时会整个清空（NSIS 文档点名的危险写法） |
| 静默安装未提 | 客户端 / 网关安装器与卸载器都支持 `/S`（网关所有 `MessageBox` 带 `/SD IDOK`，注册 `QuietUninstallString`） | 方便 IT 批量部署 |
| `.gitignore` 加 `build/` | `/build/`（只忽略根目录的），否则 `desktop/build/icon.*` 无法入库 | — |
| 单测只提 `bootstrap.test.mjs` | `scripts/test/{bootstrap,payload,gateway-init}.test.mjs` 共 17 例，`npm test` 29 / 29 | — |
| 客户端安装包约 120 MB | 152.6 MB（0.1.0）；落盘约 600 MB，首次启动后 `~/.company-desk/app` 再占约 137 MB；网关安装包 25.1 MB | payload 233 MB（node.exe 98 + kernel.tar 134）+ Electron 44 本体 |

已知未修（记在 HANDOFF）：网关安装器端口写死 8790——管理员改端口后升级会把防火墙规则重置回 8790、完成页 URL 错；网关卸载项落在 `HKLM\SOFTWARE\WOW6432Node\…`（32 位 NSIS 未 `SetRegView`，「设置 → 应用」显示正常）。

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
  桌面与开始菜单快捷方式，卸载项在「应用和功能」（`HKCU\…\Uninstall\<GUID>`，显示名 `THE DIVA <ver>`）。
  ⚠ 安装目录是 `%LOCALAPPDATA%\Programs\the-diva-desktop`（包名），见 §0。
- 服务端 NSIS：`RequestExecutionLevel admin`，MUI2 页面 欢迎 → 目录 → 安装 → 完成（显示管理页地址与种子管理员账号，
  可勾选"打开管理页"），注册表卸载项 `HKLM\...\Uninstall\TheDivaGateway`。
- 应用图标：仓库提交 `desktop/build/icon.png`（512×512，THE DIVA 字标）与 `icon.ico`（PNG 封装的 ICO，由脚本生成一次）；
  electron-builder 与 NSIS 共用。

## 5. 客户端

### 5.1 安装后布局

```
%LOCALAPPDATA%\Programs\the-diva-desktop\      ← 安装目录，运行期只读（⚠ 原设计 Programs\THE DIVA，见 §0）
  THE DIVA.exe                                  Electron
  Uninstall THE DIVA.exe                        卸载器（支持 /S）
  resources\app.asar                            desktop/main.js、splash.html、build/icon.png、package.json（很小）
  resources\payload\                            extraResources，不进 asar
    payload.json                                { buildId, version, builtAt, node, kernel:{package,version,root}, gatewayUrl, pruned }
    runtime\node.exe
    kernel.tar                                  打好 16 处补丁的内核前缀（见 §5.3 修剪）
    plugins\desk-host\  plugins\desk-ui\        desk-ui 含已构建的 lib/client.js，不带 src/
    profile\cordis.patch.yml                    gatewayUrl 已按 --gateway 替换
    scripts\kernel\{patches,locate}.mjs,pin.json  scripts\lib\bootstrap.mjs

~/.company-desk/app/                            ← 运行期可变，按 buildId 换新（只换下面本程序建的条目，不删整个目录）
  state.json                                    { buildId, extractedAt }
  kernel\                                       kernel.tar 解出来 + 技能根已同步 + .company-desk-kernel.json 戳记
  plugins\  profile\  scripts\                  从 payload 复制
  node_modules\@deepseek-ai → junction          → ~/.dsh/profiles/node_modules/@deepseek-ai（dsh 扁平回退目录）
  electron\                                     Electron 自身的 userData / sessionData（Chromium 缓存、localStorage）
~/.company-desk/logs/desktop.log                bootstrap + 内核 stdout/stderr，5 MB 滚动保留 3 份
~/.dsh/profiles/desk-app/                       manifest + cordis.patch.yml + node_modules/@company-desk/* → junction 到 app/plugins/*
~/.dsh/desk/                                    desk-host 状态（不变：登录态、公司盘镜像、产物索引；与开发版共用）
```

### 5.2 启动流程（`desktop/main.js`）

0. `app.setPath('userData' / 'sessionData', ~/.company-desk/app/electron)`（在单实例锁之前）。
1. `app.requestSingleInstanceLock()`；第二个实例只把已有窗口置前。
2. 显示启动页（无边框 420×260：字标 + 状态行 + 转圈；首次启动提示"首次启动需要解压内核，约半分钟"）。
3. 用 `payload\runtime\node.exe` 跑 `scripts/lib/bootstrap.mjs --packaged --payload <dir> --app-dir ~/.company-desk/app --dsh-home <DSH_HOME>`，
   stdout 逐行 NDJSON `{ step, status, detail }`（step ∈ extract / kernel / profile / log / ready / error），Electron 转成启动页状态行；
   以子进程 `close` 事件判定并把没有换行的尾行也解析掉。bootstrap 只做准备、不长驻：
   - **app 目录**：`state.json.buildId ≠ payload.json.buildId`（或缺，或内核 `package.json` / bin 不在）→ 清掉本程序建的条目
     （`kernel plugins profile scripts node_modules state.json`）重建：`tar.exe -xf kernel.tar -C app/kernel`
     （Windows 10 1803+ 自带 `%WINDIR%\System32\tar.exe`；缺失则报错说明）、复制 plugins / profile / scripts、写 `state.json`。
   - **技能根**：读 `app/kernel/.company-desk-kernel.json`，`skillsDir ≠ <DSH_HOME>/desk/drive/_shared/skills` → 调
     `applyKernelPatches({ kernelRoot, skillsDir })`（16 处 mark 都在，只会同步技能根路径；现有补丁逻辑已支持"路径变了就同步"）
     → 重写戳记。
   - **profile**：`~/.dsh/profiles/desk-app/`：manifest（`file:` 指向 `app/plugins/*`）、`pnpm-workspace.yaml`、复制 patch yml、
     junction `node_modules/@company-desk/*`；跑一次 `node.exe <kernel bin> --profile desk-app --dump-default-config` 让 dsh 自愈扁平回退目录；
     junction `app/node_modules/@deepseek-ai` → 回退目录。仅在 buildId 变化或 profile 缺失时重做。
   - 最后一行 `{ step:"ready", status:"ok", kernelBin, kernelRoot, kernelVersion, profileName:"desk-app", appDir, buildId, nodeExe }`；
     出错最后一行 `{ step:"error", status:"fail", detail }` 退出码 1，用法错误退出码 64。
4. 选端口：3470 空闲则用，否则 3471…3479 顺延，再不行随机空闲端口（端口变会让 dsh 页面的 localStorage 偏好重置，README 说明）。
5. `spawn(node.exe, [kernelBin, '--profile','desk-app','--no-open','--port',N], { env:{ ...env, DSH_HOME } })`；轮询 `http://127.0.0.1:N/` 就绪（≤ 60 s）。
6. 主窗口 1280×820、最小 960×640、`autoHideMenuBar`、标题 THE DIVA、图标；`loadURL`；`ready-to-show` 时关闭启动页。
   `setWindowOpenHandler` 与 `will-navigate` 离开 `127.0.0.1` 的都交给系统浏览器（仅 http(s)）。F12 切换 DevTools、F5 重载（支持排障）。
7. 主窗口关闭 / 用户关掉启动页 → `taskkill /pid <kernel> /T /F`（bootstrap 子进程同样处理）→ 退出。内核意外退出 / 就绪超时 / bootstrap 非零退出或没给 `ready`
   → `dialog.showMessageBox`（原因 + 日志路径 + 「打开日志目录」按钮）→ 退出，不留子进程。

开发模式：`npm --prefix desktop start -- [--app-dir <dir>] [--dsh-home <dir>]`（= `electron . --payload ../build/payload`）走同一条路径，不需要先出安装包；
Electron 二进制首次运行才下载，先设 `ELECTRON_MIRROR`。

### 5.3 kernel.tar 的构建与修剪

- 来源：本机 `~/.company-desk/kernel` 版本等于 `pin.json` 且 `missingPatches` 为空 → 直接用；否则 `install-kernel.mjs --prefix build/kernel-stage` 重装（要网络）。
- 复制到 `build/kernel-stage/`，**修剪**只删运行期绝不加载的东西：`*.d.ts`、`*.d.ts.map`、`*.js.map`、`*.cjs.map`、`*.mjs.map`、
  `node-pty/prebuilds/` 里非 `win32-x64` 的平台目录。不删 LICENSE / `.js` / `.node`。修剪后再跑一遍 `missingPatches` 与
  `node --check` 确认 9 个补丁文件完好。
- `tar.exe -cf build/payload/kernel.tar -C build/kernel-stage .`（bsdtar，pax 格式，长文件名无问题）。
- MAX_PATH：内核最长相对路径 193 字符（`.map` / `.d.ts`，修剪后 190），解到 `C:\Users\<用户>\.company-desk\app\kernel`（~47 字符）
  最长 ~240 < 260。Node 本身访问文件用 `\\?\` 前缀不受 260 限制，只有解压器需要注意；bsdtar 支持长路径（已用 154 字符的基路径实测解压正常）。
- 实测数字（0.1.1-rc.2）：前缀 29,611 文件 / 204 MB → 修剪 15,259 文件 / 72 MB → 14,352 文件，`kernel.tar` 134.4 MB。

## 6. 服务端

### 6.1 安装后布局

```
%ProgramFiles%\THE DIVA Gateway\
  README.txt                           配置 / 密钥 / 日志说明（build-gateway-installer.mjs 生成）
  Uninstall.exe                        卸载器（支持 /S）
  runtime\node.exe
  server\src\*.js  server\config.json  server\package.json      不带 data/、test/、config.local.json；package.json 由构建脚本生成（type: module）
  server\config.local.json             安装时由 init.mjs 生成（已存在则不动）⚠ 原设计在安装目录根，config.js 只认 server/ 下的
  service\TheDivaGateway.exe           WinSW 2.12.0（.NET461 版）改名，exe 名 = 服务 id = XML 名
  service\TheDivaGateway.xml.tpl       模板（仓库 installer/gateway/TheDivaGateway.xml.tpl）
  service\TheDivaGateway.xml           init.mjs 按安装目录渲染（每次安装 / 升级重写，勿手改）：id/name/description、executable=runtime\node.exe、
                                       arguments=server\src\index.js、env DESK_GATEWAY_DATA + NODE_ENV=production、workingdirectory=server、
                                       onfailure restart ×2、stoptimeout 15 s、log roll-by-size 10 MB × 8（%ProgramData%\THE DIVA Gateway\logs）
  service\init.mjs                     安装脚本（见 6.2）⚠ 原设计叫 init.js
%ProgramData%\THE DIVA Gateway\
  data\                                users / login-sessions / gateway-tokens / tasks / usage / channels / drive
  logs\                                TheDivaGateway.out.log / .err.log / .wrapper.log
```

`config.local.json` 初始内容：`host: "0.0.0.0"`、`port: 8790`、`publicUrl: "http://<主机名小写>:8790"`、
`dataDir: "<ProgramData>\\THE DIVA Gateway\\data"`。`publicUrl` 只用于管理页显示与 `/api` 信息，不影响客户端路由。
`dataDir` 双写：XML 里的 `DESK_GATEWAY_DATA` 优先于 `config.local.json` 的 `dataDir`（`config.js` 逻辑），所以数据目录固定在 ProgramData，只改 config 不会生效。
上游密钥三条路（都能跨升级保留）：管理员在客户端「设置 → 同事 → 模型通道」接入（落 `data/channels.json`）、`config.local.json` 里
`upstreams.<id>.apiKey`、或机器级环境变量（变量名 = `config.json` 里该上游的 `apiKeyEnv`，DeepSeek 为 `DEEPSEEK_API_KEY`，`setx /M` 后重启服务）。
⚠ 原设计的「服务 XML 里加 `<env>`」不可用——XML 每次安装 / 升级都被重生成。服务跑在 LocalSystem 下，`~/.dsh/.credentials.yaml` 这条路不可用，README 写明。

### 6.2 安装 / 升级 / 卸载

安装（`installer/gateway.nsi`，NSIS 只做复制与调用，逻辑都在 `init.mjs` 里便于测试；所有 `MessageBox` 带 `/SD IDOK`，`/S` 静默可用）：

1. 若服务已存在：`TheDivaGateway.exe stop`（忽略失败）。
2. 复制 `runtime\`、`server\`、`service\`、`README.txt`。
3. `runtime\node.exe service\init.mjs "<INSTDIR>"`：建 ProgramData 目录；`server\config.local.json` 缺失才写；渲染 XML（每次都重写，路径以 INSTDIR 为准）。幂等；失败则中止、不注册服务。
4. `TheDivaGateway.exe uninstall`（忽略失败）→ `install`（失败中止）→ `start`（失败只警告）。
5. 防火墙：先删同名规则再 `netsh advfirewall firewall add rule name="THE DIVA Gateway" dir=in action=allow protocol=TCP localport=8790`
   （端口改了要手动改规则，README 说明；⚠ 端口在 .nsi 里写死，升级会把规则重置回 8790——已知未修，见 HANDOFF）。
6. 写 `Uninstall.exe` 与注册表卸载项（`DisplayName / DisplayVersion / Publisher / InstallLocation / UninstallString / QuietUninstallString(/S) / NoModify / NoRepair`；
   实际落在 `HKLM\SOFTWARE\WOW6432Node\…\Uninstall\TheDivaGateway`，32 位 NSIS 未 `SetRegView`）。
7. 完成页（大文本区）：`http://<COMPUTERNAME>:8790/admin`、种子管理员 `boss / boss123456`（提示尽快改密码）、README 与数据目录位置；可勾选「打开管理页」。

升级 = 覆盖安装（同一流程，`config.local.json` 与 ProgramData 不动；本机实测 mtime 不变、服务重启）。

卸载：stop → uninstall 服务（非 0 提示手工 `sc delete`）→ 删防火墙规则 → 只删 `runtime\ server\ service\ README.txt Uninstall.exe`、非递归 `RMDir $INSTDIR`
（⚠ 原设计「删安装目录」= `RMDir /r $INSTDIR`，用户选了已有目录会被整个清空，改掉）→ 删注册表项；**保留 `%ProgramData%\THE DIVA Gateway`**（凭据、公司盘），
卸载结束的提示框说明路径。

## 7. 构建流水线

根 `package.json` 新增：

```
"icon":         "node scripts/make-icon.mjs"
"dist:client":  "node scripts/build-payload.mjs && node scripts/build-client-installer.mjs"
"dist:gateway": "node scripts/build-gateway-installer.mjs"
"dist":         "npm run dist:client && npm run dist:gateway"
```

（⚠ 原设计 `dist:client` 直接 `npm --prefix desktop run dist`；实际包了一层 `build-client-installer.mjs`，见 §0。）

- `scripts/build-payload.mjs [--gateway <url>] [--kernel-prefix <dir>] [--out <dir>] [--no-prune]`：清空 `build/payload/`；复制 `process.execPath` → `runtime/node.exe`；
  按 §5.3 产出 `kernel.tar`（并校验补丁齐 + `node --check`）；`build-client.mjs` 后复制 `plugins/`（去掉 `desk-ui/src`）；`profile/cordis.patch.yml` 替换 `gatewayUrl`
  （`--gateway` 缺省取 `DESK_GATEWAY_URL`）；复制 `scripts/kernel/*`、`scripts/lib/bootstrap.mjs`；写 `payload.json`（`buildId` = 版本 + 内核版本 + 时间戳 + 内容摘要前 8 位）。
  纯函数在 `scripts/lib/payload.mjs`（`shouldPrune` / `patchGatewayUrl` / `makeBuildId` / `digestFiles`）。
- `desktop/`：独立 npm 子项目（`package.json` devDeps 仅 `electron 44.1.1`、`electron-builder 26.15.3`，`package-lock.json` 入库；`main.js`、`splash.html`、`electron-builder.yml`、`build/icon.*`）。
  安装依赖 `npm --prefix desktop install`（⚠ 不带 `--allow-scripts`）。
- `scripts/build-client-installer.mjs`：校验 `build/payload/payload.json` 与 `desktop/node_modules/electron-builder` 存在 → 未设置时默认 `ELECTRON_MIRROR` /
  `ELECTRON_BUILDER_BINARIES_MIRROR` 为 npmmirror → `electron-builder --win nsis --config.extraMetadata.version=<根版本>`（`CSC_IDENTITY_AUTO_DISCOVERY=false`，不签名）
  → 校验 `dist/THE-DIVA-Setup-<ver>.exe`。yml：`extraResources: [{ from: ../build/payload, to: payload }]`，`compression: normal`，`asar: true`，产物到 `../dist/`。
- `scripts/build-gateway-installer.mjs`：暂存 `build/gateway/`（`runtime/node.exe`、`server/{src,config.json,package.json(生成)}`、
  `service/{TheDivaGateway.exe(WinSW), TheDivaGateway.xml.tpl, init.mjs}`、`README.txt`）；找 `makensis`（`MAKENSIS` 环境变量 → electron-builder 缓存
  `%LOCALAPPDATA%\electron-builder\Cache\nsis-<ver>\nsis-<ver>-<随机后缀>\Bin\makensis.exe`（⚠ 原设计路径不对）→ PATH；都没有则报错"先跑 npm run dist:client 或安装 NSIS"）；
  `makensis /INPUTCHARSET UTF8 /DVERSION=<ver> /DSTAGE=<dir> /DOUTFILE=<exe> [/DICON=desktop/build/icon.ico] installer/gateway.nsi` → `dist/`。
- 第三方二进制锁定在 `installer/pins.json`：WinSW 2.12.0（下载 URL + SHA256，缓存到 `build/cache/WinSW-2.12.0.exe`，120 s 超时，下载不了可手动放置）。
  Electron / electron-builder 工具链下载走镜像 `ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR`（脚本默认 npmmirror；⚠ GitHub 直连在此网络失败，
  原设计的 Electron 40.10.2 离线兜底未用上，实际 44.1.1）。electron-builder 26 不再下载 winCodeSign；离线复现只需 `Cache\{7zip, icons, nsis-*, nsis-resources-*}` + Electron zip 缓存。
- `.gitignore` 增加 `/build/`（⚠ 不是 `build/`，`desktop/build/icon.*` 要入库）、`dist/`、`desktop/dist/`（`desktop/node_modules/` 已被 `node_modules/` 覆盖）。

## 8. 仓库内代码改动

- **新增 `scripts/lib/bootstrap.mjs`**：把 `launch.mjs` 与 `setup-profile.mjs` 里「确认内核 → profile → 起客户端 → 等就绪」抽成函数
  （`ensureKernel`、`ensureProfile`、`startClient`、`waitHttp`、`findFreePort`），支持两种模式：
  - 开发模式（现状）：内核在 `--prefix`，缺了跑 `install-kernel.mjs`；profile `desk`；插件链接到仓库 `plugins/`。
  - 打包模式（`--packaged`）：§5.2 的流程；profile `desk-app`；永不联网。
  `launch.mjs`、`setup-profile.mjs` 改成薄壳；`ensureProfile` 接收已定位好的内核，不再二次调用 `install-kernel`（消掉 HANDOFF 小项"跑两次"）。
  `npm run dev` / `npm run setup` 的外部行为不变。
- 新增 `desktop/`、`installer/`（`gateway.nsi`、`gateway/init.mjs`、`gateway/TheDivaGateway.xml.tpl`、`pins.json`）、
  `scripts/build-payload.mjs`、`scripts/lib/payload.mjs`、`scripts/build-client-installer.mjs`、`scripts/build-gateway-installer.mjs`、`scripts/make-icon.mjs`（SVG → PNG/ICO，一次性）。
- 服务端源码不改（实际未改）。README 新增 §2.5「安装包」（构建、镜像、SmartScreen、端口、密钥放哪、卸载保留什么、验收 checklist）；HANDOFF 更新。

## 9. 错误处理

| 场景 | 行为 |
|---|---|
| `tar.exe` 不存在 | bootstrap 输出 `error` 事件「找不到 tar.exe（需要 Windows 10 1803 及以上，或自行安装 bsdtar）」，退出码 1（⚠ 原设计退出码 2；CLI 统一 1 = 失败、64 = 用法错误） |
| 解压 / 复制失败（磁盘满、权限） | 清掉半成品（只删本程序建的条目），报错带 tar 的 stderr |
| 技能根重打补丁锚点不匹配 | `PATCH_FAIL <code>: <detail>` |
| 端口全被占 | 3470–3479 都占则随机空闲端口（实现上不会"全被占"） |
| 内核 60 s 未就绪 / 意外退出 / bootstrap 失败或没给 `ready` | 对话框「THE DIVA 无法启动」+ 原因 + 日志路径 + 「打开日志目录」，收干净子进程（内核 + bootstrap）后退出 |
| 网关不可达 | 不是启动错误：客户端照常打开，登录页显示离线（现有行为） |
| 服务端 `init.mjs` 失败 | NSIS 详情页显示其输出、弹「初始化失败（退出码 N）」并中止，不注册服务；WinSW `install` 失败同样中止，`start` 失败只警告 |

## 10. 验证

- 自动：`npm test` = 服务端 12 + `scripts/test/{bootstrap,payload,gateway-init}.test.mjs` 17 = **29 / 29**（临时目录：`findFreePort`、`ensureProfile`、
  `pinSkillsRoot` 构建机路径重写、`needsExtract`、CLI 退出码、`preparePackaged` 解压 / 幂等 / 升级（需要 `build/payload/kernel.tar`，没有则 skip）、
  `shouldPrune` / `patchGatewayUrl` / `makeBuildId` / `digestFiles`、`init` 幂等 / 配置不覆盖 / XML 转义）。
- 本机手动（**已于 2026-09-04 完成**，细节见 `docs/sessions/2026-09-04.md`）：`npm run dist:client` → `/S` 安装 → 内核进程是 `…\the-diva-desktop\resources\payload\runtime\node.exe`
  → 冷启动 19 s、热启动 2.4 s → 关窗无残留 → 卸载（用户数据保留）。`npm run dist:gateway` → `/S` 安装（UAC）→ 服务 RUNNING、`/health`、防火墙、卸载项 →
  安装版客户端填 `http://<本机名>:8790` 以 `boss` 登录、Mock Echo 有回复、退出登录 → 覆盖升级（`config.local.json` 不变）→ 卸载后 ProgramData 仍在。
- 最终验收：另一台没有 Node 的 Windows 机器按 README §2.5 checklist 走一遍，由用户执行（**未做**）。

## 11. 风险

- **Electron / electron-builder 工具链下载**：网络慢（内核 200 MB 花了 17 分钟）。缓解：镜像变量；本机已有 Electron 40.10.2 缓存。
  → 结果：GitHub 直连 217 s 后失败，npmmirror 13.8 s 成功；40.10.2 没用上，脚本默认镜像。
- **WinSW 在目标机器缺 .NET Framework**：Win10/11/Server 2016+ 自带 4.6.1+；更老的系统不在支持范围。→ 本机（Win11）正常；老系统未测。
- **bsdtar 长路径**：实现时用一个刻意很长的基路径实测解压，不行就换 Node 自写 tar 读取器（pax 头，约 100 行）。→ 154 字符基路径实测正常，不需要自写。
- **安装体积**：客户端约 120 MB 安装包 / 约 500 MB 落盘（Electron 110 + node 98 + `kernel.tar` ~150 修剪后 + 解压副本 ~150；
  `kernel.tar` 要留着给换用户 / 修复时重新解压）。内网 / U 盘分发可接受；再省要动内核依赖，v1 不做。
  → 实际：安装包 152.6 MB、落盘约 600 MB（`THE DIVA.exe` 245 MB + payload 233 MB），首次启动后 `~/.company-desk/app` 再占 137 MB；网关安装包 25.1 MB。
