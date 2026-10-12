# 2026-10-08 desk-video

照 desk-image 加公司生视频插件，不装第三方 BYOK 插件（密钥必须留在网关）。

- `plugins/desk-video`：`video_generate` + `/desk/api/video` + 设置页/输入框芯片。短名 wan、qwen、minimax、grok、gpt、seedance。多参考图最多 4 张。
- 长视频不是一家上游的原生能力：按模型单段上限切段，逐段打网关，ffmpeg concat 拼回一个 mp4。本机没 ffmpeg 会报 `concat_failed`。
- `server/src/upstream-video.js` 补万相 / MiniMax / Seedance 的异步协议。Grok、Sora 继续透传 `/videos/generations`。
- 目录里没有的模型解析为 null，不落到别的厂商。管理员要先在通道里接入对应上游。

2026-10-09：`npm run dist:client` 已打并发布 `0.1.0-20261009.0223`（buildId `0.1.0+0.2.0-rc.2.20261009-0223.83eba77e`）。此前 10-08 已发过多轮，最后停在 `0804`。真上游冒烟仍未做。
