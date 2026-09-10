# 公司网关跑在树莓派上（飞牛 OS ARM 版 + Docker）

> 结论先说：**服务端代码本身零第三方依赖、纯 JS（只用 `node:*` + 内置 `node:sqlite`），ARM64 原生执行，不需要模拟。**
> 唯一的坎是官方 Linux 网关发行包自带 `linux-x64` 的 Node 运行时，树莓派上会 `Exec format error`。
> 本目录用 Docker 换一个 arm64 的 Node，代码挂载跑——**不改一行服务端代码**。

评估依据（含代码行号）：`reports/2026-09-10-网关树莓派-ARM64-可行性.md`。

---

## 1. 前置条件

| 项 | 要求 | 检查 |
| --- | --- | --- |
| 硬件 | 树莓派 4B/5，建议 4GB 内存起 | — |
| 存储 | **数据目录放 SSD/NVMe，别放 SD 卡**（sqlite + 公司盘频繁小写伤卡） | `df -h` |
| 系统 | 飞牛 OS ARM 版（Debian 系）+ Docker | `docker version`、`uname -m` → 期望 `aarch64` |
| 网络 | 网关要能出公网到上游模型；员工机要能访问树莓派 | `curl -sI https://api.deepseek.com` |
| Node 版本 | 容器里是 `node:25-slim`，**必须 ≥ 22**（`node:sqlite` 的要求） | 已由镜像保证 |

**只跑服务端。** 员工机仍然是 Windows 上装 `valimart-harness-Setup.exe` 客户端，连到树莓派的 `http://<IP>:8790`。
客户端本身**不能**跑在树莓派上（Electron + node-pty/sharp/ripgrep 一堆平台原生包，没有 ARM64 发行版）。

## 2. 上手四步

```bash
# ① 把仓库放到飞牛上（SSH 或飞牛的文件管理器），例如 /vol1/docker/valimart-gateway
git clone <本仓库地址> /vol1/docker/valimart-gateway
cd /vol1/docker/valimart-gateway/deploy/raspberry-pi

# ② 准备配置：数据目录 + 密钥
cp .env.example .env
vi .env                      # GATEWAY_DATA=/vol1/docker/valimart-gateway/data（SSD 卷）
                             # 可选：DEEPSEEK_API_KEY / ANYSEARCH_API_KEY

cp config.local.example.json ../../server/config.local.json
vi ../../server/config.local.json    # publicUrl 改成 http://<树莓派IP或主机名>:8790
```

> ⚠️ `server/config.local.json` 这个文件**必须在 `docker compose up` 之前就存在**。
> compose 把它当文件挂载，若文件不存在，Docker 会在宿主机上创建一个**同名目录**，服务会起不来
> （报错形如 `EISDIR` / 读配置失败）。补救：`docker compose down`，删掉那个目录，按上面重建文件再起。
# ③ 起服务（--build 会构建 arm64 镜像）
mkdir -p /vol1/docker/valimart-gateway/data
docker compose up -d --build

# ④ 看日志确认起来了
docker compose logs -f --tail 50
```

看到这两行就算成功：

```
[gateway] valimart harness 网关已启动 http://0.0.0.0:8790（管理页 http://0.0.0.0:8790/admin）
[gateway] 首次启动：库里没有账号。打开管理页或客户端完成引导（设置公司名、初始管理员）。
```

然后浏览器打开 `http://<树莓派IP>:8790/admin` → 走首次引导设公司名 + 初始管理员账号。

## 3. 部署后必须自查（重要）

> **2026-09-10 已在真机跑通**：飞牛 OS ARM 版、Debian 12、aarch64、4 核、1.8 GB 内存，
> 地址 `http://10.56.41.60:8790`，容器 `Up (healthy)`，局域网内其它机器可直接访问管理页。
> 落地路径：应用 `/vol1/1000/harness/valimart-gateway`，数据 `/vol1/1000/harness/data`。

```bash
# 架构与 Node 版本：期望 arm64 + v25.x
docker exec valimart-gateway node -p "process.arch + ' ' + process.version"

# node:sqlite 可用（服务端持久化全靠它）
docker exec valimart-gateway node -e "import('node:sqlite').then(m => console.log('sqlite ok', !!m.DatabaseSync))"

# 健康检查：期望 ok:true + product
curl -s http://127.0.0.1:8790/health

# 确认数据落在挂载卷而不是容器层
docker exec valimart-gateway ls -l /data
ls -l /vol1/docker/valimart-gateway/data      # 宿主机上应看到 gateway.sqlite 和 drive/
```

真业务验收（这一步才是真的通）：员工客户端登录页填 `http://<树莓派IP>:8790` → 登录 → 新会话发一句 → 有回复。
回复通了 = 代理 + 记账 + 令牌链路都正常。

## 4. 四个必须知道的坑

1. **`config.local.json` 一定要关播种。** 仓库里的 `server/config.json` 是**开发配置**，带 `boss/boss123456` 等 7 个演示账号和示例公司盘；只有在打官方包时才会被收成生产模板。直接挂源码跑如果不写 `config.local.json`，**等于带着演示账号上线**。本目录的模板已经把 `seedAdmin/seedUsers/seedDriveSamples` 全部关掉。
2. **数据目录固定绑 `/data`。** 网关优先读 `DESK_GATEWAY_DATA` 环境变量（`server/src/config.js`），compose 里已经指到挂载卷。**别只依赖 `config.local.json` 的 `dataDir`**——两个都指到 `/data` 最稳，换存储路径时改 `.env` 里的 `GATEWAY_DATA` 即可。
3. **客户端「自动发现网关」在 Docker 里大概率不生效。** 网关开局域网发现信标（UDP 18790 + 组播 `239.255.87.90`），Docker bridge 网络下广播/组播基本出不来。→ **用 `http://<IP>:8790` 手动填**；不想要这个功能就在 `config.local.json` 里保留 `"lanDiscover": false`（模板已有）。
4. **别在这台 Pi 上点管理页的「内核试打补丁 / 发布」。** 那条链要用 npm 装 `@deepseek-ai/dsh` 及其原生依赖（`server/src/api.js` → `scripts/lib/kernel-prepare.mjs`），ARM64 上能否凑齐原生产物**没验证**，而且 Pi 上很慢。→ **内核构建继续在 Windows/x64 机器上做，再从那边发布到这台网关。**

## 5. 升级 / 备份 / 迁移

```bash
# 升级代码：pull + 重启（配置与数据都不动）
cd /vol1/docker/valimart-gateway
git pull
docker compose -f deploy/raspberry-pi/docker-compose.yml up -d --build

# 只想改 config.local.json：改完直接重启（它是挂载进来的，不用重新 build）
docker compose -f deploy/raspberry-pi/docker-compose.yml restart
```

备份：网关自带备份脚本，容器内可直接跑（数据 + 公司盘一起打 zip）：

```bash
docker exec valimart-gateway node scripts/backup-gateway.mjs \
  --data-dir /data --out /data/backups/latest.zip
# 然后从宿主机 CP 走那个 zip（在 /vol1/docker/valimart-gateway/data/backups/）
```

迁移到新机器 = 把数据目录整个拷过去 + 改 `publicUrl`，sqlite 和公司盘都是自包含的。

## 6. 排障对照表

> 下面前四条是 **2026-09-10 在真机（飞牛 OS ARM 版 + QNAP/飞牛 docker 代理）上实测踩到的**，不是推测。

| 症状 | 原因 / 处理 |
| --- | --- |
| 构建卡在 `load metadata for docker.io/library/node:25-slim` 然后超时 | 国内直连 Docker Hub 不通，飞牛的 `docker.fnnas.com` 代理也没配到 daemon 里。**两个办法**：① 飞牛面板里配镜像加速；② 直接从可达的镜像源拉基础镜像再打默认名：<br>`sudo docker pull docker.m.daocloud.io/library/node:25-slim`<br>`sudo docker tag docker.m.daocloud.io/library/node:25-slim node:25-slim`<br>或构建时指定：`docker compose build --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:25-slim` |
| 构建报 `unexpected status from HEAD request to https://docker.fnnas.com/v2/docker/dockerfile/manifests/1: 401 Unauthorized` | Dockerfile 第一行的 `# syntax=docker/dockerfile:1` 会去拉 frontend 元数据，被代理挡了。**本仓库的 Dockerfile 已删掉该行**（没用 heredoc / `RUN --mount`，不需要 frontend）。若你手上的副本还在，`sed -i '/^# syntax=docker\/dockerfile:1/d' Dockerfile` |
| 容器反复重启，日志 `Cannot find module '/app/server/src/index.js'` | `/app` 挂错了层级（`../..` 相对路径在「散文件」和「tar 解包」两种布局下层级不同）。**本仓库已改成 `.env` 里显式指定 `APP_DIR`**，别再用相对路径 |
| `docker` 报 `permission denied ... /var/run/docker.sock` | 当前用户不在 `docker` 组。`deploy.sh` 已自动探测并改用 `sudo`；或手动 `sudo docker compose ...` |
| `exec format error` | 架构不对：镜像/容器不是 arm64。确认 `uname -m` = `aarch64`，并且镜像是在这台上构建的（`docker image inspect valimart-harness-gateway:arm64 --format '{{.Architecture}}'` 期望 `arm64`） |
| 启动就退，日志 `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` | Node < 22。镜像必须是 `node:25-slim`，别换老的 |
| `EACCES` / `EROFS` 写文件失败 | 数据目录没指到可写卷。检查 `.env` 的 `GATEWAY_DATA` 和 `/data` 挂载 |
| 管理页能开但 logo 是空白 | `plugins/desk-ui/src/client/assets/` 没在 `/app` 里（源码部署必须带上这个目录） |
| 客户端搜不到网关 | Docker 下 UDP 发现失效，属正常。手动填 `http://<IP>:8790` |
| 员工连不上 | 飞牛防火墙没放行 8790：`sudo ufw allow 8790/tcp` 或飞牛防火墙面板加规则 |
| 数据"消失" | 忘了挂 `/data` 卷，数据写进容器层，容器一删就没 |

## 7. 这个目录里有什么

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | arm64 Node 运行时 + 架构自检（架构/`node:sqlite` 不对就在构建或启动时直接失败）；基础镜像可用 `--build-arg NODE_IMAGE=` 换源 |
| `docker-compose.yml` | 应用目录只读挂载（`APP_DIR`）+ 配置挂载 + 数据卷 + 健康检查 + 日志滚动 |
| `deploy.sh` | 一键部署：写配置、建数据目录、自动探测 `docker` 是否需要 sudo、构建、等健康检查 |
| `config.local.example.json` | 生产式配置模板（关播种 = 关演示账号/示例公司盘） |
| `.env.example` | `APP_DIR`（应用根，必须绝对路径）/ `GATEWAY_DATA`（数据目录）/ 端口 / 密钥 |
| `../../scripts/test/gateway-deploy-dryrun.mjs` | 本机干跑验收：用这套「生产式配置」拉起网关，验 `/health`、`needsSetup`、管理页品牌图、sqlite 落盘、不污染源码目录（**不依赖 Docker**） |

自检随时可跑：

```bash
node scripts/test/gateway-deploy-dryrun.mjs
```

## 8. 想让官方直接出 ARM64 网关包？

当前 `scripts/build-gateway-linux.mjs` / `scripts/lib/gateway-linux.mjs` 把架构写死成 x64（`installer/pins.json` 的 `nodeLinuxX64`），**没有 `npm run dist:gateway:arm64`**。要改的话：`pins.json` 加 `nodeLinuxArm64`（官方 `node-v25.2.1-linux-arm64.tar.gz`，sha256 见 `docs` 或 `https://nodejs.org/dist/v25.2.1/SHASUMS256.txt`）→ `ensureNode...` 参数化架构 → 产物名带 `arm64` → README 同步。约半天，改 4 处 + 加校验。有需要再提。
