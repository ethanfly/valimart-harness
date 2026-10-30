# 2026-10-30：网关部署到 HQT 本地测试机，排查管理页时好时坏

## 部署

- 目标 `root@192.168.100.71`（「HQT本地测试」，CentOS 7.9 / glibc 2.17 / systemd 219），目录 `/data/server/valimart-harness-getaway`（另有软链 `valimart-harness-gateway`）。
- 官方 Node ≥18 需要 glibc 2.28，改用 unofficial-builds `node-v22.14.0-linux-x64-glibc-217`，`node:sqlite` 可用。
- 本机库先 `PRAGMA wal_checkpoint(TRUNCATE)` 再 `VACUUM INTO` 出快照，连同公司盘一起拷过去。
- `config.local.json`：`host 0.0.0.0`、`port 8790`、`publicUrl http://192.168.100.71:8790`、`allowSeed true`、`httpKeepAlive false`。

## 现象

- 防火墙放行 8790 后，`/health`、图标等小返回 100% 成功；`/admin` 等大返回经常握手成功后零字节，等到超时。
- 浏览器里点「保存通道」后页面不刷新：服务端日志有 `编辑通道`，说明已经写入，只是返回丢了。

## 排查

- 绕开本机 Clash TUN（`curl --interface enp5s0`）结果一样。
- 服务器看到的对端是 `10.25.128.25`（NAT，源端口保留）。用源端口对照服务器上的 `ss`：失败的请求有的在服务器上根本不存在，有的停在 `SYN-RECV`、`FIN-WAIT-1`；客户端却都显示已连接 → 中间设备在替服务器应答握手。
- 用超长 404 路径控制返回大小：≤9KB 8/8 成功，12KB 0/8，14.5KB 1/8。和 `/health` 交替 12 轮：`/health` 12/12，`/admin`（gzip 后 31KB）4/12。
- 服务器路由只有一条默认路由 `192.168.100.1`；iptables 只对 `192.168.100.x` 等内网段有 DROP/REJECT，`10.25.x` 不受影响。

## 改动

- `server/src/http.js`：`sendBody`（按 `Accept-Encoding` gzip，≥1KB），`sendJson` 改走它。
- `server/src/admin-page.js`：管理页启动时预压，走 `sendBody`。
- `server/src/index.js`：`cfg.httpKeepAlive === false` → `Connection: close`。
- `server/test/http-compression.test.js`：压缩一致性、小返回不压、keep-alive 开关。
- 测试机原文件备份为 `*.bak-20261030`。

## 结论 / 待办

- gzip 缓解了问题，但没有根治：31KB 仍有一半以上失败。根因在 `192.168.100.1` 到 `10.25.128.25` 之间的设备（像 WAN 优化或代理类设备，突发超过约 10KB 就卡住），需要网管处理。

## 后续：发布客户端，网关改为安装包部署

- CI run 41032992273 成功。客户端从办公网直接 POST 到网关时，传到约 200MB 报 408（上传慢）。改成 scp 到服务器后在本机调发布接口，返回 200。
- 用 `buildGatewayLinux({ extractedRuntime: <glibc-217 Node 22.14> })` 打 `dist/valimart-harness-Gateway-linux-x64-0.1.0.tar.gz`（46MB）。
- 切换步骤：停旧服务并 disable → 旧目录改名 `.src-bak-20261030` → 预置 `server/config.local.json` 和 `state/data` → `DEST/STATE/LOGS` 指向原目录跑 `install.sh`。
- 坑：开发机工作区的 `install.sh` 是 CRLF，`set -eu` 报错，在服务器上 `sed` 去掉 CR 后才装上。已把本地三个文件恢复为 LF。
