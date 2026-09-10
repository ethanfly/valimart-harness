#!/bin/sh
# 一键修复 mihomo + 接入网关代理
set -eu
CLASH=/vol1/1000/valimart-clash
APP=/vol1/1000/valimart-gateway
NET=vmgw-net
SEC="valimart-clash-2026"

echo "========== 1. 重新生成 mihomo 配置 =========="
docker cp /tmp/make-mihomo-config.mjs valimart-gateway:/tmp/mk.mjs
docker exec valimart-gateway node /tmp/mk.mjs /tmp/sub.yaml /tmp/mihomo.yaml /root/.config/mihomo/clash-ui
docker cp valimart-gateway:/tmp/mihomo.yaml "$CLASH/config.yaml"
echo "配置: $(wc -l < "$CLASH/config.yaml") 行"
grep -c 'DOMAIN-SUFFIX' "$CLASH/config.yaml" | xargs -I{} echo "域名规则: {} 条"
grep 'no-resolve' "$CLASH/config.yaml" && echo "GEOIP no-resolve: OK"

echo
echo "========== 2. 重启 mihomo（面板暴露到局域网）=========="
docker rm -f mihomo >/dev/null 2>&1 || true
docker run -d --name mihomo \
  --restart unless-stopped \
  --network "$NET" \
  -p 7890:7890 \
  -p 9090:9090 \
  -v "$CLASH/config.yaml:/root/.config/mihomo/config.yaml:ro" \
  -v "$CLASH/ui:/root/.config/mihomo/clash-ui:ro" \
  mihomo:local >/dev/null
echo "等待 mihomo 启动 + 首轮健康检查（30s）..."
sleep 30
docker ps --filter name=mihomo --format '  {{.Names}} | {{.Status}}'

echo
echo "========== 3. 验证代理 =========="
echo "--- 节点健康（fallback 当前选中）---"
curl -s --max-time 8 -H "Authorization: Bearer $SEC" http://127.0.0.1:9090/proxies/AUTO \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('  AUTO now:',d.get('now'));h=d.get('history') or [];print('  最近测试:',h[-1] if h else '无')" 2>/dev/null || echo "  (API 取不到)"

echo "--- 经代理访问被墙站点 ---"
for u in https://api.openai.com/v1/models https://api.x.ai/v1/models https://www.google.com; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 -x http://127.0.0.1:7890 "$u" 2>/dev/null)
  printf "  %-42s HTTP=%s\n" "$u" "$code"
done

echo "--- 经代理访问国内站点（应直连成功）---"
for u in https://api.deepseek.com/v1/models https://dashscope.aliyuncs.com; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -x http://127.0.0.1:7890 "$u" 2>/dev/null)
  printf "  %-42s HTTP=%s\n" "$u" "$code"
done

echo "--- 出口 IP（确认走了代理）---"
curl -s --max-time 15 -x http://127.0.0.1:7890 https://api.ipify.org 2>/dev/null || echo "(取不到)"
echo

echo
echo "========== 4. 面板可达性 =========="
echo "  本机: http://127.0.0.1:9090/ui/ -> HTTP=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:9090/ui/)"
echo "  局域网: http://10.56.41.60:9090/ui/"
echo "  密码(secret): $SEC"

echo
echo "========== 5. 网关接入代理 =========="
# 确认网关容器在 vmgw-net 上
docker network inspect "$NET" --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null | grep -q valimart-gateway \
  && echo "  网关已在 $NET" || docker network connect "$NET" valimart-gateway

# 验证网关容器内 node 支持 --use-env-proxy
docker exec valimart-gateway node --use-env-proxy -e "console.log('  --use-env-proxy 支持: OK')" 2>&1 || {
  echo "  !! node 不支持 --use-env-proxy，需要换方案"
  exit 1
}

# 验证网关容器内能解析 mihomo 主机名
docker exec valimart-gateway node -e "
const dns = require('dns');
dns.lookup('mihomo', (e, a) => console.log(e ? '  !! 解析 mihomo 失败: '+e.message : '  mihomo -> '+a));
"

# 验证网关容器内经 mihomo 代理能到 openai
docker exec valimart-gateway node --use-env-proxy -e "
process.env.HTTPS_PROXY='http://mihomo:7890';
fetch('https://api.openai.com/v1/models',{signal:AbortSignal.timeout(20000)})
  .then(r=>console.log('  网关容器内 openai HTTP='+r.status))
  .catch(e=>console.log('  !! 网关容器内 openai 失败: '+(e.cause?.message||e.message)));
" 2>&1

echo
echo "========== 6. 更新网关 compose（加代理环境变量 + --use-env-proxy）=========="
cd "$APP/deploy"
# 在 .env 里加代理配置（如果还没有）
grep -q '^HTTPS_PROXY=' .env 2>/dev/null || cat >> .env <<'ENV'

# --- 代理（mihomo 容器，同 docker 网络）---
HTTP_PROXY=http://mihomo:7890
HTTPS_PROXY=http://mihomo:7890
NO_PROXY=localhost,127.0.0.1,mihomo,::1
ENV
echo "  .env 已更新"

# 创建 compose override（不改主 compose，方便以后去掉代理）
cat > docker-compose.override.yml <<'YAML'
# 代理覆盖层：让网关的 fetch 走 mihomo
# 删除此文件 + docker compose up -d 即可恢复直连
services:
  gateway:
    command: ["node", "--use-env-proxy", "server/src/index.js"]
    environment:
      HTTP_PROXY: ${HTTP_PROXY:-http://mihomo:7890}
      HTTPS_PROXY: ${HTTPS_PROXY:-http://mihomo:7890}
      NO_PROXY: ${NO_PROXY:-localhost,127.0.0.1,mihomo,::1}
    networks:
      - default
      - vmgw-net

networks:
  vmgw-net:
    external: true
YAML
echo "  docker-compose.override.yml 已创建"

echo
echo "========== 7. 重启网关 =========="
docker compose up -d 2>&1 | tail -5
sleep 8
docker compose ps
echo
curl -s http://127.0.0.1:8790/health | python3 -c "import json,sys;d=json.load(sys.stdin);print(f\"  health: ok={d['ok']} name={d['name']} needsSetup={d['needsSetup']}\")" 2>/dev/null

echo
echo "========== 8. 端到端验证（网关日志看模型目录）=========="
docker compose logs --tail 5 2>&1 | grep -E '模型目录|上游|error' | sed 's/^/  /'

echo
echo "==================== DONE ===================="
echo "代理面板: http://10.56.41.60:9090/ui/  (secret: $SEC)"
echo "网关:     http://10.56.41.60:8790"
echo "去掉代理: rm $APP/deploy/docker-compose.override.yml && cd $APP/deploy && sudo docker compose up -d"
