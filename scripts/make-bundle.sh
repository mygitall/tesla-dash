#!/bin/bash
# 在本地 Mac 上打一个「云端部署包」
set -euo pipefail
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJ"
mkdir -p dist

# 确保两个架构的二进制都在
for A in amd64 arm64; do
  if [ ! -f "bin/tesla-control-linux-$A" ]; then
    echo "缺少 bin/tesla-control-linux-$A，正在编译…"
    ./scripts/build-linux.sh "$A"
  fi
done

OUT="dist/tesla-dash-deploy.tar.gz"
rm -f "$OUT"

tar czf "$OUT" \
  server.mjs db.mjs recorder.mjs \
  public bin keys data \
  Dockerfile docker-entrypoint.sh docker-compose.yml .dockerignore .env \
  scripts/cloud-bootstrap.sh scripts/pair-key.sh \
  README.md DEPLOY-FREE.md

echo
echo "✓ 部署包已生成: $PROJ/$OUT"
ls -lh "$OUT" | awk '{print "  大小: "$5}'
echo
echo "内容检查:"
for f in server.mjs public/index.html bin/tesla-control-linux-amd64 bin/tesla-control-linux-arm64 \
         keys/private-key.pem data/.tokens.json Dockerfile docker-compose.yml .env scripts/cloud-bootstrap.sh; do
  tar tzf "$OUT" "$f" >/dev/null 2>&1 && echo "  ✓ $f" || echo "  ✗ 缺少 $f"
done
echo
echo "下一步："
echo "  scp $OUT 用户@服务器IP:/tmp/"
