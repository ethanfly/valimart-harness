#
# valimart harness 公司网关 · ARM64（树莓派 / 飞牛 OS ARM 版 / 群晖 ARM）
#
# 为什么需要这个镜像：官方 Linux 网关发行包自带的是 linux-x64 的 Node 运行时，
# 在 ARM64 上直接 `Exec format error`。服务端代码本身是零第三方依赖的纯 JS
# （只用 node:* 内置模块 + node:sqlite），换一个 arm64 的 Node 就能原生跑，不需要模拟。
#
# 构建的镜像里不放业务代码：代码从宿主机挂载（改代码 = git pull + 重启容器）。
# 镜像只负责提供 arm64 的 Node 运行时。
#
#   docker build -t valimart-harness-gateway:arm64 .
#
# 特意不写 `# syntax=docker/dockerfile:1`：飞牛等环境把 docker.io 走本机代理，
# 拉 frontend 元数据会 401，而本文件没用 heredoc / RUN --mount，不需要 frontend。
#
# Node 必须 >= 22：服务端用内置的 node:sqlite（server/src/store.js）。
# 基础镜像是官方 node:25-slim（Debian 系，飞牛 OS 同为 Debian，glibc 对齐，不引入 musl）。
# 国内直连 docker.io 不通时，换成可达的镜像源：
#   docker build --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:25-slim -t valimart-harness-gateway:arm64 .
ARG NODE_IMAGE=node:25-slim
FROM ${NODE_IMAGE}

WORKDIR /app

# curl 只给健康检查用；其余什么都不装（服务端零 npm 依赖，不需要 npm install）
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl; \
    rm -rf /var/lib/apt/lists/*

# /app      = 只读代码（挂载）
# /data     = 数据目录 gateway.sqlite + 公司盘（挂载，务必放 SSD）
ENV NODE_ENV=production \
    DESK_GATEWAY_PACKAGED=1 \
    DESK_GATEWAY_DATA=/data

# 架构自检：镜像/容器架构不对时构建或启动就炸，不要等到业务请求才发现
RUN node -e "if (process.arch !== 'arm64') { console.error('这个镜像要在 arm64 上跑，当前: ' + process.arch); process.exit(1) }" \
 && node -e "import('node:sqlite').then(m => { if (!m.DatabaseSync) process.exit(1); console.log('node:sqlite ok · ' + process.version + ' · ' + process.arch) })"

EXPOSE 8790
# 18790/udp = 局域网发现信标，Docker bridge 下基本出不来，见 deploy/raspberry-pi/README.md
EXPOSE 18790/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8790/health || exit 1

CMD ["node", "server/src/index.js"]
