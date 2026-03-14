#!/bin/bash
# 将前端静态文件同步到 Android assets 目录
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ASSETS_DIR="$SCRIPT_DIR/app/src/main/assets/static"

echo "同步静态文件..."
echo "  源: $PROJECT_ROOT/static/"
echo "  目标: $ASSETS_DIR/"

mkdir -p "$ASSETS_DIR"
rsync -a --delete --exclude='CLAUDE.md' "$PROJECT_ROOT/static/" "$ASSETS_DIR/"

echo "同步完成！"
ls -lh "$ASSETS_DIR/"
