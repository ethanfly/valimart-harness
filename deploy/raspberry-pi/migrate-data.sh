#!/bin/sh
# 把导出的正式网关数据放进树莓派（替换空的 data）
# 用法（root）：sh /tmp/migrate-data.sh <tar.gz 路径> <期望sha256>
set -eu
APP=/vol1/1000/harness/valimart-gateway
DATA=/vol1/1000/harness/data
DC="docker compose"
TAR=${1:?需要 tar.gz 路径}
EXPECT=${2:-}

echo "=== 0. 校验包 ==="
[ -f "$TAR" ] || { echo "!! 找不到 $TAR"; exit 1; }
echo "大小: $(( $(stat -c %s "$TAR") / 1024 / 1024 )) MB"
if [ -n "$EXPECT" ]; then
  GOT=$(sha256sum "$TAR" | cut -d' ' -f1)
  echo "本机 sha256: $GOT"
  echo "期望 sha256: $EXPECT"
  [ "$GOT" = "$EXPECT" ] || { echo "!! 哈希不一致，中止（传输可能损坏）"; exit 1; }
  echo "哈希一致 OK"
fi

echo
echo "=== 1. 停容器 ==="
cd "$APP/deploy"
docker compose down 2>&1 | tail -3

echo
echo "=== 2. 备份现有 data（空目录也留个底）==="
if [ -e "$DATA" ]; then
  mv "$DATA" "${DATA}.before-migrate.$(date +%s)"
  echo "已移到 ${DATA}.before-migrate.*"
fi

echo
echo "=== 3. 解包 ==="
cd /vol1/1000/harness
rm -rf _migrate
mkdir -p _migrate
tar -xzf "$TAR" -C _migrate
echo "解出: $(find _migrate -type f | wc -l) 文件"
ls -la _migrate

echo
echo "=== 4. 就位 ==="
if [ -d _migrate/data ]; then
  mv _migrate/data "$DATA"
else
  mkdir -p "$DATA"
  cp -a _migrate/. "$DATA"/
fi
echo "已放到 $DATA"

echo
echo "=== 5. WAL/SHM 保留（不要删！）==="
echo "  主库与 -wal 来自同一份停服务快照，最后一段写入还在 -wal 里；"
echo "  SQLite 首次打开会自动重放并把 wal 合并进主库。删掉 = 丢最后一段数据。"
ls -la "$DATA" | grep -E 'sqlite|instance'

echo
echo "=== 6. 权限（容器以 root 跑；保持最小可读）==="
chown -R root:root "$DATA"
chmod 700 "$DATA"
find "$DATA" -type d -exec chmod 700 {} \;
find "$DATA" -type f -exec chmod 600 {} \;
ls -la "$DATA"

echo
echo "=== 7. 启容器 ==="
cd "$APP/deploy"
docker compose up -d 2>&1 | tail -4

echo
echo "=== 8. 等健康 ==="
i=0
while [ $i -lt 40 ]; do
  if curl -fsS http://127.0.0.1:8790/health >/dev/null 2>&1; then echo "健康检查通过（$((i*3))s）"; break; fi
  i=$((i+1)); sleep 3
done
[ $i -lt 40 ] || echo "!! 120 秒未通过，看日志"

echo
echo "=== 9. 验收 ==="
docker compose ps
echo "--- /health ---"; curl -s http://127.0.0.1:8790/health; echo
echo "--- /api/setup（needsSetup 应为 false，公司名应为 ValimartHarness）---"; curl -s http://127.0.0.1:8790/api/setup; echo
echo "--- instance-id（应与本机导出一致：ecfd3c8d-44c8-4e03-a448-f7efc975bcf9）---"; cat "$DATA/instance-id"; echo
echo "--- 数据目录 ---"; ls -la "$DATA"
echo "--- 公司盘 ---"
echo "    _shared: $(find "$DATA/drive/_shared" -type f 2>/dev/null | wc -l) 文件"
echo "    _office: $(find "$DATA/drive/_office" -type f 2>/dev/null | wc -l) 文件 ($(ls "$DATA/drive/_office" 2>/dev/null | wc -l) 个账号)"
echo "    projects: $(find "$DATA/drive/projects" -type f 2>/dev/null | wc -l) 文件"
echo "--- 日志尾部 ---"; docker compose logs --tail 12
echo
echo "=== DONE ==="
