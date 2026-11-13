# NOTICE

valimart code（惠利玛终端客户端）基于 [Qwen Code](https://github.com/QwenLM/qwen-code) v1.0.0-preview.1（commit `bd3604fdf218614ef501977745af08d473bea102`，Apache License 2.0，见上游 LICENSE）二次开发。

相对上游源码的改动随构建注入，源码见 valimart-harness 仓库 `packages/valimart-code/`：

- **白标**（构建期 BRAND_* 环境变量，见 `scripts/build.mjs` 的 BRAND_ENV）：产品名 Valimart Code、命令名 `valimart`、配置目录 `~/.valimart`、环境变量前缀 `VALIMART_`、事件命名空间 `valimart`。
- **新增文件** `packages/cli/src/valimart/valimartDeskPlugin.ts`：/desk-* 斜杠命令（内容在运行时从 `VALIMART_CODE_COMMANDS` 指向的模块加载）、顶掉 Qoder 账号的 `/auth`、`/logout`。
- **锚点补丁**（`scripts/patches.mjs`）：bin.ts 入口挂载上述插件、默认登录类型改为 `openai`（公司网关 provider）。
- 随包的 `lib/`、`runtime/`（启动器、desk MCP 服务、SessionStart hook、状态栏）由 Node/Bun 解释运行，不参与编译。

上游 1.0 为预览版（preview），接口与行为可能随正式版变化；升级走 `pin.json`（tag/commit/sha256）+ 补丁重审。
