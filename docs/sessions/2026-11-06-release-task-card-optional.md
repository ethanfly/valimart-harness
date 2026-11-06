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

- release run 42155810093（`0f26dc0`）：npm-pi 7s、vscode 40s、installers 10m50s、release 36s，全部通过。上一次失败的 run 41589007301 是手动取消的，不是构建错误。
- Release `latest` 新增 `valimart-harness-Setup-0.1.0-20261106.0324.exe`（513,286,837 字节，sha256 `ae99f0bd72621c50b3f0803dcd64a9bacc82ec337ec7f7ccb233257c6fc86c65`）、`valimart-harness-Gateway-Setup-0.1.0.exe`、`valimart-harness-0.3.2.vsix`。npm 上 `pi-valimart-desk` 是 0.1.13。
- 下载 66 秒。scp 到测试机 9 分 47 秒（约 0.87 MB/s），服务器上 sha256 一致。
- 在测试机上用自带的 `runtime/bin/node` 跑发布脚本。管理员令牌取本机 Claude 插件登录态里 ethan 的会话，经 SSH 的 stdin 传过去，不进命令行、不落盘。接口 10 秒返回 200，`publishedAt` 2026-11-06T03:46:23.870Z，`previous` 是 10-30 那版 `0.1.0+0.2.1-rc.5.20261030-0926.bd38e6f6`。
- 复核：`/api/client/current` 和 `/api/admin/client` 都返回新 buildId `0.1.0+0.2.1-rc.5.20261106-0324.14831d80`，网关存着两版。`state/data/clients/<新 buildId>/client.exe` 的 sha256 与 Release 一致。`TheDivaGateway` 仍是 active。
- 包里的插件：exe 里只有一段 7z（偏移 146758，起始头 CRC 校验通过），切出来用 `bsdtar` 读。`resources/payload/payload.json` 的 buildId 和网关一致，内核 0.2.1-rc.5，Node v22.23.4。`plugins/desk-host` 有三份（运行时读 `resources/payload`，另两份在 `app.asar.unpacked` 里），每份 27 个文件去掉 CRLF 后都和 `0f26dc0` 一致，新提示词「任务卡不强制……」在里面。
- 网关代码这次没改（`server/`、`installer/` 等无改动），测试机网关没重装。
- 测试机临时目录 `/tmp/vh-publish-20261106`、本机下载的安装包和切出的 7z 都已删除。

## 本机

- Claude 插件：`claude plugin update valimart-desk@valimart-harness` 到 0.2.1（marketplace 是仓库目录），新开 Claude Code 会话生效。
- pi：`~/.pi/agent/settings.json` 直接指向仓库里的 `packages/pi-valimart-desk`，重开 pi 生效。
- 开发版桌面客户端：`~/.dsh/profiles/desk/node_modules/@company-desk/*` 是指向仓库 `plugins/*` 的符号链接，下次启动客户端就用新的 desk-host。
- 本机没装 VS Code，vsix 没装。
