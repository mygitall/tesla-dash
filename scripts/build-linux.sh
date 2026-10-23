#!/bin/bash
# 交叉编译 tesla-control 以便在 Linux VPS 上运行
# 用法: ./scripts/build-linux.sh [amd64|arm64]
set -euo pipefail
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="${1:-amd64}"
VERSION="v0.4.1"

export GOPROXY=https://goproxy.cn,direct
export GOFLAGS=-mod=mod

echo "[1/3] 拉取 vehicle-command 源码 ($VERSION)"
go mod download "github.com/teslamotors/vehicle-command@${VERSION}" 2>&1 | tail -2

SRC="$(go env GOMODCACHE)/github.com/teslamotors/vehicle-command@${VERSION}"
[ -d "$SRC" ] || { echo "✗ 找不到源码: $SRC"; exit 1; }

echo "[2/3] 复制到可写目录"
BUILD=/tmp/vc-build-${ARCH}
rm -rf "$BUILD"
cp -R "$SRC" "$BUILD"
chmod -R u+w "$BUILD"

echo "[3/3] 编译 linux/${ARCH}"
cd "$BUILD"
CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" \
  go build -trimpath -ldflags="-s -w" \
  -o "$PROJ/bin/tesla-control-linux-${ARCH}" ./cmd/tesla-control

ls -lh "$PROJ/bin/tesla-control-linux-${ARCH}"
echo
file "$PROJ/bin/tesla-control-linux-${ARCH}"
echo "✓ 完成"
