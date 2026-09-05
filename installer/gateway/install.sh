#!/bin/sh
# valimart harness 公司网关 — Linux x64
#   sudo sh install.sh
#   DEST=/opt/valimart-harness-gateway sudo -E sh install.sh
set -eu

SRC=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
DEST=${DEST:-/opt/valimart-harness-gateway}
STATE=${STATE:-/var/lib/valimart-harness-gateway}
LOGS=${LOGS:-/var/log/valimart-harness-gateway}
USER_NAME=${GATEWAY_USER:-thediva-gateway}

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行：sudo sh install.sh" >&2
  exit 1
fi

if [ ! -x "$SRC/runtime/bin/node" ]; then
  echo "缺少 $SRC/runtime/bin/node，请先完整解压发行包" >&2
  exit 1
fi

mkdir -p "$DEST"
if [ "$SRC" != "$DEST" ]; then
  (cd "$SRC" && tar cf - .) | (cd "$DEST" && tar xf -)
fi

if ! id "$USER_NAME" >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --home "$STATE" --shell /usr/sbin/nologin "$USER_NAME" 2>/dev/null \
      || useradd -r -d "$STATE" -s /usr/sbin/nologin "$USER_NAME"
  else
    echo "找不到 useradd，无法创建系统用户 $USER_NAME" >&2
    exit 1
  fi
fi

mkdir -p "$STATE/data" "$LOGS"
chown -R "$USER_NAME:$USER_NAME" "$STATE" "$LOGS"

"$DEST/runtime/bin/node" "$DEST/service/init-linux.mjs" "$DEST" --state "$STATE" --logs "$LOGS" --user "$USER_NAME"

if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  install -m 644 "$DEST/service/TheDivaGateway.service" /etc/systemd/system/TheDivaGateway.service
  systemctl daemon-reload
  systemctl enable --now TheDivaGateway
  echo "服务 TheDivaGateway 已启动。管理页见 $DEST/server/config.local.json 的 publicUrl/admin"
else
  echo "未检测到 systemd。可用以下命令前台运行："
  echo "  sudo -u $USER_NAME env NODE_ENV=production DESK_GATEWAY_PACKAGED=1 DESK_GATEWAY_DATA=$STATE/data $DEST/runtime/bin/node $DEST/server/src/index.js"
fi
