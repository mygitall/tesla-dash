#!/bin/bash
# 生成 ClawCloud 需要的环境变量（复制到平台的控制台里）
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "找不到 .env"; exit 1; }
[ -f data/.tokens.json ] || { echo "找不到 data/.tokens.json"; exit 1; }
[ -f keys/private-key.pem ] || { echo "找不到 keys/private-key.pem"; exit 1; }

CID=$(grep '^TESLA_CLIENT_ID=' .env | cut -d= -f2-)
CSEC=$(grep '^TESLA_CLIENT_SECRET=' .env | cut -d= -f2-)
APW=$(grep '^APP_PASSWORD=' .env | cut -d= -f2-)
REGION=$(grep '^TESLA_REGION=' .env | cut -d= -f2-)
REFRESH=$(python3 -c "import json;print(json.load(open('data/.tokens.json'))['refresh_token'])" 2>/dev/null || true)
KEYB64=$(base64 < keys/private-key.pem | tr -d '\n')

[ -n "$REFRESH" ] || { echo "token 文件里没有 refresh_token"; exit 1; }

cat <<EOF
# ───────── 复制下面全部内容到 ClawCloud 的环境变量里 ─────────
MODE=fleet
TESLA_REGION=${REGION:-cn}
TESLA_CLIENT_ID=${CID}
TESLA_CLIENT_SECRET=${CSEC}
TESLA_REFRESH_TOKEN=${REFRESH}
APP_PASSWORD=${APW}
ALLOW_COMMANDS=1
HOST=0.0.0.0
PORT=8787
DATA_DIR=/app/data
POLL_INTERVAL_SEC=60
RETENTION_DAYS=90
TESLA_KEY_B64=${KEYB64}
# ──────────────────────────────────────────────────────────
EOF
echo
echo "⚠️  上面包含私钥和密钥，别截图/别外发。"
echo "⚠️  部署成功后请停掉本地服务，否则两个实例抢同一个 refresh_token 会互相踢下线："
echo "    launchctl bootout gui/\$(id -u)/com.tesladash.server"
echo "    launchctl bootout gui/\$(id -u)/com.tesladash.tunnel"
