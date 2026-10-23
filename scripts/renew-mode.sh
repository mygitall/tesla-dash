#!/bin/bash
# Tesla Dash — 切换 OAuth 回调地址
#
#   on   切到 http://localhost:8787/auth/callback  （配合 SSH 隧道重新授权）
#   off  切回 https://www.zhangweiwei.cc/auth/callback
#   status  查看当前值
#
# 用法（在服务器上）：/opt/tesla-dash/scripts/renew-mode.sh on|off|status
set -euo pipefail

APP="${APP_DIR:-/opt/tesla-dash}"
PUBLIC_URI="${PUBLIC_URI:-https://www.zhangweiwei.cc/auth/callback}"
LOCAL_URI="${LOCAL_URI:-http://localhost:8787/auth/callback}"

cd "$APP"

MODE="${1:-status}"

case "$MODE" in
  on)   TARGET="$LOCAL_URI" ;;
  off)  TARGET="$PUBLIC_URI" ;;
  status)
    echo "当前回调地址：$(grep '^TESLA_REDIRECT_URI=' .env | cut -d= -f2-)"
    exit 0
    ;;
  *)
    echo "用法: $0 on|off|status" >&2
    exit 1
    ;;
esac

if [ ! -f .env ]; then
  echo "错误：找不到 $APP/.env" >&2
  exit 1
fi

# 备份一次，便于回滚
cp .env ".env.bak.$(date +%s)"

# 注意：.env 里的 $ 已转义为 $$，这里替换的值不含 $，安全
sed -i "s|^TESLA_REDIRECT_URI=.*|TESLA_REDIRECT_URI=$TARGET|" .env

docker compose up -d --force-recreate >/dev/null 2>&1
sleep 5

echo "✓ 回调地址 → $TARGET"
docker compose logs --tail=20 2>/dev/null | grep -m1 "回调地址" || true
