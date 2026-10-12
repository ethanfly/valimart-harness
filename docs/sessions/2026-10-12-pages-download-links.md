# GitHub Pages 直链下载与项目 Star

- 更新 `docs/intro/index.html`：页面加载时请求仓库 `latest` Release API，并为 Windows 客户端、Windows 网关、VS Code 插件匹配当前附件，将下载入口直接指向 `browser_download_url`。客户端下载文件名带构建时间，按客户端附件前缀取值；网关和 VSIX 多版本时按语义版本取最新。
- API 失败或找不到附件时，下载入口退回 GitHub Releases 页面，并通过可访问的状态文本说明回退情况。
- 首页增加 GitHub 仓库按钮；Star 徽章由 Shields 动态显示。
- 同步更新 `docs/HANDOFF.md`。在线 API 验证 latest Release 含客户端 `valimart-harness-Setup-0.1.0-20261012.0207.exe`、网关 `valimart-harness-Gateway-Setup-0.1.0.exe`、VS Code 插件 `valimart-harness-0.3.1.vsix`。
- 验证：页面 2 段内联脚本语法通过；用在线 latest Release 的附件名称组成样例，确认 7 个下载入口都直达对应附件、VSIX 选中 0.3.1；模拟网络失败时入口回退 Releases 并显示状态说明；`git diff --check` 通过。
- 推送后由 `.github/workflows/pages.yml` 部署，并检查 Pages 工作流结果。
