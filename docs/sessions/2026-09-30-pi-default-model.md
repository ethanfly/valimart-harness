# 2026-09-30 pi CLI 打开是 DeepSeek，不是网关的默认模型（Grok）

## 现象

网关管理页 / `/api/models` 里公司默认模型是 `grok-4.7-build-fast`，桌面客户端也显示 Grok 4.7 为默认；但 pi CLI 打开、发第一条消息用的是 `valimart/deepseek-flash`。

## 排查（结论先给）

pi 的启动模型解析顺序（`@earendil-works/pi-coding-agent`）：

1. `--model` / `--models` / `enabledModels` 限定的 scoped models：命中 `settings.defaultModel` 就用它，否则用 **scoped[0]**（`dist/main.js:391`）。
2. 都没有 → 自动：**`availableModels[0]`**，也就是可用模型列表里的第一个（`dist/core/model-resolver.js:529`；`buildFallbackModel` 同理取 `providerModels[0]`）。
3. `settings.defaultModel`（`~/.pi/agent/settings.json`，UI 里 `/model` 按 **Ctrl+S** 才会写）——本次用户机器上没设。

而我们的 pi 扩展 `packages/pi-valimart-desk` 把网关目录**按网关给的顺序**注册给 provider：`server/src/api.js` 的目录是按通道顺序排的，DeepSeek 通道在最前 → `valimart/deepseek-flash` 成了第一个模型 → 自动启动模型就是它。

也就是说：`company.defaultModel` 从来没被 pi 侧用过，只有 `/desk-status` 把它打印出来；`/desk-login` 结束后还会主动 `pi.setModel(catalogModels()[0])`，把会话也切到 deepseek-flash。

证据（pi 会话 JSONL，`~/.pi/agent/sessions/<cwd>/<ts>_<id>.jsonl`）：

```json
{"type":"model_change","provider":"valimart","modelId":"deepseek-flash"}
```

对比：VS Code 插件一直是先读 `company.defaultModel` 的（`packages/vscode/src/models.js:11`），只有 pi 包漏了。

## 改法

`packages/pi-valimart-desk`：

- `lib/models.mjs` 新增三个纯函数：
  - `gatewayDefaultModelId(state)`：取 `state.company.defaultModel`，退回旧的顶层 `state.defaultModel`。
  - `orderByDefault(models, id)`：把默认模型**提到目录第一位**（不在目录里 / 已是第一个 / 没配 → 原样返回）。
  - `preferredModel(models, state)`：登录后要切的那个模型，默认不在目录里（例如只配了生图模型）就退回第一个。
- `extensions/index.ts`：`catalogModels()` 注册前先 `orderByDefault(..., gatewayDefaultModelId(state))`；`/desk-login` 用 `preferredModel(...)` 取代原来的 `catalogModels()[0]`。
- 不写用户的 `settings.json`：pi 的扩展 API 只有 `getSettings()` 读、没有写（`setModel` 只改当前会话，注释明确「不改变新会话的默认」）。靠「目录第一位」这条 pi 自己的语义就够，想固定别的模型用户在 `/model` 里 Ctrl+S 即可。

## 验证

- 单测：`node --test packages/pi-valimart-desk/test/pi-desk.test.mjs` → **24 pass / 0 fail**（新增 2 条：排序 + `preferredModel` 回退）。
- 端到端（同一账号、同一条命令，看 pi 会话里记录的起始模型）：
  - 修前：`pi --print "只回复：ok" --mode json` → 会话 JSONL `"provider":"valimart","modelId":"deepseek-flash"`。
  - 修后（先 `-e packages/pi-valimart-desk/extensions/index.ts` 跑一遍确认）：`"provider":"valimart","model":"grok-4.7-build-fast"`。
- 发布与升级：`packages/pi-valimart-desk` 版本 0.1.10 → **0.1.11**，`npm publish`（npmjs，账号 ethanfly）；等 registry 生效后 `pi install npm:pi-valimart-desk` 把本机 `~/.pi/agent/npm/node_modules/pi-valimart-desk` 升到 0.1.11；再用真实安装跑一次 `pi --print` → 起始模型 `grok-4.7-build-fast` ✓。

## 遗留

- 同事机器要生效：`pi install npm:pi-valimart-desk`（或 `pi update`）拉 0.1.11。
- 如果用户在某台机器上 `/model` 里 Ctrl+S 存过别的模型，pi 会优先用那个，属预期（我们不去覆盖显式默认）。
