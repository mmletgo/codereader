"""备注CRUD服务"""
import sqlite3

from app.database import fetch_one, fetch_all, insert_row, execute
from app.models import NoteCreate, NoteUpdate, NoteResponse


def create_note(conn: sqlite3.Connection, data: NoteCreate) -> NoteResponse:
    """创建备注"""
    note_id = insert_row(conn, "notes", {
        "function_id": data.function_id,
        "project_id": data.project_id,
        "content": data.content,
        "note_type": data.note_type,
    })
    row = fetch_one(conn, "SELECT * FROM notes WHERE id = ?", (note_id,))
    assert row is not None
    return NoteResponse(**row)


def update_note(conn: sqlite3.Connection, note_id: int, data: NoteUpdate) -> NoteResponse | None:
    """更新备注，只更新非None的字段"""
    # 检查备注是否存在
    existing = fetch_one(conn, "SELECT * FROM notes WHERE id = ?", (note_id,))
    if existing is None:
        return None

    # 构建更新字段
    updates: list[str] = []
    params: list[str | int] = []

    if data.content is not None:
        updates.append("content = ?")
        params.append(data.content)
    if data.note_type is not None:
        updates.append("note_type = ?")
        params.append(data.note_type)

    # 始终更新 updated_at
    updates.append("updated_at = CURRENT_TIMESTAMP")

    if updates:
        params.append(note_id)
        sql = f"UPDATE notes SET {', '.join(updates)} WHERE id = ?"
        execute(conn, sql, tuple(params))

    row = fetch_one(conn, "SELECT * FROM notes WHERE id = ?", (note_id,))
    assert row is not None
    return NoteResponse(**row)


def delete_note(conn: sqlite3.Connection, note_id: int) -> bool:
    """删除备注"""
    affected = execute(conn, "DELETE FROM notes WHERE id = ?", (note_id,))
    return affected > 0


def get_notes(
    conn: sqlite3.Connection,
    function_id: int | None = None,
    project_id: int | None = None,
) -> list[NoteResponse]:
    """查询备注列表，支持按function_id和project_id过滤"""
    conditions: list[str] = []
    params: list[int] = []

    if function_id is not None:
        conditions.append("function_id = ?")
        params.append(function_id)
    if project_id is not None:
        conditions.append("project_id = ?")
        params.append(project_id)

    sql = "SELECT * FROM notes"
    if conditions:
        sql += " WHERE " + " AND ".join(conditions)
    sql += " ORDER BY created_at DESC"

    rows = fetch_all(conn, sql, tuple(params))
    return [NoteResponse(**row) for row in rows]
