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
