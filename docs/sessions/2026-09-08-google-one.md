# Google One / Gemini 订阅接入

> 后续实测更正（2026-09-08）：本文前面的实现/打包记录是过程记录，不能视作个人订阅接入成功。用户在官方 Gemini CLI 收到明确停用提示后，核实 Google 已于 2026-06-18 停用个人 Code Assist / AI Pro / Ultra 的旧客户端登录，必须迁移到 Antigravity。先前依据旧登录文档选错了个人订阅接入路径，项目 ID 和轮询修复无法恢复停用服务。当前尚未实现 Antigravity 集成，个人订阅原始需求未完成。官方依据：https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals 。

用户要求在当前项目「加入订阅」中增加 Google One / Gemini。

- 新增 `gemini` 默认订阅通道及 Google OAuth provider。默认使用 Gemini CLI 的公开 installed-app OAuth 配置，PKCE + 完整回调网址粘贴，强制校验 state；Google token endpoint 使用表单 client secret，申请离线续期权限。
- 新增 Code Assist 传输适配：账号项目识别、必要时首次开通、非流式/流式回复转换、工具调用及 thought signature 往返、base64 图片、结构化输出和用量统计。未启用额外付费 AI credits。
- 账号 Google subject 用于重登去重，项目按账号持久化；续期和额度耗尽后的账号切换沿用现有网关逻辑。凭据仍只保存于服务端。
- 客户端设置与管理页说明 Google AI Pro / Ultra、完整 localhost 回调网址及模型权限范围。管理页弹窗增加高度限制/滚动，解决长模型列表导致接入按钮超出视口。
- README 补接入步骤、OAuth/项目配置、默认候选模型和升级说明。

验证：

- 相关回归 28/28：`upstream-gemini`、`oauth-gemini`、`oauth-refresh`、`upstream-models`、`channels-models`。
- `npx playwright test e2e/google-one.spec.js` 通过：真实浏览器点击完整接入流程、本地模拟 Google OAuth/Code Assist、网关流式/非流式调用和两笔账本验证。截图位于忽略目录 `test-results/google-one-connected.png`。
- 使用本机已安装内核的 `convertMessages` 验证长 Google tool signature 可从回复穿过内核工具历史再转回 Gemini 请求。
- `npm run build` 成功，`git diff --check` 无空白错误。
- 全量运行（最后新增一个多账号专项测试之前）300 项：293 通过、1 跳过、6 失败；失败与已有交接记录一致：5 项 Grok 图片/视频路由测试、1 项管理页旧文案断言。日志在忽略目录 `build/google-one-tests.log`。

限制：未使用真实 Google 账号验证公网 OAuth 和付费权益。Google Code Assist 是 Gemini CLI 使用的内部协议，默认模型列表是候选列表，实际可用性以账号返回为准。需要重启网关并刷新客户端；自定义整个 `channels` 数组的配置需同步新增条目。未提交。

## 同日 Windows 安装包

用户随后要求打包客户端与服务端，已执行 `npm run dist`：

- 客户端：`dist/valimart-harness-Setup-0.1.0-20260908.1147.exe`，build ID `0.1.0+0.1.2-rc.1.20260908-1147.426f9d82`，包含当前工作区前端/桌面改动与 Google One 接入入口。
- 服务端：`dist/valimart-harness-Gateway-Setup-0.1.0.exe`，包含 Google OAuth provider、Code Assist 适配和默认通道配置。
- 内核 0.1.2-rc.1，18 处补丁校验通过；客户端资源与源码字节比较一致。服务端使用包内 Node v26.7.0 启动临时实例，通过管理页 HTTP 200、Google OAuth 配置与空账号生产初始化检查。未安装到本机正在使用的应用/服务。
- 两个安装包进行 7-Zip 完整性校验，SHA256 校验文件为 `dist/SHA256SUMS-20260908.1147.txt`。

## 个人 Google 账号未返回项目的排查

用户在本机安装版上报「未能获取 Google Cloud 项目」，确认使用个人 Gmail 的 Google AI Pro / Ultra。本机服务运行于 `D:\Program Files\valimart harness Gateway`；当前进程无权限读取 ProgramData 服务日志，因此没有获得该账号的实际 Google 响应，不能判定具体根因。

发现并修复可复现的初始化缺陷：初次 `onboardUser` 返回任务名称后，后续轮询若省略 `name`，原实现会提前退出。现在持续轮询首次返回的任务名称直到完成或现有超时终止；兼容字符串/对象项目字段；开通已完成但未附带项目时，最多复查三次账号状态。复查仍无项目则明确提示 Google 端未分配，不把个人账号一概引导到自建项目。

12 项 Google 专项测试通过，包括多轮无 name 响应、项目字段格式、延迟可见与始终无项目。重新打包服务端；用户需覆盖安装修复包后重新登录。若仍失败，用同一账号通过官方 Gemini CLI 登录并实际对话，以区分账号开通问题与网关适配问题。客户端无需更新。
