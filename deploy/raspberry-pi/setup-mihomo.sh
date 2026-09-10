#!/bin/sh
# 树莓派网关出口代理：mihomo 容器 + 网页管理面板（可切换节点）
# 全 Docker 部署。用法：sudo sh setup-mihomo.sh
#
#   SUB_URL=... sh setup-mihomo.sh     换订阅
#   REFRESH=1  sh setup-mihomo.sh      重新拉订阅并重建配置
set -eu

CLASH=/vol1/1000/valimart-clash
NET=vmgw-net
IMG_SRC=docker.fnnas.com/metacubex/mihomo:latest
IMG=mihomo:local
SUB_URL="${SUB_URL:-https://dasho.xn--cp3a08l.com/api/v1/pq/b827bb5caca3b175d7d64a902f04bd1d}"
API_SECRET="valimart-clash-2026"
GH=https://ghfast.top

echo "=== 0. 目录 ==="
mkdir -p "$CLASH/ui-src"
cd "$CLASH"

if [ ! -s "$CLASH/subscription.yaml" ] || [ "${REFRESH:-0}" = "1" ]; then
  echo
  echo "=== 1. 拉订阅（伪装 clash UA）==="
  curl -fsSL --max-time 90 -A 'clash-verge/v2.0.3' "$SUB_URL" -o "$CLASH/subscription.yaml"
  echo "订阅大小: $(stat -c %s "$CLASH/subscription.yaml") 字节"
else
  echo "=== 1. 已有订阅，跳过（REFRESH=1 可强制刷新）==="
fi

echo
echo "=== 2. mihomo 镜像 ==="
if ! docker image inspect "$IMG" >/dev/null 2>&1; then
  docker pull "$IMG_SRC"
  docker tag "$IMG_SRC" "$IMG"
fi
docker image inspect "$IMG" --format '镜像 OK · arch={{.Architecture}}'

echo
echo "=== 3. 生成配置（用网关容器里的 Node）==="
docker cp /tmp/make-mihomo-config.mjs valimart-gateway:/tmp/mk.mjs
docker cp "$CLASH/subscription.yaml" valimart-gateway:/tmp/sub.yaml
docker exec valimart-gateway node /tmp/mk.mjs /tmp/sub.yaml /tmp/mihomo.yaml /root/.config/mihomo/clash-ui
docker cp valimart-gateway:/tmp/mihomo.yaml "$CLASH/config.yaml"
echo "配置大小: $(stat -c %s "$CLASH/config.yaml") 字节"

echo
echo "=== 4. 网页管理面板（metacubexd 静态站）==="
if [ ! -f "$CLASH/ui/index.html" ]; then
  curl -fL --max-time 120 "$GH/https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip" -o "$CLASH/ui.zip"
  echo "下载 $(stat -c %s "$CLASH/ui.zip") 字节"
  rm -rf "$CLASH/ui-src"; mkdir -p "$CLASH/ui-src"
  python3 -c "import zipfile,sys; zipfile.ZipFile('$CLASH/ui.zip').extractall('$CLASH/ui-src')"
  inner=$(find "$CLASH/ui-src" -maxdepth 2 -name index.html | head -1 | xargs -r dirname)
  [ -n "$inner" ] || { echo "!! 压缩包里没找到 index.html"; exit 1; }
  rm -rf "$CLASH/ui"; mv "$inner" "$CLASH/ui"
  rm -f "$CLASH/ui.zip"; rm -rf "$CLASH/ui-src"
fi
echo "面板文件: $(find "$CLASH/ui" -type f | wc -l) 个，index.html $(stat -c %s "$CLASH/ui/index.html") 字节"

echo
echo "=== 5. 容器网络 ==="
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET"
docker network connect "$NET" valimart-gateway 2>/dev/null && echo "已把网关接入 $NET" || echo "网关已在 $NET"

echo
echo "=== 6. 启动 mihomo（含面板）==="
docker rm -f mihomo >/dev/null 2>&1 || true
docker run -d --name mihomo \
  --restart unless-stopped \
  --network "$NET" \
  -p 127.0.0.1:7890:7890 \
  -p 127.0.0.1:9090:9090 \
  -v "$CLASH/config.yaml:/root/.config/mihomo/config.yaml:ro" \
  -v "$CLASH/ui:/root/.config/mihomo/clash-ui:ro" \
  "$IMG" >/dev/null
sleep 8
docker ps --filter name=mihomo --format '{{.Names}} | {{.Status}} | {{.Ports}}'

echo
echo "=== 7. 验证 ==="
echo "--- 日志（应为空或只有启动信息；有 fatal 说明配置有问题）---"
docker logs mihomo 2>&1 | tail -12
echo
echo "--- 经代理访问上游 ---"
curl -s -o /dev/null -w "  api.openai.com  HTTP=%{http_code}  %{time_total}s\n" --max-time 20 -x http://127.0.0.1:7890 https://api.openai.com/v1/models
curl -s -o /dev/null -w "  api.x.ai        HTTP=%{http_code}  %{time_total}s\n" --max-time 20 -x http://127.0.0.1:7890 https://api.x.ai/v1/models
curl -s -o /dev/null -w "  chatgpt.com     HTTP=%{http_code}  %{time_total}s\n" --max-time 20 -x http://127.0.0.1:7890 https://chatgpt.com/backend-api
echo
echo "--- 管理面板 ---"
echo "  http://127.0.0.1:9090/ui/  HTTP=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H "Authorization: Bearer $API_SECRET" http://127.0.0.1:9090/ui/)"
echo "  接口自检       HTTP=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H "Authorization: Bearer $API_SECRET" http://127.0.0.1:9090/version)"
echo
echo "--- 当前节点 ---"
curl -s --max-time 8 -H "Authorization: Bearer $API_SECRET" http://127.0.0.1:9090/proxies/PROXY | head -c 200
echo
echo
echo "=== DONE ==="
