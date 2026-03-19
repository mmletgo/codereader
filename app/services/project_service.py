"""项目管理服务 — 创建、查询、删除、重新扫描"""
import hashlib
import sqlite3
from datetime import datetime

from app.database import fetch_one, fetch_all, execute
from app.models import ProjectResponse


def get_all_projects(conn: sqlite3.Connection) -> list[ProjectResponse]:
    """获取所有项目列表"""
    rows = fetch_all(conn, "SELECT * FROM projects ORDER BY id DESC")
    return [ProjectResponse(**row) for row in rows]


def get_project_by_id(conn: sqlite3.Connection, project_id: int) -> ProjectResponse | None:
    """根据ID获取项目详情"""
    row = fetch_one(conn, "SELECT * FROM projects WHERE id = ?", (project_id,))
    if row is None:
        return None
    return ProjectResponse(**row)


def get_project_row(conn: sqlite3.Connection, project_id: int) -> dict | None:
    """获取项目原始行数据（内部使用）"""
    return fetch_one(conn, "SELECT * FROM projects WHERE id = ?", (project_id,))


def delete_project(conn: sqlite3.Connection, project_id: int) -> bool:
    """删除项目（级联删除所有关联数据）"""
    affected = execute(conn, "DELETE FROM projects WHERE id = ?", (project_id,))
    return affected > 0


def delete_project_scan_data(conn: sqlite3.Connection, project_id: int) -> None:
    """删除项目的扫描数据（files、functions、call_relations），保留notes"""
    # 由于外键级联，删除files会自动删除functions和call_relations
    # 但notes引用function_id也会级联删除，所以需要先保存notes
    # 改为手动删除，保留notes
    execute(conn, "DELETE FROM call_relations WHERE project_id = ?", (project_id,))
    # 在删除functions前，需要先将notes的function_id置空或保存
    # 但notes表的function_id有外键约束ON DELETE CASCADE
    # 所以我们需要先暂存notes，删除functions后重新插入
    # 实际上，我们保存notes的qualified_name映射，以便重新绑定
    pass


def get_notes_for_rebind(conn: sqlite3.Connection, project_id: int) -> list[dict]:
    """获取项目的备注及其对应函数的qualified_name，用于重新扫描后重新绑定"""
    rows = fetch_all(
        conn,
        """
        SELECT n.id, n.content, n.note_type, n.created_at, n.updated_at, n.project_id,
               f.qualified_name
        FROM notes n
        JOIN functions f ON n.function_id = f.id
        WHERE n.project_id = ?
        """,
        (project_id,),
    )
    return rows


def get_read_status_for_rebind(conn: sqlite3.Connection, project_id: int) -> dict[str, tuple[bool, str]]:
    """获取项目函数的已读状态和代码体，用于重扫后恢复。

    Returns:
        {qualified_name: (is_read, body)}
    """
    rows = fetch_all(
        conn,
        "SELECT qualified_name, is_read, body FROM functions WHERE project_id = ?",
        (project_id,),
    )
    return {row["qualified_name"]: (bool(row["is_read"]), row["body"]) for row in rows}


def restore_read_status(
    conn: sqlite3.Connection,
    project_id: int,
    old_status: dict[str, tuple[bool, str]],
) -> None:
    """重新扫描后，对 qualified_name 和 body 均未变的函数恢复 is_read=1"""
    functions = fetch_all(
        conn,
        "SELECT id, qualified_name, body FROM functions WHERE project_id = ?",
        (project_id,),
    )
    for func in functions:
        qname: str = func["qualified_name"]
        if qname in old_status:
            old_is_read, old_body = old_status[qname]
            if old_is_read and func["body"] == old_body:
                execute(conn, "UPDATE functions SET is_read = 1 WHERE id = ?", (func["id"],))


def get_ai_explanations_for_rebind(
    conn: sqlite3.Connection, project_id: int
) -> list[dict]:
    """获取项目的AI解读缓存及其对应函数的qualified_name，用于重新扫描后重新绑定"""
    rows = fetch_all(
        conn,
        """
        SELECT ae.explanation, ae.func_body_hash, f.qualified_name
        FROM ai_explanations ae
        JOIN functions f ON ae.function_id = f.id
        WHERE f.project_id = ?
        """,
        (project_id,),
    )
    return rows


def rebind_ai_explanations(
    conn: sqlite3.Connection,
    project_id: int,
    saved_explanations: list[dict],
) -> None:
    """重新扫描后，通过qualified_name将AI解读缓存绑定到新的function_id。

    只恢复函数体未变（hash匹配）的缓存，变了的跳过等待按需重新生成。
    """
    for item in saved_explanations:
        qname: str = item["qualified_name"]
        func_row = fetch_one(
            conn,
            "SELECT id, body FROM functions WHERE project_id = ? AND qualified_name = ?",
            (project_id, qname),
        )
        if func_row is None:
            continue
        # 比较函数体哈希，一致才恢复
        new_hash = hashlib.sha256(func_row["body"].encode("utf-8")).hexdigest()
        if new_hash == item["func_body_hash"]:
            conn.execute(
                "INSERT INTO ai_explanations (function_id, explanation, func_body_hash) VALUES (?, ?, ?)",
                (func_row["id"], item["explanation"], item["func_body_hash"]),
            )


def delete_scan_data_and_preserve_notes(
    conn: sqlite3.Connection, project_id: int
) -> tuple[list[dict], dict[str, tuple[bool, str]], list[dict]]:
    """删除扫描数据并保留notes、已读状态、AI解读缓存用于后续重新绑定

    Returns:
        (saved_notes, old_read_status, saved_ai_explanations)
    """
    # 先获取notes和对应的qualified_name
    saved_notes = get_notes_for_rebind(conn, project_id)
    # 获取已读状态
    old_read_status = get_read_status_for_rebind(conn, project_id)
    # 获取AI解读缓存
    saved_ai_explanations = get_ai_explanations_for_rebind(conn, project_id)

    # 删除call_relations
    execute(conn, "DELETE FROM call_relations WHERE project_id = ?", (project_id,))
    # 删除functions（会级联删除notes和ai_explanations，但已保存）
    execute(conn, "DELETE FROM functions WHERE project_id = ?", (project_id,))
    # 删除files
    execute(conn, "DELETE FROM files WHERE project_id = ?", (project_id,))

    return saved_notes, old_read_status, saved_ai_explanations


def rebind_notes(conn: sqlite3.Connection, project_id: int, saved_notes: list[dict]) -> None:
    """重新扫描后，通过qualified_name将保存的notes绑定到新的function_id"""
    for note_data in saved_notes:
        qualified_name = note_data["qualified_name"]
        # 查找新的function_id
        func_row = fetch_one(
            conn,
            "SELECT id FROM functions WHERE project_id = ? AND qualified_name = ?",
            (project_id, qualified_name),
        )
        if func_row is not None:
            conn.execute(
                "INSERT INTO notes (function_id, project_id, content, note_type, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    func_row["id"],
                    project_id,
                    note_data["content"],
                    note_data["note_type"],
                    note_data["created_at"],
                    note_data["updated_at"],
                ),
            )
