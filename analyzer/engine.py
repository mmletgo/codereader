"""分析引擎入口 - 协调 scanner -> analyzer -> resolver 流程，写入数据库"""
import json
import os
import sqlite3
from collections import defaultdict

from analyzer.base import BaseAnalyzer, CallInfo, FileAnalysisResult, FunctionInfo, ImportInfo
from analyzer.call_resolver import CallResolver
from analyzer.js_analyzer import JsAnalyzer
from analyzer.python_analyzer import PythonAnalyzer
from analyzer.scanner import scan_directory
from app.database import get_db, insert_row, fetch_all, execute
from config import DEFAULT_INCLUDE, DEFAULT_EXCLUDE

# 多语言分析器注册
_analyzers: list[BaseAnalyzer] = [PythonAnalyzer(), JsAnalyzer()]
_ext_map: dict[str, BaseAnalyzer] = {}
for _a in _analyzers:
    for _ext in _a.supported_extensions():
        _ext_map[_ext] = _a


def analyze_project(
    root_path: str,
    project_name: str | None = None,
    include: list[str] | None = None,
    exclude: list[str] | None = None,
    existing_project_id: int | None = None,
) -> int:
    """分析项目，将结果写入数据库。

    Args:
        root_path: 项目根目录绝对路径
        project_name: 项目名称，默认使用目录名
        include: 文件包含模式列表，默认 DEFAULT_INCLUDE
        exclude: 文件排除模式列表，默认空列表

    Returns:
        project_id
    """
    root_path = os.path.abspath(root_path)
    if project_name is None:
        project_name = os.path.basename(root_path)
    if include is None:
        include = list(DEFAULT_INCLUDE)
    if exclude is None:
        exclude = []

    # 1. 扫描文件
    files: list[tuple[str, str]] = scan_directory(root_path, include, exclude)

    # 2. 逐文件分析（按扩展名分派到对应分析器）
    analysis_results: list[FileAnalysisResult] = []

    for abs_path, rel_path in files:
        ext: str = os.path.splitext(rel_path)[1].lower()
        analyzer: BaseAnalyzer | None = _ext_map.get(ext)
        if analyzer is None:
            continue  # 不支持的文件类型跳过

        try:
            with open(abs_path, "r", encoding="utf-8") as f:
                content: str = f.read()
        except (UnicodeDecodeError, PermissionError, OSError) as e:
            print(f"Warning: Cannot read {abs_path}: {e}")
            continue

        result: FileAnalysisResult = analyzer.analyze_file(abs_path, content, rel_path)
        analysis_results.append(result)

    # 收集所有函数和调用
    all_functions: list[FunctionInfo] = []
    all_calls: list[CallInfo] = []
    file_imports: dict[str, list[ImportInfo]] = {}

    for result in analysis_results:
        all_functions.extend(result.functions)
        all_calls.extend(result.calls)
        if result.imports:
            file_imports[result.rel_path] = result.imports

    # 3. 解析调用关系
    resolver: CallResolver = CallResolver(all_functions)
    resolved_calls: list[tuple[CallInfo, str | None]] = resolver.resolve(
        all_calls, file_imports
    )

    # 4-6. 写入数据库
    with get_db() as conn:
        # 4. 创建或复用 project 记录
        if existing_project_id is not None:
            project_id = existing_project_id
            execute(
                conn,
                "UPDATE projects SET scan_time = CURRENT_TIMESTAMP WHERE id = ?",
                (project_id,),
            )
        else:
            project_id: int = insert_row(conn, "projects", {
                "name": project_name,
                "root_path": root_path,
                "language": _detect_language(analysis_results),
            })

        # 5. 写入 files 和 functions
        # 建立 qualified_name -> function_id 映射（用于调用关系写入）
        qname_to_func_id: dict[str, int] = {}
        # 建立 (file_rel_path, qualified_name) -> function_id 用于精确匹配
        file_qname_to_func_id: dict[str, int] = {}

        for result in analysis_results:
            file_id: int = insert_row(conn, "files", {
                "project_id": project_id,
                "rel_path": result.rel_path,
                "language": result.language,
                "content": result.content,
                "line_count": result.line_count,
            })

            for func in result.functions:
                func_id: int = insert_row(conn, "functions", {
                    "file_id": file_id,
                    "project_id": project_id,
                    "name": func.name,
                    "qualified_name": func.qualified_name,
                    "signature": func.signature,
                    "start_line": func.start_line,
                    "end_line": func.end_line,
                    "body": func.body,
                    "is_async": func.is_async,
                    "is_method": func.is_method,
                    "class_name": func.class_name,
                    "decorators": json.dumps(func.decorators),
                    "docstring": func.docstring,
                })
                qname_to_func_id[func.qualified_name] = func_id
                file_qname_to_func_id[
                    f"{func.file_rel_path}::{func.qualified_name}"
                ] = func_id

        # 写入 call_relations
        for call, resolved_qname in resolved_calls:
            # 找到 caller_id
            caller_id: int | None = _find_func_id(
                call.caller_qualified_name,
                file_qname_to_func_id,
                qname_to_func_id,
            )
            if caller_id is None:
                continue  # caller 不存在，跳过

            # 找到 callee_id（可能为 None）
            callee_id: int | None = None
            if resolved_qname is not None:
                callee_id = _find_func_id(
                    resolved_qname,
                    file_qname_to_func_id,
                    qname_to_func_id,
                )

            insert_row(conn, "call_relations", {
                "caller_id": caller_id,
                "callee_id": callee_id,
                "callee_name": call.callee_name,
                "call_line": call.call_line,
                "project_id": project_id,
            })

        # 6. 计算排序
        compute_sort_order(conn, project_id)

        # 7. 更新 project 的统计
        file_count: int = len(analysis_results)
        func_count: int = len(all_functions)
        execute(
            conn,
            "UPDATE projects SET file_count = ?, func_count = ? WHERE id = ?",
            (file_count, func_count, project_id),
        )

    return project_id


def _detect_language(results: list[FileAnalysisResult]) -> str:
    """根据实际分析结果中的语言统计，推断项目主要语言。"""
    languages: set[str] = {r.language for r in results}
    if not languages:
        return "python"
    if languages == {"python"}:
        return "python"
    if languages <= {"javascript", "typescript"}:
        return "javascript"
    return "mixed"


def _find_func_id(
    qualified_name: str,
    file_qname_map: dict[str, int],
    qname_map: dict[str, int],
) -> int | None:
    """查找函数 ID，优先使用 file+qname 精确匹配，回退到全局 qname。"""
    # 先查精确匹配
    for key, fid in file_qname_map.items():
        if key.endswith(f"::{qualified_name}"):
            return fid
    # 回退到全局
    return qname_map.get(qualified_name)


def compute_sort_order(conn: sqlite3.Connection, project_id: int) -> None:
    """构建调用图，计算函数的阅读排序顺序。

    算法：
    1. 构建调用图（caller -> [callee_ids]）
    2. 找入口函数（项目内无被调用者的函数）
    3. DFS 遍历赋递增 sort_order
    4. 未遍历到的按文件路径+行号追加
    """
    # 获取所有函数
    functions: list[dict] = fetch_all(
        conn,
        "SELECT id, qualified_name, sort_order FROM functions "
        "WHERE project_id = ? ORDER BY id",
        (project_id,),
    )
    if not functions:
        return

    func_ids: set[int] = {f["id"] for f in functions}

    # 获取所有调用关系（仅项目内部的，即 callee_id 不为 NULL），按调用行号排序
    relations: list[dict] = fetch_all(
        conn,
        "SELECT caller_id, callee_id, call_line FROM call_relations "
        "WHERE project_id = ? AND callee_id IS NOT NULL "
        "ORDER BY caller_id, call_line",
        (project_id,),
    )

    # 构建调用图和被调用集，callee按代码中出现顺序排列（去重保留首次出现）
    call_graph: dict[int, list[int]] = defaultdict(list)
    callee_set: set[int] = set()

    for rel in relations:
        caller_id: int = rel["caller_id"]
        callee_id: int = rel["callee_id"]
        if caller_id in func_ids and callee_id in func_ids:
            # 同一caller对同一callee只保留首次调用（避免重复遍历）
            if callee_id not in call_graph[caller_id]:
                call_graph[caller_id].append(callee_id)
            callee_set.add(callee_id)

    # 找入口函数（无被调用者的函数），按文件路径+行号排序
    entry_func_set: set[int] = {fid for fid in func_ids if fid not in callee_set}
    entry_funcs_rows: list[dict] = fetch_all(
        conn,
        "SELECT f.id FROM functions f "
        "JOIN files fl ON f.file_id = fl.id "
        "WHERE f.project_id = ? "
        "ORDER BY fl.rel_path, f.start_line",
        (project_id,),
    )
    entry_funcs: list[int] = [r["id"] for r in entry_funcs_rows if r["id"] in entry_func_set]

    # DFS 遍历
    visited: set[int] = set()
    order: list[int] = []

    def dfs(func_id: int) -> None:
        if func_id in visited:
            return
        visited.add(func_id)
        order.append(func_id)
        for callee_id in call_graph.get(func_id, []):
            dfs(callee_id)

    for entry_id in entry_funcs:
        dfs(entry_id)

    # 未遍历到的函数，按文件路径+行号排序追加
    remaining_funcs: list[dict] = fetch_all(
        conn,
        "SELECT f.id FROM functions f "
        "JOIN files fl ON f.file_id = fl.id "
        "WHERE f.project_id = ? "
        "ORDER BY fl.rel_path, f.start_line",
        (project_id,),
    )
    for func in remaining_funcs:
        fid: int = func["id"]
        if fid not in visited:
            order.append(fid)
            visited.add(fid)

    # 更新 sort_order
    for sort_order, func_id in enumerate(order, start=1):
        execute(
            conn,
            "UPDATE functions SET sort_order = ? WHERE id = ?",
            (sort_order, func_id),
        )
