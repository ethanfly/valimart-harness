---
name: grok-imagine
description: >-
  生图 / 出图 / 画一张 / 修图 / 改图 / 生视频 / 做视频时用。生图、修图优先调用公司客户端生图插件（desk-image）注册的 image_generate / image_edit：模型与比例按「设置 → 生图」里的配置（默认短名 gpt / qwen / grok，或公司目录里的真实 id），不要写死厂商；视频走公司网关 /v1/videos/generations（grok-imagine-video-1.5）。不要切会话模型，不要 chat/completions，不要直连 xAI / OpenAI / 通义。
whenToUse: 用户说生图、出图、画一张、修图、改图、生视频、做视频、Imagine、image_gen、image_to_video；需要照片、插画、角色、场景、装饰图或短镜头动画时。
---

# 生图 / 视频：按「设置 → 生图」的插件配置走公司网关

技能目录名 `grok-imagine` 是历史名，**模型不再写死成 Grok**。生图走公司客户端生图插件 `@company-desk/desk-image`（注册 `image_generate` / `image_edit`）：模型、比例、短名别名都读「设置 → 生图」，技能不另外维护一份模型清单。

## 默认路径：调工具，不传 model

| 需求 | 用法 |
| --- | --- |
| 文生图 | `image_generate({ prompt, out, aspect_ratio? })` |
| 图生图 / 修图 | `image_edit({ prompt, image: "参考图路径", out })` |

- **不要传 `model`**，除非用户点名某个模型；缺省就是设置里的默认。
- `aspect_ratio` 只在用户有明确构图要求时传（头像 `1:1`、封面 `16:9`、竖图 `9:16`、插画 `4:3` / `3:4`）；不传就用设置里的默认比例。
- 上游对比例的支持不一致：`grok` 通道认 `aspect_ratio`；OpenAI 风格的 `gpt-image-2` 目前忽略它、按模型默认尺寸出图。要精确比例时先说清，或改用认这个参数的模型。
- 工具把请求发到公司网关 `/v1/images/generations`（修图 `/v1/images/edits`），图片写进会话工作目录；返回值里已经带好 Markdown 展示行，直接用到最终回复。
- `out` 用相对工作目录的文件名（如 `poster.jpg`），工具按工作目录做路径校验，不要写盘外路径。

## 现在用的是哪个模型：读插件配置

`GET http://127.0.0.1:3470/desk/api/image/config`（端口 = 本机工作台 Web 端口，由客户端插件提供）

```json
{
  "defaultModel": "gpt",
  "aspectRatio": "1:1",
  "aliases": { "gpt": "gpt-image-1", "qwen": "qwen-image", "grok": "grok-imagine-image-2.0" },
  "customModels": [],
  "models": [{ "id": "gpt-image-2.0", "name": "GPT Image 2.0" }],
  "resolvedDefault": "gpt-image-2.0"
}
```

- 报「用了哪个模型」时以 **`resolvedDefault`** 为准；`defaultModel` 只是设置里的短名。
- 短名解析顺序：真实 id 精确匹配 → `aliases` 覆盖 → 家族候选（插件 `models.js` 的 `FAMILY_ALIASES`）→ 目录里模糊匹配。别名指向目录里没有的 id 时会继续往后落，不会静默换厂商。
- 改模型 / 比例：设置 → 生图（管理员）。**不要在技能里写模型 id。**

## 工具不可用时：脚本

别的机器、纯 shell、插件没加载时用脚本 —— 它读同一份配置，不写死厂商：

```bash
node scripts/generate.mjs --prompt "一只橙猫坐在窗台，下午阳光，写实" --out cat.jpg
node scripts/generate.mjs --prompt "同上，改成夜晚霓虹" --edit cat.jpg --out cat-night.jpg
node scripts/generate.mjs --prompt "…" --ratio 3:4 --out poster.jpg      # 只覆盖比例
node scripts/generate.mjs --prompt "…" --model qwen --out cat.jpg        # 用户点名才覆盖模型
```

- 模型优先级：`--model` → 插件配置 `resolvedDefault` → 设置里的 `defaultModel` → 公司目录第一个生图模型。
- 比例优先级：`--ratio` → 设置里的 `aspectRatio` → `1:1`。
- 配置来源：插件接口 → `~/.dsh/settings.yaml` 的 `desk-image` 段 → 兜底；模型目录从 `desk-state.json` 的 `company.models` 取。
- stderr 打 `模型=<id> 比例=<ratio> 配置来源=<…>`，stdout 只给写盘绝对路径。
- 扩展名按真实字节定（网关可能返回 JPEG），所以 `--out` 写 `.jpg` 也安全。

再兜底才直连网关：基址 `gatewayUrl`（本机常见 `http://127.0.0.1:8790`），令牌 `DESK_GATEWAY_TOKEN` 或 `~/.dsh/desk/desk-state.json` 的 `gatewayToken`（不是 sessionToken）；`POST /v1/images/generations`，body 字段与脚本一致。

## 出图报 media_unsupported / 404 / 405 怎么办

出图只走三类通道，其余（anthropic / gemini 订阅等）一律不支持：

- **OpenAI 兼容通道**：网关直接转发 `/v1/images/*`（如 `grok`、key 通道的 `gpt-image-2`）。
- **ChatGPT 订阅（Codex）**：网关用 Responses 的 `image_generation` 工具出图（如 `gpt-image-2.0`）。
- **DashScope（阿里云百炼）**：网关走原生 `multimodal-generation` / `text2image` 接口（如 `qwen-image-3.0`）。

报错多半是通道能力或 key 的问题，不是技能或提示词的问题：换用户点名的可用模型，或让管理员修通道。不要静默改写设置，也不要在技能里写死模型 id。

## 视频

插件没有视频接口，走脚本 → `POST {gatewayUrl}/v1/videos/generations`，模型固定 `grok-imagine-video-1.5`。

```json
{ "model": "grok-imagine-video-1.5", "prompt": "一只橙猫在窗台上慢慢走过，阳光，缓慢推进镜头", "duration": 6, "aspect_ratio": "16:9" }
```

```bash
node scripts/generate-video.mjs --prompt "橙猫走过窗台，缓慢推进" --out cat.mp4 --duration 6 --ratio 16:9
node scripts/generate-video.mjs --prompt "镜头缓缓前推" --image first-frame.png --out shot.mp4
```

有 `--image` 就是图生视频，没有则文生视频。`duration` 只用 `6` 或 `10`（默认 6）。镜头提示写现在时、一句动作 + 一个运镜。

## 何时用代码而不是生成

精确文字、真实数据图表、标注示意图、屏幕文案：用 HTML/CSS 或代码出图。照片、插画、角色、场景、装饰图、短镜头动画：用本技能。

## 提示词

用户给了完整提示词就原文用。生图写 2–5 句：主体 → 动作/姿态 → 场景 → 风格 → 构图 → 光影。视频写 1–2 句现在时，一个主体 + 一个简单运动/运镜。正面描述，不要堆负面词。

真实人物：不要纯文生；用用户照片。系列镜头先出锚图/首帧，再 edits / 视频，不要每次全新生成。安全拦截不要换词重试。额度满了是 429。

## 自检

- [ ] 生图 / 修图走 `image_generate` / `image_edit`（或脚本 → `/v1/images/*`），**没传 model，或 model 是用户点名的**
- [ ] 报出的模型 = 插件配置的 `resolvedDefault`，比例 = 用户指定或设置默认
- [ ] 视频走 `/v1/videos/generations`，模型 `grok-imagine-video-1.5`
- [ ] 没有切会话模型、没有 chat/completions、没有直连上游
- [ ] 磁盘上有文件且扩展名与真实字节一致；最终回复用 Markdown `![说明](相对路径)` 展示
