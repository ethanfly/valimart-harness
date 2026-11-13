# valimart code：Qwen Code 二次开发与发布

- 目标：把 QwenLM/qwen-code 改成 valimart 的 TUI 客户端（命令 `valimart`），对标 pi 包；产物挂到 `latest` Release，介绍页新增项目介绍。
- 方案：不 fork 整仓。锁定 npm 包版本与 integrity，套锚点补丁，自有模块放 `packages/valimart-code/`，规矩与 dsh 内核补丁一致（锚点恰好命中才套用，对不上硬失败）。理由：上游是 monorepo，整仓 fork 难跟进；Qwen Code 自带 MCP、SessionStart hook、statusLine、自定义斜杠命令的扩展点，能用配置做的不打补丁。补丁只留配置给不了的 5 组：`/desk-*` 注入、身份文案、用法行、命令名（主解析器与三处帮助解析器）。
- 决定：
  - 命令名 `valimart`，不覆盖原版 `qwen`。配置目录由启动器设 `VALIMART_HOME` 与 `QWEN_HOME`，避开 `~/.qwen`。
  - 发布走 `release.yml` 新 job，不手工 `gh release upload`：与现有 `latest` 流程一致，main 推送即发。tgz 文件名带版本；`replacesArtifacts` 只替换同名附件，旧版本留在 Release 里，介绍页按语义版本取最高（与 VSIX 相同）。
  - 构建默认走 npmmirror（沿用 `scripts/lib/npm-cli.mjs`）；CI 通过 `npm_config_registry` 改用官方源。上游 tgz 无论从哪取都校验 `pin.json` 的 integrity。
  - 介绍页沿用 Release API 按文件名匹配，与客户端、网关、VSIX 同一机制，不新造下载方式。
- 过程要点：
  - 首次构建在 esbuild 处失败：根 `node_modules` 只有 win32 二进制。用 `npm install --no-save @esbuild/linux-x64@0.25.12` 补上，lockfile 未改；副作用见 HANDOFF。
  - 锚点补丁对 0.27.3 首次即 5/5 命中。
  - MCP 冒烟时发现 desk-mcp 在 stdin 关闭时立即退出，未完成的 `tools/call` 响应随之丢失。正常会话 stdin 不关，不影响；测试时需保持 stdin 打开。
  - README 原写「思考档位（Shift+Tab）」，源码核实 Shift+Tab 切的是审批模式，思考档位走 `/effort`，已改。
  - 启动器帮助文案「下方帮助里的 qwen 即 valimart」改为「其余用法与 Qwen Code 相同，命令名统一为 valimart」。
- 文件：
  - `packages/valimart-code/`：`lib/`、`runtime/`、`scripts/{build,patches}.mjs`、`test/patches.test.mjs`、`skills/`、`README.md`、`pin.json`、`package.json`。
  - 根 `package.json`：新增 `dist:valimart-code`；`test` 纳入 valimart-code 测试。
  - `.github/workflows/release.yml`：新增 `valimart-code` job，`release` 依赖它，正文加一行。
  - `docs/intro/index.html`：导航、安装卡、步骤项、下载规则、「06 / valimart code」节。
