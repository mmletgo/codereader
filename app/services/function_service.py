"""函数查询服务 — 分页列表、详情、调用关系"""
import json
import sqlite3

from app.database import fetch_one, fetch_all
from app.models import (
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
            f.start_line, f.end_line, f.is_async, f.is_method, f.class_name,
            (SELECT COUNT(*) FROM notes n WHERE n.function_id = f.id) AS note_count,
            (SELECT COUNT(*) FROM call_relations cr WHERE cr.callee_id = f.id) AS caller_count,
            (SELECT COUNT(*) FROM call_relations cr WHERE cr.caller_id = f.id AND cr.callee_id IS NOT NULL) AS callee_count
        FROM functions f
        JOIN files fi ON f.file_id = fi.id
        WHERE f.project_id = ?
        ORDER BY f.sort_order ASC
        LIMIT ? OFFSET ?
        """,
        (project_id, per_page, offset),
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

    # 获取callees: 这个函数调用了谁
    callees = _get_callees(conn, function_id)

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
        callers=callers,
        callees=callees,
        notes=notes,
    )


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
