#!/bin/bash
# Pinggy 隧道 + 自动重连
# 用法: ./scripts/tunnel.sh [port]
PORT="${1:-8787}"
LOG=/tmp/tesla-tunnel.log
URLFILE=/tmp/tesla-tunnel-url.txt
: > "$LOG"

while true; do
  echo "[连接] $(date +%H:%M:%S) 建立隧道 → localhost:$PORT"
  ssh -p 443 \
      -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null \
      -o ServerAliveInterval=15 \
      -o ServerAliveCountMax=3 \
      -o ExitOnForwardFailure=yes \
      -R0:localhost:$PORT a.pinggy.io 2>&1 | while IFS= read -r line; do
    echo "$line" >> "$LOG"
    url=$(printf '%s' "$line" | grep -oE 'https://[A-Za-z0-9._-]+\.(pinggy-free\.link|pinggy\.net)' | head -1)
    if [ -n "$url" ]; then
      printf '%s' "$url" > "$URLFILE"
      echo "[地址] $url"
    fi
  done
  echo "[重连] $(date +%H:%M:%S) 隧道断开，3 秒后重连"
  sleep 3
done
