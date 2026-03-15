"""静态文件版本检测 — 用于 Android APP 前端热更新"""
import hashlib
import os

from fastapi import APIRouter

from config import STATIC_DIR

router = APIRouter()


def _compute_static_hash() -> str:
    """计算自定义静态文件的内容哈希（排除 lib/、CLAUDE.md、version.json）"""
    hasher = hashlib.sha256()
    static_dir = str(STATIC_DIR)
    for root, dirs, files in os.walk(static_dir):
        # 排除 lib 目录
        dirs[:] = [d for d in sorted(dirs) if d != "lib"]
        dirs.sort()
        for fname in sorted(files):
            if fname in ("CLAUDE.md", "version.json"):
                continue
            fpath = os.path.join(root, fname)
            rel = os.path.relpath(fpath, static_dir)
            hasher.update(rel.encode())
            with open(fpath, "rb") as f:
                hasher.update(f.read())
    return hasher.hexdigest()[:16]


STATIC_VERSION: str = _compute_static_hash()


@router.get("/")
async def get_static_version() -> dict[str, str]:
    """返回当前静态文件版本哈希"""
    return {"version": STATIC_VERSION}
