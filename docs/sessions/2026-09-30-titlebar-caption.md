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

## 未做 / 风险

- 没走 `titleBarOverlay` 原生窗控：仍是 frameless + 自绘（避免原生色带 + 主题同步 IPC），外观与截图里 Windows 11 窗控一致但不完全等同原生。
- 本机安装版前缀 `~/.company-desk/app/kernel` 仍是 0.1.7-rc.1；装上新客户端包后才变。

## 打包与发布（用户拍板“打包 + 发布到网关”）

- `node scripts/build-payload.mjs`：内核 0.2.0-rc.2（20 处补丁）、`kernel.tar` 393.6 MB、buildId `0.1.0+0.2.0-rc.2.20260930-0643.5e6f0872`（内核源＝默认前缀 `~/.company-desk/kernel`）。
- `node scripts/build-client-installer.mjs` → `dist/valimart-harness-Setup-0.1.0-20260930.0643.exe`（221.8 MiB）；SHA-256 `8bc81de39f6a16a470f59e9d115e6e7debdf4c016aebfe35d75532855052cfa5`（写了 `.sha256` 旁文件）。
- `build/verify-client-artifact.mjs`（上轮留下的一次性脚本，本轮把已删除的 `kernel-update.js` 哈希检查换成 `desk-host/lib/index.js` + `desk-ui/lib/client.js` + `profile/cordis.patch.yml`）：隔离 appDir/dshHome + 随包 node + payload 真启动 → `{"httpStatus":200,"versionVisible":true,"loginVisible":true,"pageErrors":[],"stderr":""}`。
- `build/publish-client-once.mjs`（改成接收 exe 参数 + 发布前后各读一次 `/api/admin/client`）：网关从 `0.1.0+0.2.0-rc.1.20260929-0631.6494c95d` 切到新 buildId，旧版留 `previous` 可回滚。
