"""函数查询服务 — 分页列表、详情、调用关系"""
import json
import sqlite3

from app.database import fetch_one, fetch_all
from app.models import (
    CalleeOnLine,
    FunctionListItem,
    FunctionListResponse,
    FunctionDetail,
    FunctionBrief,
    NoteInFunction,
)


def get_function_list(
    conn: sqlite3.Connection,
    project_id: int,
    page: int,
    per_page: int,
) -> FunctionListResponse:
    """获取函数分页列表，附带note_count、caller_count、callee_count"""
    # 总数
    count_row = fetch_one(
        conn,
        "SELECT COUNT(*) AS total FROM functions WHERE project_id = ?",
        (project_id,),
    )
    total: int = count_row["total"] if count_row else 0

    offset = (page - 1) * per_page

    rows = fetch_all(
        conn,
        """
        SELECT
            f.id, f.name, f.qualified_name, f.signature,
            fi.rel_path AS file_path,
            f.start_line, f.end_line, f.is_async, f.is_method, f.class_name, f.is_read,
            COALESCE(nc.note_count, 0) AS note_count,
            COALESCE(cr_in.caller_count, 0) AS caller_count,
            COALESCE(cr_out.callee_count, 0) AS callee_count
        FROM functions f
        JOIN files fi ON f.file_id = fi.id
        LEFT JOIN (
            SELECT function_id, COUNT(*) AS note_count
            FROM notes WHERE project_id = ?
            GROUP BY function_id
        ) nc ON nc.function_id = f.id
        LEFT JOIN (
            SELECT callee_id, COUNT(*) AS caller_count
            FROM call_relations WHERE project_id = ?
            GROUP BY callee_id
        ) cr_in ON cr_in.callee_id = f.id
        LEFT JOIN (
            SELECT caller_id, COUNT(*) AS callee_count
            FROM call_relations WHERE project_id = ? AND callee_id IS NOT NULL
            GROUP BY caller_id
        ) cr_out ON cr_out.caller_id = f.id
        WHERE f.project_id = ?
        ORDER BY f.sort_order ASC
        LIMIT ? OFFSET ?
        """,
        (project_id, project_id, project_id, project_id, per_page, offset),
    )

    items: list[FunctionListItem] = []
    for row in rows:
        items.append(FunctionListItem(
            id=row["id"],
            name=row["name"],
            qualified_name=row["qualified_name"],
            signature=row["signature"],
            file_path=row["file_path"],
            start_line=row["start_line"],
            end_line=row["end_line"],
            is_async=bool(row["is_async"]),
            is_method=bool(row["is_method"]),
            class_name=row["class_name"],
            has_notes=row["note_count"] > 0,
            note_count=row["note_count"],
            caller_count=row["caller_count"],
            callee_count=row["callee_count"],
            is_read=bool(row["is_read"]),
        ))

    return FunctionListResponse(
        total=total,
        page=page,
        per_page=per_page,
        items=items,
    )


def get_function_detail(conn: sqlite3.Connection, function_id: int) -> FunctionDetail | None:
    """获取函数详情，包含调用关系和备注"""
    row = fetch_one(
        conn,
        """
        SELECT f.*, fi.rel_path AS file_path
        FROM functions f
        JOIN files fi ON f.file_id = fi.id
        WHERE f.id = ?
        """,
        (function_id,),
    )
    if row is None:
        return None

    # 解析decorators JSON字符串
    decorators_raw = row.get("decorators", "[]")
    try:
        decorators: list[str] = json.loads(decorators_raw) if decorators_raw else []
    except (json.JSONDecodeError, TypeError):
        decorators = []

    # 获取callers: 谁调用了这个函数
    callers = _get_callers(conn, function_id)

    # 合并查询callees和line_calls，减少一次数据库查询
    callees, line_calls = _get_callees_and_line_calls(conn, function_id)

    # 获取notes
    notes = _get_function_notes(conn, function_id)

    return FunctionDetail(
        id=row["id"],
        name=row["name"],
        qualified_name=row["qualified_name"],
        signature=row["signature"],
        file_path=row["file_path"],
        start_line=row["start_line"],
        end_line=row["end_line"],
        is_async=bool(row["is_async"]),
        is_method=bool(row["is_method"]),
        class_name=row["class_name"],
        body=row["body"],
        decorators=decorators,
        docstring=row["docstring"],
        is_read=bool(row["is_read"]),
        callers=callers,
        callees=callees,
        notes=notes,
        line_calls=line_calls,
    )


def _get_callees_and_line_calls(
    conn: sqlite3.Connection, function_id: int
) -> tuple[list[FunctionBrief], dict[str, list[CalleeOnLine]]]:
    """合并查询callees和line_calls，减少一次数据库查询"""
    rows = fetch_all(
        conn,
        """
        SELECT cr.call_line, f.id, f.name, f.qualified_name,
               fi.rel_path AS file_path, f.docstring
        FROM call_relations cr
        JOIN functions f ON cr.callee_id = f.id
        JOIN files fi ON f.file_id = fi.id
        WHERE cr.caller_id = ? AND cr.callee_id IS NOT NULL
        ORDER BY cr.call_line
        """,
        (function_id,),
    )

    # 提取去重的callees
    seen_ids: set[int] = set()
    callees: list[FunctionBrief] = []
    # 按行分组的line_calls
    line_calls: dict[str, list[CalleeOnLine]] = {}

    for row in rows:
        func_id: int = row["id"]
        if func_id not in seen_ids:
            seen_ids.add(func_id)
            callees.append(FunctionBrief(
                id=func_id,
                name=row["name"],
                qualified_name=row["qualified_name"],
                file_path=row["file_path"],
            ))
        line_key = str(row["call_line"])
        line_calls.setdefault(line_key, []).append(CalleeOnLine(
            id=func_id,
            name=row["name"],
            qualified_name=row["qualified_name"],
            file_path=row["file_path"],
            docstring=row["docstring"],
        ))

    return callees, line_calls


def _get_callers(conn: sqlite3.Connection, function_id: int) -> list[FunctionBrief]:
    """获取调用了指定函数的调用者列表"""
    rows = fetch_all(
        conn,
        """
        SELECT f.id, f.name, f.qualified_name, fi.rel_path AS file_path
        FROM call_relations cr
        JOIN functions f ON cr.caller_id = f.id
        JOIN files fi ON f.file_id = fi.id
        WHERE cr.callee_id = ?
        """,
        (function_id,),
    )
    return [FunctionBrief(**row) for row in rows]


def _get_callees(conn: sqlite3.Connection, function_id: int) -> list[FunctionBrief]:
    """获取指定函数调用的被调用者列表（仅已解析的）"""
    rows = fetch_all(
        conn,
        """
        SELECT f.id, f.name, f.qualified_name, fi.rel_path AS file_path
        FROM call_relations cr
        JOIN functions f ON cr.callee_id = f.id
        JOIN files fi ON f.file_id = fi.id
        WHERE cr.caller_id = ? AND cr.callee_id IS NOT NULL
        """,
        (function_id,),
    )
    return [FunctionBrief(**row) for row in rows]


def _get_line_calls(conn: sqlite3.Connection, function_id: int) -> dict[str, list[CalleeOnLine]]:
    """获取函数中每行调用的项目内函数信息，按行号分组"""
    rows = fetch_all(
        conn,
        """
        SELECT cr.call_line, f.id, f.name, f.qualified_name,
               fi.rel_path AS file_path, f.docstring
        FROM call_relations cr
        JOIN functions f ON cr.callee_id = f.id
        JOIN files fi ON f.file_id = fi.id
        WHERE cr.caller_id = ? AND cr.callee_id IS NOT NULL
        ORDER BY cr.call_line
        """,
        (function_id,),
    )
    result: dict[str, list[CalleeOnLine]] = {}
    for row in rows:
        line_key = str(row["call_line"])
        callee = CalleeOnLine(
            id=row["id"],
            name=row["name"],
            qualified_name=row["qualified_name"],
            file_path=row["file_path"],
            docstring=row["docstring"],
        )
        result.setdefault(line_key, []).append(callee)
    return result


def _get_function_notes(conn: sqlite3.Connection, function_id: int) -> list[NoteInFunction]:
    """获取函数关联的备注列表"""
    rows = fetch_all(
        conn,
        "SELECT id, content, note_type, created_at, updated_at FROM notes WHERE function_id = ?",
        (function_id,),
    )
    return [NoteInFunction(**row) for row in rows]


def get_callers(conn: sqlite3.Connection, function_id: int) -> list[FunctionBrief]:
    """公开接口：获取调用者列表"""
    return _get_callers(conn, function_id)


def get_callees(conn: sqlite3.Connection, function_id: int) -> list[FunctionBrief]:
    """公开接口：获取被调用者列表"""
    return _get_callees(conn, function_id)
