# 2026-10-12 提交 / 推送与客户端产物保留规则

用户要求提交并推送代码，GitHub 自动构建的客户端只保留最新版。

## 现状与修改

- 当前 main 与 origin/main 起点一致；工作区积累了生视频、媒体历史 / 会话 tab、工作区排序、网关协议 / 出站代理及管理页布局修改，一并提交。
- GitHub 只有 `latest` Release，但客户端文件名含时间戳，已有 18 个 exe；`replacesArtifacts: true` 只替换同名附件，因此旧客户端一直累积。
- 发布开启上传错误失败；成功后用 github-script 验证本次唯一客户端处于 uploaded，再按严格客户端文件名匹配删除其余客户端。网关和 VS Code 附件保留。
- Actions 只清理更早运行的 `windows-installers`，保留当前 / 更晚运行和其他名称的产物；Windows artifact 设置 retention-days 为 3。只给 release job 增加 actions: write。
- 在线清理 17 个历史客户端，保留 `valimart-harness-Setup-0.1.0-20261003.1500.exe`，同时清理旧 Windows artifacts。

## 验证

- `npm run build` 成功；`git diff --check` 成功。
- 首次 npm test：589 pass / 1 fail / 1 skip，失败是未修改的 Mixed 换账号测试读身份落盘的时序断言。该文件单独复跑 30/30；全量复跑 590 pass / 0 fail / 1 skip。
- 新增清理脚本测试 3/3：成功时只删目标历史包；上传不完整不删除；无客户端 / 多个客户端不删除。直接执行工作流原脚本，覆盖其他附件与当前 / 更晚运行保护。
- `fnos-probe.mjs` 是临时浏览器探测脚本，留本地不提交。
