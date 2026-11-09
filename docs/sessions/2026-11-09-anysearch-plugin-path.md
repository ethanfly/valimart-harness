# 2026-11-09 Linux 内核前缀找不到 anysearch，网页搜索停在 DeepSeek

## 现象

桌面端 `web_search` 报 `DeepSeek search has no API key for "DEEPSEEK_API_KEY"`。管理页已经把默认搜索设成 AnySearch，profile 补丁也写了 `web-search-anysearch`。

## 根因

`installProfilePlugins` 把第三方插件装在 `<prefix>/node_modules`（本机是 `~/.company-desk/kernel/node_modules/@anysearch`）。

Linux / macOS 的 npm 前缀把 dsh 放在 `<prefix>/lib/node_modules/@deepseek-ai/dsh`。`profilePluginBundles`、`linkProfilePlugins`、`pluginVersionExemptions`、`missingProfilePlugins` 都用 `kernel.root` 的 `../..`，落到 `lib/node_modules`，插件被当成没装。

于是 desk profile 的 bundles 只有 `dsh-base` 和 `dsh-web-app`。`dsh-base` 的 `searchProvider` 是 `deepseek-official`。anysearch 自己的 `cordis.patch.yml`（把 searchProvider / fetchProvider 改成 anysearch）从未编进 profile。Windows 上 dsh 和插件在同一层 `node_modules`，所以 CI 打出来的包以前是好的；本机开发版和以后的 Linux / macOS 打包会漏。

另外 `linkKernelPeers` 只把 peer 链到 dsh 旁边。插件从真实路径往上只走到 `<prefix>/node_modules/@deepseek-ai`，Linux 上那一层原来是空的。

## 修法

`scripts/kernel/locate.mjs` 的 `profilePluginModules`：dsh 的上两级目录名叫 `lib` 时，改去 `<prefix>/node_modules`。上面四处查找和 peer 链接都走它。

## 验证

- `node --test scripts/test/bootstrap.test.mjs scripts/test/kernel-install.test.mjs`：24 pass，含一条 Linux 布局用例。
- 对本机前缀：`profilePluginModules` 指向 `~/.company-desk/kernel/node_modules`，bundles 含 `@anweat/dsh-browser` 和 `@anysearch/anysearch-dsh`，`missingProfilePlugins` 为空。
- 已刷新 `~/.dsh/profiles/desk`：package.json 的 bundles 写上这两个插件，anysearch 链接到内核前缀里的真实目录。要完整重启客户端，已开着的进程不会重载 bundle。

## 发布

推 `d4640a6` → release run [42554297856](https://github.com/ethanfly/valimart-harness/actions/runs/42554297856)：npm-pi、installers、vscode、release 全部通过。

- 安装包 `valimart-harness-Setup-0.1.0-20261109.0307.exe`，513,509,559 字节，sha256 `739acd3f92673a3f933019308691ff3e097b405d15f507221570642fca672a94`。本机与测试机上的文件、网关存档三处一致。
- 在测试机上用自带的 `runtime/bin/node` 把安装包 POST 到 `127.0.0.1:8790/api/admin/client/publish`。管理员令牌从本机登录态经 SSH stdin 传入，不进命令行、不落盘。接口返回 200，`publishedAt` 2026-11-09T03:16:47.411Z。
- `/api/client/current` 与 `/api/admin/client` 都是 buildId `0.1.0+0.2.1-rc.5.20261109-0307.2c130141`。`previous` 是 11-06 的 `0.1.0+0.2.1-rc.5.20261106-0324.14831d80`。网关仍留着 10-30 那版。
- 网关代码没改，`TheDivaGateway` 仍是 active。测试机 `/tmp/vh-publish-20261109` 和本机下载的安装包已删。
