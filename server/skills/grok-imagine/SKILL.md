---
name: grok-imagine
description: >-
  默认通过公司网关调用 Grok Imagine：生图 grok-imagine-image-2.0，视频 grok-imagine-video-1.5。用户说生图、出图、画一张、修图、改图、生视频、做视频、Imagine、image_gen、image_to_video 时使用。只走公司网关 /v1/images/* 或 /v1/videos/generations，不要切会话模型，不要用 chat/completions，不要直连 xAI / OpenRouter。
---

# Grok 生图 / 视频（默认：公司网关）

**默认路径就是公司网关媒体接口。** 不要把当前对话模型切成 Imagine 模型，不要直连 `api.x.ai`，不要走 OpenRouter，不要用 `/v1/chat/completions`。

- 生图默认模型：`grok-imagine-image-2.0`
- 视频默认模型：`grok-imagine-video-1.5`

密钥只在网关；客户端只用网关令牌。用户点名公司目录里的其他媒体模型时才换 id。

## 何时用代码而不是生成

精确文字、真实数据图表、标注示意图、屏幕文案：用 HTML/CSS 或代码出图。照片、插画、角色、场景、装饰图、短镜头动画：用本技能走公司网关。

## 调用（默认）

基址：公司网关 `gatewayUrl`（本机常见 `http://127.0.0.1:8790`）。令牌：`DESK_GATEWAY_TOKEN`，或 `~/.dsh/desk/desk-state.json` 的 `gatewayToken`（不是 sessionToken）。

### 生图

**文生图** `POST {gatewayUrl}/v1/images/generations`

```json
{
  "model": "grok-imagine-image-2.0",
  "prompt": "…",
  "n": 1,
  "aspect_ratio": "1:1",
  "response_format": "b64_json"
}
```

**图生图 / 修图** `POST {gatewayUrl}/v1/images/edits`，另加 `image`（data URL 或 base64）或 `images` 数组。只写要改的部分。

`aspect_ratio`：`1:1` 头像/图标，`16:9` 横图/封面，`9:16` 竖图/故事，`4:3` / `3:4` 插画。

```bash
node scripts/generate.mjs --prompt "一只橙猫坐在窗台，下午阳光，写实" --out cat.png --ratio 1:1
node scripts/generate.mjs --prompt "改成夜晚霓虹" --edit ref.png --out night.png
```

### 视频

**默认** `POST {gatewayUrl}/v1/videos/generations`，模型必须是 `grok-imagine-video-1.5`（不传 model 时网关也回落到它）。

```json
{
  "model": "grok-imagine-video-1.5",
  "prompt": "一只橙猫在窗台上慢慢走过，阳光，缓慢推进镜头",
  "duration": 6,
  "aspect_ratio": "16:9"
}
```

可选 `image` / `image_url`：有首帧就图生视频，没有则文生视频。`duration` 只用 `6` 或 `10`（默认 6）。镜头提示写现在时、一句动作 + 一个运镜。

```bash
node scripts/generate-video.mjs --prompt "橙猫走过窗台，缓慢推进" --out cat.mp4 --duration 6 --ratio 16:9
node scripts/generate-video.mjs --prompt "镜头缓缓前推" --image first-frame.png --out shot.mp4
```

把返回的 `data[].url` 下载成 `.mp4`，或把 `b64_json` 写成文件。回复里给路径；绑了任务卡再用 `company_task_attach`。

## 提示词

用户给了完整提示词就原文用。生图写 2–5 句：主体 → 动作/姿态 → 场景 → 风格 → 构图 → 光影。视频写 1–2 句现在时，一个主体 + 一个简单运动/运镜。正面描述，不要堆负面词。

真实人物：不要纯文生；用用户照片。系列镜头先出锚图/首帧，再 edits / 视频，不要每次全新生成。安全拦截不要换词重试。额度满了是 429。

## 自检

- [ ] 生图走了 `/v1/images/generations` 或 `/v1/images/edits`，模型 `grok-imagine-image-2.0`
- [ ] 视频走了 `/v1/videos/generations`，模型 `grok-imagine-video-1.5`
- [ ] 没有切会话模型、没有 chat/completions、没有直连上游
- [ ] 磁盘上有 PNG 或 MP4，回复里有路径
