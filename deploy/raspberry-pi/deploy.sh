#!/bin/sh
# valimart harness 公司网关 · ARM64 一键部署（树莓派 / 飞牛 OS ARM 版）
#
#   ./deploy.sh <树莓派IP或主机名> [数据目录] [仓库解包目录]
#
# 例：./deploy.sh 192.168.1.50
#     ./deploy.sh 192.168.1.50 /vol2/gw-data
#     ./deploy.sh 192.168.1.50 /vol1/docker/valimart-gateway/data /vol2/valimart-gateway
#
# 做四件事：① 写 server/config.local.json（publicUrl 换成真实地址）
#           ② 写 deploy/.env（数据目录）
#           ③ 建数据目录
#           ④ docker compose up -d --build
set -eu

HOST_ARG=${1:-}
if [ -z "$HOST_ARG" ]; then
  echo "用法：./deploy.sh <树莓派IP或主机名> [数据目录] [仓库解包目录]" >&2
  echo "例：  ./deploy.sh 192.168.1.50" >&2
  exit 64
fi

APP_DIR=${3:-$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)}
DATA_DIR=${2:-$APP_DIR/data}
PORT=8790

echo "== 部署参数 =="
echo "  对外地址   http://$HOST_ARG:$PORT"
echo "  程序目录   $APP_DIR"
echo "  数据目录   $DATA_DIR"
echo

# ---- 0. 环境自检 ----
command -v docker >/dev/null 2>&1 || { echo "!! 没找到 docker" >&2; exit 1; }

# docker 需要 root 时自动加 sudo（用户不在 docker 组是常见情况）
if docker info >/dev/null 2>&1; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  SUDO="sudo"
elif command -v sudo >/dev/null 2>&1 && [ -t 0 ]; then
  echo "  这台机器的 docker 需要 sudo，接下来会提示输密码"
  SUDO="sudo"
else
  echo "!! docker 需要 sudo，但当前不是交互终端。请改成：sudo sh deploy.sh ..." >&2
  exit 1
fi
if [ -n "$SUDO" ]; then
  DC="$SUDO docker compose"
  $DC version >/dev/null 2>&1 || { echo "!! 没找到 docker compose（v2）" >&2; exit 1; }
else
  DC="docker compose"
  docker compose version >/dev/null 2>&1 || { echo "!! 没找到 docker compose（v2）" >&2; exit 1; }
fi
echo "  compose    $DC"

ARCH=$(uname -m)
echo "  本机架构   $ARCH"
case "$ARCH" in
  aarch64|arm64) : ;;
  *) echo "!! 本机不是 arm64（$ARCH）。这套是给树莓派/ARM 准备的；x86 上跑请自行去掉架构相关假设。" >&2
     echo "   仍要继续？把下面这行的 exit 1 注释掉。" >&2
     exit 1 ;;
esac

for f in server/src/index.js server/config.json scripts/lib/lan-protocol.mjs deploy/docker-compose.yml deploy/Dockerfile plugins/desk-ui/src/client/assets/valimart-mark.png; do
  [ -e "$APP_DIR/$f" ] || { echo "!! 缺少文件：$APP_DIR/$f（解包不完整？）" >&2; exit 1; }
done
echo "  文件齐全   OK"

# ---- 1. 生产配置 ----
CFG="$APP_DIR/server/config.local.json"
if [ -f "$CFG" ]; then
  echo "== 已有 $CFG，只更新 publicUrl（其余字段保留）=="
  tmp="$CFG.tmp"
  if grep -q '"publicUrl"' "$CFG"; then
    sed "s#\"publicUrl\"[[:space:]]*:[[:space:]]*\"[^\"]*\"#\"publicUrl\": \"http://$HOST_ARG:$PORT\"#" "$CFG" > "$tmp"
  else
    sed "s#^{#{\n  \"publicUrl\": \"http://$HOST_ARG:$PORT\",#" "$CFG" > "$tmp"
  fi
  mv "$tmp" "$CFG"
else
  echo "== 生成 $CFG（关播种：不含演示账号与示例公司盘）=="
  cat > "$CFG" <<JSON
{
  "host": "0.0.0.0",
  "port": $PORT,
  "publicUrl": "http://$HOST_ARG:$PORT",
  "dataDir": "/data",
  "seedAdmin": false,
  "seedUsers": [],
  "seedDriveSamples": false,
  "packaged": true,
  "lanDiscover": false
}
JSON
fi
echo "  内容："
sed 's/^/    /' "$CFG"

# ---- 2. 环境变量 ----
ENVF="$APP_DIR/deploy/.env"
write_env() {
  cat > "$ENVF" <<ENV
APP_DIR=$APP_DIR
GATEWAY_DATA=$DATA_DIR
GATEWAY_PORT=$PORT
DEEPSEEK_API_KEY=
ANYSEARCH_API_KEY=
ENV
}
if [ -f "$ENVF" ]; then
  # 只更新路径类字段，已经填过的密钥保留
  grep -q '^APP_DIR=' "$ENVF" && sed -i "s#^APP_DIR=.*#APP_DIR=$APP_DIR#" "$ENVF" || sed -i "1i APP_DIR=$APP_DIR" "$ENVF"
  grep -q '^GATEWAY_DATA=' "$ENVF" && sed -i "s#^GATEWAY_DATA=.*#GATEWAY_DATA=$DATA_DIR#" "$ENVF" || echo "GATEWAY_DATA=$DATA_DIR" >> "$ENVF"
  grep -q '^GATEWAY_PORT=' "$ENVF" && sed -i "s#^GATEWAY_PORT=.*#GATEWAY_PORT=$PORT#" "$ENVF" || echo "GATEWAY_PORT=$PORT" >> "$ENVF"
  grep -q '^DEEPSEEK_API_KEY=' "$ENVF" || echo 'DEEPSEEK_API_KEY=' >> "$ENVF"
  grep -q '^ANYSEARCH_API_KEY=' "$ENVF" || echo 'ANYSEARCH_API_KEY=' >> "$ENVF"
  echo "== 更新 $ENVF（路径已刷新，密钥保留）=="
else
  write_env
  echo "== 生成 $ENVF（如需上游密钥，填好后再 restart）=="
fi
sed 's/^/    /' "$ENVF" | sed 's/\(API_KEY=\).*/\1***/'

# ---- 3. 数据目录 ----
mkdir -p "$DATA_DIR"
echo "== 数据目录就绪：$DATA_DIR =="

# ---- 4. 起服务 ----
cd "$APP_DIR/deploy"
echo "== 构建并启动（首次要拉镜像，慢）=="
$DC up -d --build

echo
echo "== 等健康检查 =="
i=0
while [ $i -lt 30 ]; do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "  健康检查通过"
    break
  fi
  i=$((i+1)); sleep 2
done
[ $i -lt 30 ] || echo "  !! 90 秒内没通过，看日志：$DC logs --tail 50"

echo
echo "================ 下一步 ================"
echo "1) 管理页（首次会引导设公司名与管理员）："
echo "   http://$HOST_ARG:$PORT/admin"
echo "2) 员工客户端登录页「公司网关」填："
echo "   http://$HOST_ARG:$PORT"
echo "3) 在管理页「模型」页接入 DeepSeek/OpenAI/订阅，否则客户端模型菜单是空的"
echo "4) 防火墙放行 $PORT/tcp"
echo
echo "常用："
echo "  cd $APP_DIR/deploy && $DC logs -f --tail 100    # 日志"
echo "  cd $APP_DIR/deploy && $DC restart               # 改完 config.local.json 后重启"
echo "  cd $APP_DIR/deploy && $DC down                  # 停止（数据不丢）"
