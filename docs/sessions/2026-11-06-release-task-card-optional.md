# 2026-11-06 发版：任务卡改为可选（客户端 + 插件）

用户要求：打包客户端（含插件）、发布到网关、插件装到本机、提交推送。

## 版本

- Claude 插件 `valimart-desk` 0.2.0 → 0.2.1（`plugin.json`、`marketplace.json`、`package.json`）。
- pi 包 `pi-valimart-desk` 0.1.12 → 0.1.13。npm 上已有 0.1.12，CI 的 npm-pi 发布新版本。
- VS Code 插件 0.3.1 → 0.3.2（README 加一段、`manifest.test.js` 跟着改）。
- 客户端 `package.json` 还是 0.1.0，安装包靠 buildId 时间戳区分。

## 验证

- `node --test packages/claude-valimart-desk/test/*.test.mjs packages/pi-valimart-desk/test/*.test.mjs`：55 pass。
- `npm --prefix packages/vscode test`：83 pass。
- 全量 `npm test`（TEMP 设在仓库外）：677 项里 671 pass / 3 fail / 3 skip。失败的是 Linux 上一直过不了的 3 项（工作区写锁、npm PATH、sherpa 空格路径）。跳过的 3 项是 `preparePackaged`，本机没有 kernel.tar，打包以 Windows CI 为准。

## 发布

推 main → release 工作流（Windows 打客户端 + 网关 exe，Ubuntu 打 vsix，npm-pi）→ Release `latest`。
客户端 exe 下到本机 → scp 到测试机 `192.168.100.71` → 在服务器上调 `127.0.0.1:8790/api/admin/client/publish`（办公网直传大包会超过网关 300s requestTimeout）。
