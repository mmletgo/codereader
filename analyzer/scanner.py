"""目录递归扫描器 - 收集待分析的源代码文件"""
import os
from fnmatch import fnmatch
from pathlib import Path

from config import DEFAULT_EXCLUDE


def scan_directory(
    root_path: str,
    include: list[str],
    exclude: list[str],
) -> list[tuple[str, str]]:
    """递归扫描目录，返回匹配的文件列表。

    Args:
        root_path: 项目根目录的绝对路径
        include: glob模式列表，只收集匹配的文件（如 ["*.py"]）
        exclude: glob模式列表，排除匹配的文件/目录

    Returns:
        (绝对路径, 相对路径) 元组列表，按相对路径排序
    """
    root: Path = Path(root_path).resolve()
    merged_exclude: list[str] = list(DEFAULT_EXCLUDE) + [
        e for e in exclude if e not in DEFAULT_EXCLUDE
    ]

    result: list[tuple[str, str]] = []

    for dirpath, dirnames, filenames in os.walk(root):
        # 过滤掉隐藏目录和排除目录（原地修改 dirnames 以阻止 os.walk 递归进入）
        dirnames[:] = [
            d for d in dirnames
            if not d.startswith(".")
            and not _matches_any(d, merged_exclude)
        ]
        # 排序确保遍历顺序稳定
        dirnames.sort()

        for filename in sorted(filenames):
            # 跳过隐藏文件
            if filename.startswith("."):
                continue
            # 检查是否被排除
            if _matches_any(filename, merged_exclude):
                continue
            # 检查是否匹配 include 模式
            if not _matches_any(filename, include):
                continue

            abs_path: str = os.path.join(dirpath, filename)
            rel_path: str = os.path.relpath(abs_path, root)
            result.append((abs_path, rel_path))

    return result


def _matches_any(name: str, patterns: list[str]) -> bool:
    """检查文件/目录名是否匹配任一 glob 模式。"""
    for pattern in patterns:
        if fnmatch(name, pattern):
            return True
    return False
