# 设计：内核自动更新（GitHub Release → 公司门禁 → 员工机下次启动切换）

> 状态：已实现。
> 上游：<https://github.com/deepseek-ai/deepseek-harness>
> 对应 HANDOFF「安装包剩余项」里的自动更新，以及「公司审核后推、CLI + 管理页都能发现、员工机后台下载、下次启动再换」。

## 0. 背景与约束

当前内核锁在 `scripts/kernel/pin.json` 的 `@deepseek-ai/dsh@0.1.1-rc.2`，16 处公司补丁按**这个版本的源码锚点**写在 `scripts/kernel/patches.mjs`。安装版把打好补丁的前缀打成 `kernel.tar` 随包，首次启动解到 `~/.company-desk/app/kernel`，**不联网**。

上游已发布 `dsh-v0.1.2-rc.1`（npm `@deepseek-ai/dsh` 的 `latest` / `next` 也已是 `0.1.2-rc.1`）。官方 README 写明开发预览会有破坏性变更。因此：

- **不能**让员工机直连 GitHub / npm 静默换内核。
- **不能**在补丁锚点失败时发布或切换。
- `pin.json` 仍是安装包随包的保底版本；网关「当前发布」可以比它新。
- 本轮**不**把员工机升到 `0.1.2-rc.1`。流水线就位后，由管理员对那个 tag 跑一次 prepare；过了再 publish。

员工机仍只消费已经打好补丁的 `kernel.tar`，与现在 `preparePackaged` 的解压路径兼容。

## 1. 目标与非目标

**目标**

1. 从 GitHub Releases（仓库 `deepseek-ai/deepseek-harness`，tag 形如 `dsh-v0.1.2-rc.1`）发现比当前已发布内核更新的版本。
2. 在临时前缀安装对应 npm 包 `@deepseek-ai/dsh@<version>`，跑现有 `applyKernelPatches`；16 处全过才打 `kernel.tar` + `manifest.json`。
3. 管理员用 CLI 或网关管理页把通过门禁的包发布为 `current`；可回滚到上一份。
4. 已登录的员工机后台向网关拉清单；有更新则下载到旁边并校验 sha256；**下次启动**再切换。本次启动不被挡，没网继续用旧内核。

**非目标**

- Electron 壳 / 安装包本身的自动更新
- 代码签名、macOS / Linux
- 员工机 git clone 或在员工机 `pnpm build` 源码
- 静默换到补丁失败的版本
- 本轮把生产 pin 改成 `0.1.2-rc.1`

## 2. 架构

```
GitHub Releases API          npm registry
deepseek-ai/deepseek-harness  @deepseek-ai/dsh@<ver>
        │                            │
        ▼                            ▼
  discover（列 tag）          prepare（装前缀 + 16 补丁 + tar）
        │                            │
        └──────────┬─────────────────┘
                   ▼
         网关 data/kernels/
           <ver>/kernel.tar
           <ver>/manifest.json
           current.json  { version, sha256, previous }
                   │
                   │  GET /api/kernel/current + /tarball
                   │  （已登录会话令牌）
                   ▼
         员工机 ~/.company-desk/app/kernel-next/
           kernel.tar + pending.json
                   │
                   │  下次 preparePackaged / ensureKernelDev
                   ▼
         切换到 ~/.company-desk/app/kernel（安装版）
         或 ~/.company-desk/kernel（开发版）
```

发现只认 GitHub Release 的 `tag_name`。安装仍走 npm（与现有 `install-kernel.mjs` 同一条路），不在网关或员工机 clone 源码树。tag `dsh-vX.Y.Z[-pre]` 对应 npm 版本 `X.Y.Z[-pre]`。

## 3. 组件

### 3.1 `scripts/kernel/update.mjs`（新）+ 纯函数 `scripts/lib/kernel-update.mjs`（新）

可单测的纯函数放 `scripts/lib/kernel-update.mjs`：

- `parseReleaseTag(tag)` → `{ version }` 或 `null`（只认 `dsh-v` 前缀）
- `newerThan(a, b)`：semver 比较（含 `-rc` / `-alpha`）
- `filterDiscoverable(releases, currentVersion)`：未 draft、有 tag、比 current 新
- `manifestShape` / `hashFile` / `readPending` / `writePending`

CLI（`update.mjs`）三条子命令：

| 命令 | 做什么 |
|---|---|
| `node scripts/kernel/update.mjs discover [--current <ver>]` | `GET https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=20`，打印比 `--current`（默认读网关或 `pin.json`）新的 tag |
| `node scripts/kernel/update.mjs prepare --version 0.1.2-rc.1 [--out build/kernel-update]` | 临时前缀 `npm install @deepseek-ai/dsh@<ver>`（复用 `install-kernel.mjs` 的安装方式），`applyKernelPatches`，修剪规则与 `build-payload.mjs` 的 `shouldPrune` 相同，写出 `<out>/<ver>/kernel.tar` 与 `manifest.json` |
| `node scripts/kernel/update.mjs publish --gateway <url> --user <admin> --password <…> --from <dir>` | 登录拿会话令牌，把 tar + manifest `POST` 到网关 |

环境变量：`GITHUB_TOKEN`（可选，提高 API 限额）；`DESK_GATEWAY_URL` 可作为 `--gateway` 默认。

根 `package.json` 加脚本 `kernel:discover` / `kernel:prepare` / `kernel:publish`。不新增 npm 依赖。

### 3.2 网关

**磁盘**（在现有 `cfg.dataDir` 下，安装版即 `%ProgramData%\THE DIVA Gateway\data`）：

```
data/kernels/
  current.json
  0.1.1-rc.2/kernel.tar
  0.1.1-rc.2/manifest.json
  0.1.2-rc.1/kernel.tar
  0.1.2-rc.1/manifest.json
```

`current.json`：

```json
{
  "version": "0.1.2-rc.1",
  "sha256": "<hex>",
  "sourceTag": "dsh-v0.1.2-rc.1",
  "sourceRepo": "https://github.com/deepseek-ai/deepseek-harness",
  "publishedAt": "2026-09-04T12:00:00.000Z",
  "previous": { "version": "0.1.1-rc.2", "sha256": "<hex>" }
}
```

`manifest.json` 另含：`package`（`@deepseek-ai/dsh`）、`bytes`、`patched`（`applyKernelPatches` 的汇总文案）、`builtAt`。

没有 `current.json` 时：员工 API 返回随包保底 `{ version: pin.version, bundled: true, tarball: false }`，客户端不下载。

**HTTP**（沿用 `server/src/api.js` 的会话鉴权；管理员接口走现有 `user.role === 'admin'`）：

| 方法 | 路径 | 谁 | 行为 |
|---|---|---|---|
| GET | `/api/kernel/current` | 已登录任意角色 | `{ version, sha256, sourceTag, bundled }`；无 current 则 `bundled: true` |
| GET | `/api/kernel/tarball` | 已登录任意角色 | `application/octet-stream` 输出 current 的 tar；无 current → 404 |
| GET | `/api/admin/kernel` | admin / director（员工 403） | current + 已存版本列表 + `discover`（GitHub，失败则 `discoverError`，不 500） |
| POST | `/api/admin/kernel/prepare` | admin | body `{ version }`：网关本机执行与 CLI `prepare` 相同的步骤，结果写入 `data/kernels/<ver>/`，**不**改 `current` |
| POST | `/api/admin/kernel/publish` | admin | 两种 body：`{ version }` 发布已 prepare 的目录；或 multipart/原始二进制上传（CLI `publish` 用），然后把该版标成 current，原 current 写入 `previous` |
| POST | `/api/admin/kernel/rollback` | admin | `current` 与 `previous` 对调；没有 previous → 400 |

管理页 `/admin` 加「内核」一节：当前版本、发现列表、试打进度（prepare 可能数分钟，接口同步跑完后返回；超时由反向代理/浏览器限制，CLI 是长任务的主路径）、发布、回滚。不另做 SPA。

### 3.3 客户端

**切换发生在下次启动**，由已有编排执行，不挡本次窗口。安装版 `preparePackaged` 顺序是 **守卫 → 解随包 → `applyPendingKernel`**（pending 在解压之后覆盖 bundled）：

1. 守卫 `assertSafeAppDir`：项目目录直接抛错，apply / 解压之前什么都不动。
2. 解随包：`needsExtract` 为真（首次 / `buildId` 变了 / 内核目录不完整）时清 `APP_DIR_ENTRIES` 并解 `kernel.tar`。**`kernel-next` 不在清理列表里，解随包不会删 pending。**
3. `applyPendingKernel`：读 `kernel-next/pending.json`；sha256 对得上且 tar 在 → 解到 `kernel-staging` → `pinSkillsRoot` + `missingPatches` 为空 → 把旧 `kernel` 改名为 `kernel-prev`（只留一份）、staging 改名为 `kernel` → 删 `kernel-next`。任一步失败：删 staging / pending，保留旧 `kernel`，给启动页一条 `log`：`内核更新未生效，仍用 <旧版本>`。pending 覆盖刚解出的 bundled。
4. 登录成功后（`desk-host` 已有会话令牌和 `gatewayUrl`）调用 `fetchKernelUpdate`：`GET /api/kernel/current`；`bundled` 或 `version` 等于本地戳记 → 结束；否则 `GET /api/kernel/tarball` 写到 `kernel-next/kernel.tar`，算 sha256，对不上就删并写 `desktop.log` / host 日志；对上则写 `pending.json`。下载失败不影响当前会话。
5. 开发模式前缀是 `~/.company-desk/kernel`，pending 仍放 `~/.company-desk/app/kernel-next`（与安装版同一位置），`applyPendingKernel` 的目标前缀由调用方传入。

Electron `desktop/main.js` **不**自己发 HTTP。它只在启动页展示 bootstrap 打来的「更新未生效」日志。后台下载挂在已经登录的 host 插件上，这样有会话令牌、也避免未登录就打员工 API。

## 4. 失败处理

| 情况 | 行为 |
|---|---|
| GitHub / npm 不可达 | CLI / 管理页报错；`current` 不动 |
| 补丁锚点失败 | 不写 `current`，报告标出哪一条；员工机无感知 |
| 下载中断 / sha256 不对 | 删 `kernel-next`，保留旧内核，打一行日志 |
| 下次启动切换失败（缺 bin、补丁不齐） | 丢掉 pending，继续旧内核，启动页提示仍用旧版本 |
| 网关回滚 | `current` 指回 `previous`；员工机已下的 pending 若 hash 对不上 current 就丢掉（`fetchKernelUpdate` 发现本地 pending 的 sha256 ≠ current 则删除） |
| 员工机没网 / 未登录 | 不检查；随包或已有内核照常工作 |
| 首次启动 | 与现在相同：只解随包 `kernel.tar`，不访问网关（此时通常还没登录） |

并发：同一台机器只允许一份 pending。正在写 tar 时用 `kernel-next/.partial`，写完再改名，避免读到半截文件。

## 5. 测试

继续 `node --test`，只用 `os.tmpdir()`，不碰 `server/data/`、`~/.dsh`、`~/.company-desk/kernel`。不打真 GitHub（fixture JSON）。`prepare` 的失败路径用假前缀（与现有 `pinSkillsRoot` 测试同类），不跑完整 npm 安装。

覆盖：

- `parseReleaseTag` / `filterDiscoverable` / `newerThan`
- prepare：假内核补丁失败 → 无 tar、非 0
- `current.json` publish 后 `previous` 指向旧版；rollback 对调
- 员工 `GET /api/kernel/current` 无会话 401；有会话返回 version+sha256
- `applyPendingKernel`：hash 不对不切换；hash 对则目标前缀 `locateKernel().version` 变成新版本
- pending 的 sha256 ≠ 新 current → 删除 pending

`npm test` 必须保持全绿。根 `package.json` 仍只有 `esbuild` 一个 devDependency。

## 6. 文档与验收

- README：`kernel:discover` / `prepare` / `publish`；管理页「内核」一节；员工机「下次启动生效」。
- HANDOFF：自动更新从「没做」改为「内核有门禁更新；壳没有」。
- 验收：
  1. 自动化：§5 的用例（含假 tar 的下载 / 切换 / hash 失败），不依赖真 GitHub。
  2. 本机 CLI：`discover` 能列出 `dsh-v0.1.2-rc.1`；对已锁定的 `0.1.1-rc.2` 跑 `prepare` 应通过（补丁已齐）。publish 后 `GET /api/kernel/current` 返回该 version + sha256。员工机若本地戳记 version 已相同则**不**再下载（这是正确行为）。
  3. 对 `0.1.2-rc.1` 跑一次 `prepare`：通过则可 publish，之后登录的员工机应出现 `kernel-next`，重启后戳记变成 `0.1.2-rc.1`；失败则报告留下、`current` 不动。

## 7. 关键决定

| 决定 | 为什么 |
|---|---|
| 发现走 GitHub Releases，安装走 npm | 用户指定的上游是 GitHub；npm 包是同一产物的已构建发行，避免在网关/员工机跑 `pnpm build` |
| 门禁 = 现有 16 处锚点补丁全过 | 与「升版本只改 pin、锚点失败硬停」同一原则 |
| 员工只从网关拉 tar | 员工机不直连 GitHub；公司内网只开 8790 也能更新 |
| 下次启动再切换 | 不挡本次使用；半截下载不会替换正在跑的内核 |
| 下载挂在 desk-host 登录之后 | `/api/*` 已有会话鉴权；Electron 主进程此时还没有令牌 |
| 本轮不升 0.1.2-rc.1 | 补丁几乎肯定要重审；先把管道铺好，升版本是另一次有意识的操作 |
