#!/bin/bash
# 将前端静态文件同步到 Android assets 目录
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ASSETS_DIR="$SCRIPT_DIR/app/src/main/assets"

echo "同步静态文件..."
echo "  源: $PROJECT_ROOT/static/"
echo "  目标: $ASSETS_DIR/"

mkdir -p "$ASSETS_DIR"
rsync -a --delete --exclude='CLAUDE.md' --exclude='version.json' "$PROJECT_ROOT/static/" "$ASSETS_DIR/"

# 计算静态文件版本哈希（与服务端算法一致）
HASH=$(python3 -c "
import hashlib, os
hasher = hashlib.sha256()
static_dir = '$PROJECT_ROOT/static'
for root, dirs, files in os.walk(static_dir):
    dirs[:] = [d for d in sorted(dirs) if d != 'lib']
    dirs.sort()
    for fname in sorted(files):
        if fname in ('CLAUDE.md', 'version.json'):
            continue
        fpath = os.path.join(root, fname)
        rel = os.path.relpath(fpath, static_dir)
        hasher.update(rel.encode())
        with open(fpath, 'rb') as f:
            hasher.update(f.read())
print(hasher.hexdigest()[:16])
")
echo "{\"version\": \"$HASH\"}" > "$ASSETS_DIR/version.json"
echo "版本哈希: $HASH"

echo "同步完成！"
ls -lh "$ASSETS_DIR/"
