# 2026-09-29 网关管理页布局

## 目标

整理 `/admin` 的设置页面布局，让密集功能按用途分组，并改善宽屏、窄屏下的层次和换行。

## 改动

- `server/src/admin-page.js` 保留主导航和现有 API / 权限交互。
- 模型页新增模型通道、搜索密钥、模型目录三个 tab。
- 知识页新增查询与录入、知识合集两个 tab。
- 组织页新增人员、岗位、部门三个 tab。
- 概览页把服务器状态和公司盘并列展示；页面补充标题、栅格、间距和响应式样式。
- `server/test/gateway.test.js` 增加管理页子 tab 标记断言。

## 验证

- `node --test server/test/gateway.test.js`：16 pass，0 fail。
- `git diff --check`：通过。
