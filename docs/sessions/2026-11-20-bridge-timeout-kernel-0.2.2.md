# 2026-11-20 api-merge 报错的超时定位 + 内核升 0.2.2-rc.5

## 起因

用户拿了一张上游 `api-merge.ethan.team` 中转站的请求失败截图（grok-4.7，约 121.9s 后断开，「downstream request canceled」一类文案），问是不是 valimart harness 的请求时间限制导致的；并要求升级 deepseek harness 内核。

## 超时排查结论

链路：`Claude/DSH → 127.0.0.1:3425（本地桥）→ 192.168.100.71:8790（网关）→ api-merge.ethan.team/v1（上游中转）`。

- 网关 `server/src/llm-proxy.js`：`sendUpstream`/`fetchUpstream` 对普通聊天请求**没有**总超时，只在客户端断连时 abort。
- `server/src/index.js`：HTTP server 未设 `requestTimeout`（Node 默认 300s，只管请求体上传，与流式响应无关）。
- 真正的 120s 在本地桥 `packages/claude-valimart-desk/lib/bridge-server.mjs`：非流式 `timeoutMs: 120_000`，流式 `setTimeout(() => ac.abort(), 120_000)`。与截图 ~121.9s 高度吻合。
- DSH `dsh-llm-pi-ai` 默认流 idle 超时 300s，不是它。
- 截图是上游中转站的页面（用户确认），所以也不能排除中转站自身有 ~120s 限制。**要定论需中转站日志或一次端到端计时测试**。

**未做**：桥的 120s 写死值还没改（改的话建议做成可配置并区分流式/非流式）；没有跑端到端计时验证。

## 内核升级 0.2.1-rc.5 → 0.2.2-rc.5

`pin.json` 改版本号后 `npm run setup` 三次失败，逐条重审锚点（都是 0.2.2 源码/打包变化）：

1. `dsh-client-ui-chat`：client.js 变成单行 minify（反引号字符串、无空格）。四处加 0.2.2 变体：
   - `markdown-render-prop`：签名变成 `function AssistantMarkdown({blocks,streaming,textInteractionSource=false,interrupted,...`，`renderMarkdown` 插在 `interrupted` 后。
   - `assistant-markdown-slot-render`：`rendered.push(jsx(MarkdownText,{...,pathImages,textInteractionSource},i))` → `react.Fragment` 里调 `renderMarkdown(...)`。
   - `assistant-node-markdown-fallback`：实例化点 `(0,react_jsx_runtime.jsx)(AssistantMarkdown,{blocks:data.blocks,...` 前插 `renderMarkdown:(props)=>renderSlot(\`conversation.assistant.markdown\`,props,{fallback:...})`。
   - `assistant-markdown-child-slot`：注册点 children 末尾加 `conversation.assistant.markdown` 子槽。
2. `dsh-sandbox-local`：`materializeAclGrant` 重写，开头是 `let tempInsideWorkspace;`；grant 失败不再裸 `throw error`，统一走 `aclPreparationFailure(...)` 三处（create / add / cleanup），整段作为锚点、三处错误都包 `companyGrantError(workspaceRoot, error)`。
3. `dsh-fs-local`：UNC/拒绝访问回退的覆盖判定从 `mode !== void 0` 改成 `existingDestination`，加新变体保留 rename 回退语义。

预期跳过不变：junction mklink v3/v4 anchor-gone、dsh-browser settings target-missing。

## 验证

- `npm run setup`：新打 14 处、已有 9 处，exit 0。
- `npm run kernel:check`：`version=0.2.2-rc.5`，「✓ 版本正确、20 处补丁齐全」。
- 打过的 client.js / dsh-sandbox-local / dsh-fs-local `node --check` 通过；注入代码在位。
- `node --test scripts/test/kernel-patches.test.mjs`：18 pass（新增 3 条 0.2.2 fixture 用例）。
- 全量 `npm test`（TMPDIR 在仓库外）：706 项 700 pass / 3 fail / 3 skip——3 个失败是既有 Linux 问题（工作区写锁 mixed、npm PATH、voice 空格路径），与内核无关。
- 冒烟：`dsh --profile desk --port 3471` 启动零报错，desk-host/desk-image/desk-video 就绪，EthanApi 六模型路由正常。
- 本机内核 bin 链接之前是断的，setup 后已修复，`dsh --version` 输出 0.2.2-rc.5。

## 待办 / 提醒

- 已开的客户端/桥进程仍跑旧内核，要**重启客户端**才会加载 0.2.2。
- 桥的 120s 超时要不要放宽/可配置，等用户拍板；若 api-merge 中转站本身也有 ~120s 限制，放宽本地桥不一定够。
- 补丁集里 0.2.1 变体仍保留（双版本可打），下次上游再变 minify 形状时照旧加变体、别改旧锚点。

## 续：用户确认报错约 275–282s（非 121.9s）→ 真相是 300s 级超时，统一放宽到 600s

api-merge 第二张截图显示 grok-4.7 失败集中在 270–282s（输入 ≈4.11M token），与「DSH 端 300s 看门狗 abort、中转站晚 ~25s 才见到断开」吻合，不是桥的 120s。改动三层：

- **DSH 侧**：`plugins/desk-host/lib/index.js` 的 `configureLlmRoute` 给每个 provider 路由写 `streamIdleTimeoutMs: 600_000`（llm-pi-ai 默认 300s，逐 chunk 重置的 idleWatchdog）。本机现网 profile `~/.dsh/profiles/desk/cordis.patch.yml` 三个 `desk-gateway-*` provider 已手补同值，重启客户端即生效。
- **网关侧**：`server/src/llm-proxy.js` 新增 `upstreamFetch`（核心 `node:http/https` + `Response` 门面）替换 `sendUpstream` 里四处 `fetch`——undici 默认 headersTimeout/bodyTimeout 会在长停滞时掐断上游请求。核心 http 无闲置超时，只随客户端断连 abort；不自动跟重定向。
- **Claude 桥**：`packages/claude-valimart-desk` 的 `bridge-server.mjs` 两处 120_000 → 600_000；`gateway.mjs` 新增 `coreFetch`（同核心 http 实现），`request()` 与 `pipeStream` 都换过去，消掉桥内 undici 上限。
- 隐患备忘：内核里 pi-ai 走 openai 官方 SDK（`options.fetch` 默认全局 fetch/undici），若 undici 默认 body 闲置超时仍卡 300s，600s 只能救到 undici 那层——待真机验证；SDK 自带总超时默认 ~10min 与目标一致。后台跑了个 310s headers/body 探针验证 undici 默认。

## 部署与发布

- 网关 linux 包：`buildGatewayLinux({ extractedRuntime: '/tmp/gw-runtime/runtime' })`，runtime 是从 test-01 现装目录拉回来的 node v22.14.0（glibc-217）。
- 部署：`scp` 到 `192.168.100.71` → `/tmp/vh-gw-20261120` 解压 → `DEST=/data/server/valimart-harness-getaway STATE=$DEST/state LOGS=$DEST/logs sh install.sh` → 恢复覆盖前的 `config.json`（包内会盖掉机器上改过的那份，先备份再装）→ `systemctl restart TheDivaGateway`。PID 25480，journal 启动正常，EthanApi 六模型目录在，`/admin` 200。
- 客户端 Windows 包：本机 electron-builder 需 wine。没装 wine，走 **docker 本地镜像 wine shim**（`local/wine` = archlinux:base + aliyun 源装 wine；`/tmp/wine-shim/wine` 包装 `docker run --rm --user uid:gid -v /home/ethan -v /tmp`），`--config.win.signExecutable=false`（保留 rcedit 图标/版本资源、跳过签名）。产物 `dist/valimart-harness-Setup-0.1.0-20261120.0740.exe` 261,232,785 B。
- 已 POST `/api/admin/client/publish`：buildId `0.1.0+0.2.2-rc.5.20261120-0740.cec2ec67` 发布成功，previous 是 11-09 的 0.2.1-rc.5 包。
- 随后用户要求改走 CI：提交推送 main → release workflow（windows-latest 跑 `dist:client`+`dist:gateway`，artifact `windows-installers`，挂 `latest` Release）→ 下载正式包重新 publish 到网关。
