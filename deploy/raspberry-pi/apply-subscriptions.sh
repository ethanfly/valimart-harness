#!/bin/sh
# 根据 subscriptions.yaml 重生 mihomo 配置并重启容器
# 面板 secret：设 MIHOMO_SECRET env 可覆盖默认值（传入 make-mihomo-config.mjs）
set -eu
CLASH=/vol1/1000/valimart-clash
NET=vmgw-net
IMG=mihomo:local

mkdir -p "$CLASH/providers"
cp /tmp/make-mihomo-config.mjs "$CLASH/make-mihomo-config.mjs" 2>/dev/null || true
cp /tmp/subscriptions.yaml "$CLASH/subscriptions.yaml" 2>/dev/null || true

docker cp "$CLASH/make-mihomo-config.mjs" valimart-gateway:/tmp/mk.mjs
docker cp "$CLASH/subscriptions.yaml" valimart-gateway:/tmp/subs.yaml
docker exec -e MIHOMO_SECRET="${MIHOMO_SECRET:-}" valimart-gateway node /tmp/mk.mjs /tmp/subs.yaml /tmp/mihomo.yaml /root/.config/mihomo/clash-ui
docker cp valimart-gateway:/tmp/mihomo.yaml "$CLASH/config.yaml"
echo "配置已写 $CLASH/config.yaml"

docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET"
docker network connect "$NET" valimart-gateway 2>/dev/null || true

docker rm -f mihomo >/dev/null 2>&1 || true
docker run -d --name mihomo \
  --restart unless-stopped \
  --network "$NET" \
  -p 7890:7890 \
  -p 9090:9090 \
  -v "$CLASH/config.yaml:/root/.config/mihomo/config.yaml:ro" \
  -v "$CLASH/ui:/root/.config/mihomo/clash-ui:ro" \
  -v "$CLASH/providers:/root/.config/mihomo/providers" \
  "$IMG" >/dev/null
echo "mihomo 已重启，等订阅拉取（约 20s）..."
sleep 20
docker ps --filter name=mihomo --format '{{.Names}} {{.Status}} {{.Ports}}'
docker logs --tail 15 mihomo 2>&1 | grep -vE 'Health Checked' || true
echo "面板: http://10.56.41.60:9090/ui/（secret 为生成配置里的 external-controller secret，可用 MIHOMO_SECRET env 覆盖后重跑）"
echo "导入订阅: http://10.56.41.60:9091/?key=<\$CLASH/admin.key 里的口令>"
