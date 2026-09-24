# 第三方通知

本仓库 Mixed 首版**没有移植** dsh-agent-team-gui 或其他第三方编排源码。会话领取去重、取消收敛与用量归集只复用其公开思路，实现均为公司代码。

运行时依赖：

| 组件 | 来源 | 许可证 | 说明 |
|---|---|---|---|
| `@deepseek-ai/dsh` 及子包（含 hoisted `zod`） | 内核前缀 / `scripts/kernel/pin.json` 锁定 0.1.7-rc.1 | 以内核发布物为准 | Mixed 存储契约通过 junction 解析内核自带的 `zod`，插件目录不自带 `node_modules` |
| `@anweat/dsh-browser@0.1.11` | 内核 profilePlugins | 上游包自带 | 与 Mixed 无关 |
| `@anysearch/anysearch-dsh@0.1.4` | 内核 profilePlugins | 上游包自带 | 与 Mixed 无关 |

若后续实际拷贝 MIT 源码进仓库或安装包，必须在此列出锁定版本与版权声明。
