# 2026-11-05 测试机部署 TencentDB Agent Memory

**2026-11-06 已回滚。** 网关代码恢复为只走公司盘，测试机容器 `tdai-memory-core` / `tdai-memory-hub` / `tdai-proxy` 已删除。数据卷和安装目录还在，没有 `--purge`。下面是当时的过程，不要按它再接一遍。

目标：把 [TencentDB Agent Memory](https://tencentcloud.github.io/TencentDB-Agent-Memory/docs) 装到公司网关同一台测试机，网关可以选这套记忆，并和公司盘（含知识库）双向迁移。

## 部署

- 机器 `192.168.100.71`，服务 `TheDivaGateway`，目录 `/data/server/valimart-harness-getaway`。这台原先没有 Docker。
- 安装 `docker-ce-20.10.24`（阿里云源；`containerd.io` 第一次校验失败，导入 GPG 后重试成功）。`/etc/docker/daemon.json` 写了 DaoCloud 镜像，但该镜像不在白名单，Docker Hub 从机房超时。
- 镜像在办公网本机 `docker pull`（core 1.32GB、hub 2.02GB、proxy 1.02GB），再 `docker save | ssh docker load`。
- 脚本是仓库 `deploy/global-images` 提交 `2002196f`，放在 `/data/server/tdai-agent-memory`。`.env` 的 LLM 用网关 `channels.json` 里 `custom-ethanapi` / `deepseek-v4.1-flash`，密钥只留在服务器。
- `./start-memory-core.sh` 然后 hub、proxy。admin 用户已初始化。另建团队 `team-a6mok4grhu`、Wiki `wiki-43luvgwt`。
- 容器 `--restart unless-stopped`。

## 网关

- 新模块 `server/src/memory-backend.js`。管理页增加「记忆系统」。默认 `active=drive`，避免未迁移就改掉现有检索。
- 选 `agent-memory` 时 `/api/knowledge/search` 用 Wiki 搜索，任务卡仍走本地。迁移：`POST /api/admin/memory/migrate`，方向 `to-agent-memory` / `to-drive`。文件名用 `__` 代替 `/`，以便迁回原路径。
- 测试机上的 `server/src/{index,api,admin-page,memory-backend}.js` 已换成工作区版本并 `systemctl restart TheDivaGateway`。`/health` 200。设置文件 `state/data/memory-backend.json`。
- 单测 `server/test/memory-backend.test.js` 5 pass。未提交。

## 办公网访问

服务器本机 `8125/8420/8424` 返回 200。办公网连接被拒（约 10ms）。iptables 已在 `8790` 规则后放行 `8125,8420,8424,8096`，`/etc/sysconfig/iptables` 里没有 `8790`，这条规则重启可能丢。中间设备仍不转发这些端口。网关集成走 `127.0.0.1`，不受影响。

## 同日：表单和全量迁移

管理页记忆系统表单改成「当前使用 / 密钥 / Wiki」三格，连接和迁移分成两段，范围用胶囊勾选，个人记忆和任务卡默认包含。

迁到 `wiki-43luvgwt`：729 个原文。知识服务的 raw/write 不传 `encoding` 时把正文当 base64，公司盘文本必须带 `encoding: utf8`。超过 500KB 的会截断后写入（一份个人笔记、一张任务卡的工作日志）。检索开关仍是公司盘，没有改 `active`。


## 2026-11-06：对话改走 MemoryCore，不再把每轮当 Wiki 素材

整库 `raw/write` + ingest 是文档冷启动，不是「给 Agent 装记忆」。官方用法在 MemoryCore（`8420`）：

- 发给模型前并行 `POST /v3/atomic/search`、`/v3/core/read`、`/v3/scenario/ls`，拼进系统提示。
- 本轮成功结束后只把用户原话和助手最终正文 `POST /v3/conversation/add`。召回内容不写回。同一句用户原话在工具来回里只留最后一次回复。
- 隔离是 `team_id` + `agent_id`（默认 `valimart-desk`）+ 登录用户名。会话用请求头 `x-desk-session`，没有就用 `desk:<用户名>`。
- Core 鉴权用 `coreKey`，留空则用 knowledge key。召回失败不挡对话。

Wiki 检索和公司盘迁移保持原样。`server/test/memory-chat.test.js` 覆盖召回、去重写入、非流式和流式。未提交。
