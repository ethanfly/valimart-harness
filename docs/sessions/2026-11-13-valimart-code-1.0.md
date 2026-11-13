# valimart code：改基于 Qwen Code 1.0（原生二进制）

- 目标：把 valimart code 从 Qwen Code 0.27.3（npm 包 + esbuild 补丁）改到 1.0，产物变成 Bun 编译的原生可执行文件，用户不用装 Node.js。
- 上游状态：1.0 是重写（Qoder 与 Qwen Code 合并），目前只有 `v1.0.0-preview.1` 预览版；npm 上最新仍是 0.27.x。
- 方案变化：
  - `pin.json` 从 npm 包 integrity 改成 GitHub tag/commit + 源码 tarball sha256（`sourceSha256` 首次构建回填）。
  - 补丁从 5 组减到 4 组：brand-env 读构建环境、`/desk-*` 注入 BuiltinCommandLoader、`/auth` 提示、默认登录类型 `openai`。0.27 的身份文案/用法行/命令名补丁被上游 `BRAND_*` 白标取代（`BRAND_NAME`、`BRAND_CLI_BIN`、`BRAND_CONFIG_DIR`、`BRAND_ENV_PREFIX`）。
  - 构建：取源码 → 补丁 → `npm ci --ignore-scripts` → `bun run scripts/build_qwen_bun_binary.ts --target <宿主平台>` → 归档 `tar.gz`/`zip`。
  - 包内布局：`bin/valimart`（sh）+ `bin/valimart.cmd` 入口包装用宿主自带 Bun（`BUN_BE_BUN=1 ... run lib/runtime/valimart.mjs`）跑启动器；`bin/valimart-host` 是白标宿主。
- 关键坑（详见 HANDOFF）：
  1. 1.0 运行时 provider 从用户 settings 原文装配，不做 `$VAR` 展开；`apiKey` 必须写实际令牌（`launch-settings.json`，0600）。
  2. spawn 宿主时必须抹掉 `BUN_BE_BUN`，否则宿主当解释器跑。
  3. `/auth`、`/logout` 来自 AuthPlugin，AppPlugin 同名命令报 duplicate，改成补丁 AuthPlugin。
  4. 锁文件里 82 个阿里内网 resolved 改写到 npmjs（版本与 integrity 一致），否则 `npm ci` 在公网失败。
  5. `CI=true` / `TERM=dumb` 让 1.0 直接走 headless（exit 42）；测 TUI 要 `env -u CI TERM=xterm-256color`。
- 发布：`release.yml` 的 `valimart-code` job 改成三平台原生 runner matrix（windows-latest / ubuntu-latest / macos-14），各自编自己平台的归档；`release` 清理同名旧附件，并删除遗留的 `valimart-code-*.tgz`。介绍页下载规则从 tgz 改成三个平台归档名。
- 版本：0.1.0 → 0.2.0（分发形态变了，不是补丁）。
- 已验证（本机 linux-x64，从归档解压）：`login`/`status`/`discover`/`sync`、`-p` 对话经网关、`-p /desk-status`、`/auth` 提示、TUI 状态栏与 `/desk-status`、MCP `desk` Connected。包测试 4/4。
- 未验证：Windows / macOS 归档（等 CI）；TUI 内任务卡四格流转。
