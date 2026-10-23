#!/bin/bash
# 备份 data/ 目录（数据库 + token + 会话密钥），保留最近 7 份
set -euo pipefail
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/tesla-backups"
mkdir -p "$DEST"
STAMP="$(date +%Y%m%d-%H%M)"
tar czf "$DEST/tesla-data-$STAMP.tar.gz" -C "$PROJ" data/
# 只保留最近 7 份
ls -1t "$DEST"/tesla-data-*.tar.gz 2>/dev/null | tail -n +8 | xargs -r rm -f
echo "[$(date '+%F %T')] 备份完成: tesla-data-$STAMP.tar.gz ($(du -h "$DEST/tesla-data-$STAMP.tar.gz" | cut -f1))"
