#!/bin/sh
# 树莓派网关出口代理：mihomo + 双订阅 + 节点面板 + 导入订阅页
#   sudo sh setup-mihomo.sh
set -eu

CLASH=/vol1/1000/valimart-clash
NET=vmgw-net
IMG_SRC=docker.fnnas.com/metacubex/mihomo:latest
IMG=mihomo:local
GH=https://ghfast.top

echo "=== 0. 目录 ==="
mkdir -p "$CLASH/providers" "$CLASH/ui-src"
cd "$CLASH"
cp /tmp/subscriptions.yaml "$CLASH/subscriptions.yaml" 2>/dev/null || true
cp /tmp/make-mihomo-config.mjs "$CLASH/make-mihomo-config.mjs" 2>/dev/null || true
cp /tmp/apply-subscriptions.sh "$CLASH/apply-subscriptions.sh" 2>/dev/null || true
cp /tmp/sub-admin.py "$CLASH/sub-admin.py" 2>/dev/null || true
chmod +x "$CLASH/apply-subscriptions.sh" 2>/dev/null || true

echo
echo "=== 1. mihomo 镜像 ==="
if ! docker image inspect "$IMG" >/dev/null 2>&1; then
  docker pull "$IMG_SRC"
  docker tag "$IMG_SRC" "$IMG"
fi
docker image inspect "$IMG" --format '镜像 OK · arch={{.Architecture}}'

echo
echo "=== 2. 网页管理面板（metacubexd）==="
if [ ! -f "$CLASH/ui/index.html" ]; then
  curl -fL --max-time 120 "$GH/https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip" -o "$CLASH/ui.zip"
  python3 -c "import zipfile; zipfile.ZipFile('$CLASH/ui.zip').extractall('$CLASH/ui-src')"
  inner=$(find "$CLASH/ui-src" -maxdepth 2 -name index.html | head -1 | xargs -r dirname)
  [ -n "$inner" ] || { echo "!! 压缩包里没找到 index.html"; exit 1; }
  rm -rf "$CLASH/ui"; mv "$inner" "$CLASH/ui"
  rm -f "$CLASH/ui.zip"; rm -rf "$CLASH/ui-src"
fi
echo "面板文件: $(find "$CLASH/ui" -type f | wc -l) 个"

echo
echo "=== 3. 生成配置并启动 mihomo ==="
sh "$CLASH/apply-subscriptions.sh"

echo
echo "=== 4. 启动「导入订阅」页 :9091 ==="
pkill -f 'sub-admin.py' 2>/dev/null || true
nohup python3 "$CLASH/sub-admin.py" >"$CLASH/sub-admin.log" 2>&1 &
sleep 1
echo "导入页: http://10.56.41.60:9091/?key=\$(cat $CLASH/admin.key 2>/dev/null || echo '<admin.key 里的口令>')"
echo "节点面板: http://10.56.41.60:9090/ui/（secret 可用 MIHOMO_SECRET env 覆盖后重跑 apply）"
echo "=== DONE ==="
