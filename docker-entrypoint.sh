#!/bin/sh
set -e

# 1) 从环境变量还原私钥（不进镜像、不进 Git）
if [ -n "${TESLA_KEY_B64:-}" ]; then
  mkdir -p /app/keys
  printf '%s' "$TESLA_KEY_B64" | base64 -d > /app/keys/private-key.pem
  chmod 600 /app/keys/private-key.pem
  echo "[init] 私钥已从 TESLA_KEY_B64 写入"
fi

# 2) 按 CPU 架构选签名工具
case "$(uname -m)" in
  aarch64|arm64) SRC=/app/bin/tesla-control-linux-arm64 ;;
  *)             SRC=/app/bin/tesla-control-linux-amd64 ;;
esac
if [ -f "$SRC" ]; then
  cp "$SRC" /app/bin/tesla-control
  chmod +x /app/bin/tesla-control
  echo "[init] 签名工具: $(basename "$SRC")"
else
  echo "[init] ⚠ 找不到 $SRC，远程控制将不可用"
fi

# 3) 数据目录（应挂持久卷）
mkdir -p /app/data

exec "$@"
