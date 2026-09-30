# 2026-09-30 标题栏照上游桌面端（caption 40px）+ 内核升到 0.2.0-rc.2

## 目标

用户给了 deepseek harness 桌面版客户端截图，要求客户端布局参考它、**尤其是标题栏**；参考源要取 GitHub 最新版，并把内核升到最新。

## 参考来源（怎么取的）

- 上游仓库 `deepseek-ai/deepseek-harness`（`master`，2026-09-29 push）：`git clone --depth 1 --filter=blob:none --sparse` 到 `E:\orcaWorkspace\dsh-ref`，只取 `apps/desktop` + `packages/client/{ui-layout,ui-sidebar,...}`，避免整仓 255MB。
- 桌面壳契约（`apps/desktop`）：
  - `src/windows-layout.ts`：`WINDOWS_TITLEBAR_HEIGHT = 40`。
  - `src/main.ts`：Windows 用 `titleBarStyle: 'hidden'` + `titleBarOverlay: { height: 40 }`（原生窗控），页面通过 IPC 回传主题色 → `setTitleBarOverlay`。
  - `src/preload-windows.ts`：给 `html` 打 `data-windows-titlebar` + `--dsh-windows-titlebar-height: 40px`。
  - `src/preload-menu.ts`：caption 里挂 shadow DOM 菜单条 `left: var(--dsh-windows-menu-start, 48px)`，按钮 28px 高 / 6px 圆角 / 14px 字，点击 `ipcRenderer.invoke(windowsMenu, name, x, y)` 由主进程 `Menu.popup` 弹原生菜单（`应用` / `编辑`）。
  - `packages/client/ui-layout/AppFrame.module.css`：`[data-windows-titlebar] .frame { padding-top: var(--dsh-windows-titlebar-height); background: var(--dsw-specific-sidebar-fill) }`，`.frame::before` 是整条拖区，`.centerCol { background: base; border-radius: 16px 0 0 0 }`，`.sidebarCol { border-right: none }`。
  - `packages/client/ui-sidebar/SidebarRoot.module.css`：品牌行在 caption 之下（高 40px），折叠按钮 `position: fixed; top: (40-28)/2; left: 12px`，即折叠钮在 caption 里。
- 截图（1280×819）像素采样确认几何/配色：caption band `#f9fafb`（＝侧栏色）、主内容 `#ffffff`、band 高 40px、主列从 x=280 起（侧栏 280）、菜单从 x≈48 起。

## 改动

### 内核

- `scripts/kernel/pin.json`：`0.2.0-rc.1` → **`0.2.0-rc.2`**（npm `latest`/`next`、GitHub 最新 release `dsh-v0.2.0-rc.2`）。
- `npm run kernel` 重装 + 打补丁：20 处新打、4 处已有、2 处 optional 跳过（`company-win-junction-mklink-v3/v4` 锚点消失，符合预期）；`npm run kernel:check` → 版本正确、20 处补丁齐全。
- 顺带修被版本升级打断的 e2e 锚点：`e2e/session-images.spec.js` 原先替换 `new Bp(lc).run();`。0.2.0-rc.2 的 web boot 换成了 `globalThis.__ModuleLoader__.create(...)` + `n.run(handler)`，静态模块表变成 `staticModules: <fn>()`；改成用正则取 `<fn>` 再替换 `run(...)` 调用（锚点缺失仍会显式报错）。

### 客户端标题栏（desk-ui）

- `titlebar.jsx`：新增 caption 内容——折叠侧栏按钮（28px 方钮，`layoutActions.toggleSidebar` 由 `layout.jsx` 传进来）+「应用 / 编辑」菜单条（`deskShell.openMenu` → 主进程原生菜单，promise 未 resolve 期间按钮保持按下态）；删掉旧的品牌标题、`dk-titlebar-side/pass/main` 三段式。
- `styles.css`：
  - `--dk-titlebar-h: 36px → 40px`；`.dk-frame` 整体 `padding-top: 40px` + 底色＝`--dk-bg-1`（侧栏色）；`.dk-col-main` 自画底色 + `border-radius: 16px 0 0 0`；Electron 下侧栏去掉右边框。
  - 删掉整套「会话顶栏挤进 caption」的避让几何（`:first-child` 行高、`--dk-caption-right` 让位、tablist margin-top、`dk-titlebar-main` 指针开洞）；会话顶栏恢复官方默认几何，窗控不再和它抢同一行。
  - 右侧栏面板 `top: 0 !important` → `top: var(--dk-titlebar-h) !important`（绝对定位的包含块是 frame 的 padding box，不改就会压在 caption 上）。
  - `.dk-resizer.overlap-left { margin-left: -5px }`：侧栏与主列之间不再留 5px 底色缝（`main.left` 实测 285 → 280）。
  - 品牌行：`height: 56px; padding: 16px 14px 8px 12px` → `height: 40px; margin-top: 6px; padding: 0 14px 0 12px`（字标中线 = 40+6+20 = 66，与截图一致）；侧栏里重复的折叠钮在 Electron 下 `display: none`。
- `sidebar.jsx`：两个折叠/展开按钮加 `dk-collapse-btn` / `dk-expand-btn` 类名供上面隐藏。
- `desktop/preload.js`：兜底条 36px → 40px；`btnCss` 高度同步；`.dk-shell-fallback` 的图标从 innerHTML 改成 `textContent` 文本字形（顺手消掉 lint 的 innerHTML 告警）；新增 `openMenu(name, x, y)`。
- `desktop/main.js`：新增 `desk:menu-popup` handler —— `应用`（关于 / 重新加载页面 F5 / 开发者工具 F12 / 退出）与 `编辑`（撤销/重做/剪切/复制/粘贴/全选，走 role），`Menu.popup({ window, x, y, callback })` 用 promise 包住，菜单关掉才 resolve。

### 顺带

- `e2e/admin.setup.spec.js` / `e2e/admin.smoke.spec.js` 还在断言 `#kernel h2`＝内核，但内核分区在上一次「内核随客户端整包分发」提交里已经从管理页删掉（这两个用例当时就红了）；改成断言 `#client h2`＝客户端。

## 验证

- `npm test`（TEMP 设在仓库外）：**557 pass / 0 fail / 1 skip**（skip 仍是缺 `build/payload/kernel.tar` 的 `preparePackaged`）。
- `npx playwright test`（全量 e2e）：**17 passed / 7 skipped / 0 failed**。其中 `e2e/desktop-chrome.spec.js` 与 `e2e/sidebar-toggle-align.spec.js` 按新几何重写：caption 40px、`frame/sidebar/header.top = 40`、`frame bg === sidebar bg`、`main border-radius = 16px`、菜单/折叠/窗控点击命中、最大化前后几何不变、右栏面板 `top = 40`。
- 真机（仓库自带 Electron 载入 dev 客户端页 `~/.dsh` + 内核 0.2.0-rc.2，1280×820）：
  - `build/caption-new.png`（空态）、`build/caption-session.png`（真实会话）——caption 40px、`应用/编辑` 从 x=48 起、窗控 138px（3×46）在 x=1142、侧栏 280 且与 band 同色 `rgb(247,247,248)`、主列 `left: 280 / radius: 16px`、品牌行 46..86。
  - `build/caption-rail.png` + 探针读数：caption 折叠钮可切换 280 ↔ 56，rail 内不再出现重复折叠钮，主列随之 280 ↔ 56。
  - 会话页实测 `[data-conversation-header-corner]`（打开右侧边栏）在 y=51 且可点（`elementFromPoint` 命中「打开右侧边栏」），窗控命中「关闭」未受影响。
- 探针脚本（`build/desk-*-probe.cjs`、`e2e/zz-*-probe.spec.js`）验证完已删。

## 第二轮：按用户圈注补齐（同日）

用户又发两张带红框的截图，圈的是：① 主列左上角（圆角效果）② 「应用」菜单内容 ③ 会话顶栏右上角的文件夹胶囊。

### ① 主列左上角圆角

- 现象：CSS 里 `.dk-col-main` 已经是 `border-radius: 16px 0 0 0`（e2e / 探针都能量到 16px），但渲染出来是直角。
- 根因（用 `document.elementsFromPoint(281,41)` 逐层看）：会议根节点 `div.wSkVaW_root` 自己画了不透明 `rgb(255,255,255)` 背景且 `border-radius: 0`，把父层的圆角盖成直角。上游 `.centerCol` 除了半径还带 `overflow: hidden`，内层白底被裁到圆角里，所以它看起来是圆的。
- 修：`html.dk-desk-electron .dk-col-main { overflow: hidden }`。截图像素采样验证：`(281,41) → #f7f7f8`（band 色）、`(295,41) → #ffffff`（圆内），完全符合 16px 半径的几何；同时实测输入行「完全权限」下拉仍在主列内、未被裁剪（`insideMain: true`）。
- 回归：`e2e/desktop-chrome.spec.js` 新增 `mainOverflow === 'hidden'` 断言。

### ② 会话顶栏右上角：文件夹胶囊

- 上游那一栏是 `conversation.session.header.utilities`（list 槽）：`dsh-client-ui-open-in-app` 往里面注入「打开位置 / 更多打开方式」（文件夹 + ⌄ 的胶囊），`dsh-session-log-export`、`dsh-client-ui-schedule` 也往同一槽注册（有任务/反馈时才出）。
- 我们上一轮为了把“打开工作区文件夹”挪到侧栏菜单，直接把这个槽 `display: none !important` 藏了（当时会话顶栏还挤在 caption 里，怕和窗控撞）。现在 caption 是独立一行，已经没有冲突。
- 修：改成 `display: flex`（不再隐藏）。真机探针：槽内就是「用 文件资源管理器 打开 / 更多打开方式 / 更多操作」，位置 1138/1161/1188、高 28，`elementFromPoint` 命中胶囊；截图 `build/round2-session.png` 与参考图右上角一致（胶囊 + ⋯ + 右栏开关）。
- 回归：`scripts/test/workspace-folder-menu.test.mjs` 原来断言“utilities 隐藏”，改成断言“不再隐藏”；`scripts/test/desk-empty-state.test.mjs` 新增一条同义断言。

### ③ 「应用」菜单内容

- 参考截图：关于 DeepSeek Harness / 检查更新… / 管理 dsh 命令… / ─ / 退出。用户拍板：不做命令管理器，菜单也不放重载/开发者工具（F5 / F12 键盘快捷键保留）。
- `desktop/main.js`：把启动前的更新检查抽成 `checkClientUpdate({ apply })`（返回 `applied/downloaded/current/skip/error` + 人话 detail，`UPDATE_REASON` 把网关侧 reason 翻成中文）；`preOpenUpdateCheck()` 变成它的薄封装；新增 `checkUpdateFromCaption(window)` 跑检查并 `dialog.showMessageBox` 报结果。`captionMenu('application')` → **关于 valimart harness / 检查更新… / ─ / 退出**。
- 验证：真实 `desktop/main.js` 以 attach 模式（`--url <dev 客户端页>`）跑起来，点「应用」→ `aria-expanded=true`（原生菜单弹出）、无报错（`build/menu-real-shell.png`）。Playwright 关不掉原生弹出菜单，所以“菜单关闭后按钮复位”由 `e2e/desktop-chrome.spec.js` 的固定装置覆盖。

### 第二轮验证与发布

- `npm test` **558 pass / 0 fail / 1 skip**；全量 e2e **17 passed / 7 skipped / 0 failed**。
- 重新打包并发布：payload buildId `0.1.0+0.2.0-rc.2.20260930-0700.4ad363e9` → `dist/valimart-harness-Setup-0.1.0-20260930.0700.exe`（221.8 MiB，SHA-256 `a351756e71b6e2e398d2d5f46c29e34d25e67ed4a66964def6ea2dc13e1beb26`）；隔离验证 `build/client-artifact-check-A0KK26/verification.json`；网关从 `...-0643.5e6f0872` 切到新版（0643 包留 previous 可回滚）。

## 未做 / 风险

- 没走 `titleBarOverlay` 原生窗控：仍是 frameless + 自绘（避免原生色带 + 主题同步 IPC），外观与截图里 Windows 11 窗控一致但不完全等同原生。
- 本机安装版前缀 `~/.company-desk/app/kernel` 仍是 0.1.7-rc.1；装上新客户端包后才变。

## 打包与发布（用户拍板“打包 + 发布到网关”）

- `node scripts/build-payload.mjs`：内核 0.2.0-rc.2（20 处补丁）、`kernel.tar` 393.6 MB、buildId `0.1.0+0.2.0-rc.2.20260930-0643.5e6f0872`（内核源＝默认前缀 `~/.company-desk/kernel`）。
- `node scripts/build-client-installer.mjs` → `dist/valimart-harness-Setup-0.1.0-20260930.0643.exe`（221.8 MiB）；SHA-256 `8bc81de39f6a16a470f59e9d115e6e7debdf4c016aebfe35d75532855052cfa5`（写了 `.sha256` 旁文件）。
- `build/verify-client-artifact.mjs`（上轮留下的一次性脚本，本轮把已删除的 `kernel-update.js` 哈希检查换成 `desk-host/lib/index.js` + `desk-ui/lib/client.js` + `profile/cordis.patch.yml`）：隔离 appDir/dshHome + 随包 node + payload 真启动 → `{"httpStatus":200,"versionVisible":true,"loginVisible":true,"pageErrors":[],"stderr":""}`。
- `build/publish-client-once.mjs`（改成接收 exe 参数 + 发布前后各读一次 `/api/admin/client`）：网关从 `0.1.0+0.2.0-rc.1.20260929-0631.6494c95d` 切到新 buildId，旧版留 `previous` 可回滚。
