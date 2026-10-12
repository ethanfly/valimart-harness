# 订阅账号最近用量状态与官方实时额度

## 需求与决定

- 用户希望所有已接入订阅平台都显示账号额度，包含实时剩余额、恢复时间与官方查看入口。
- 手动刷新必须主动请求平台当前数据，不能重读网关缓存。用户允许复用官方客户端内部接口，并接受接口可能变化或失效。
- 网关历史调用状态与平台官方额度分开展示；平台查询失败时显示错误，不把旧余额伪装成实时数据。OAuth 令牌和上游原始响应始终留在网关。

## 实现

- `server/src/subscription-usage.js`：服务端适配 ChatGPT `wham/usage`、Claude OAuth usage、Grok Build billing、Gemini Code Assist `retrieveUserQuota` 与 Antigravity `retrieveUserQuotaSummary`，归一化额度、余额和恢复时间。每次请求有 15 秒超时并只返回稳定字段。
- `server/src/api.js`：新增管理员接口 `POST /api/channels/:id/usage/refresh`。可指定 `accountId` 查询单账号，也可不指定以并发查询该通道所有账号；每个账号各自返回成功或错误。查询前在网关侧续期 OAuth，并使用最新令牌。
- `server/src/index.js`：允许注入 `fetchUsage`，便于服务端测试使用模拟官方响应。
- `server/src/oauth-subscribe.js`、`server/src/channels.js`：保存 Grok 账号用户 ID，保留 Google 项目 ID，以供账号级额度查询；账号令牌不会进入公开通道视图。
- `server/src/admin-page.js`：管理员可逐账号手动刷新，多个账号时也能整通道刷新。显示本次查询时间、平台返回的各额度窗口/余额/恢复时间与官方入口；刷新时先清掉页面内旧结果并显示请求状态。
- 同时保留此前网关模型调用状态功能：成功响应后记为最近可用，配额耗尽后记为受限；成功状态最多每 5 分钟写一次。服务端配置通道若没有独立 OAuth 账号记录，会提示无法按单账号查询。

## 验证与限制

- 新增适配器解析测试，覆盖 ChatGPT、Claude、Grok、Gemini、Antigravity，及令牌错误打码；网关测试覆盖管理员刷新路由、官方请求参数和凭据不回传。
- 专项测试 23/23 通过；全量 `npm test` **600 pass / 0 fail / 1 skip**。修改的服务端 JS 语法检查与 `git diff --check` 通过。
- 未使用真实订阅账号做在线探测。产品内部接口可能变更、限流或拒绝某些授权客户端；届时卡片显示官方错误，不展示缓存余额。
- 未打网关安装包或发布。
