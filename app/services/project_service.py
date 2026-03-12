"""项目管理服务 — 创建、查询、删除、重新扫描"""
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


def delete_scan_data_and_preserve_notes(conn: sqlite3.Connection, project_id: int) -> list[dict]:
    """删除扫描数据并保留notes信息用于后续重新绑定

    Returns:
        备注列表，每项含 qualified_name 用于重新绑定
    """
    # 先获取notes和对应的qualified_name
    saved_notes = get_notes_for_rebind(conn, project_id)

    # 删除call_relations
    execute(conn, "DELETE FROM call_relations WHERE project_id = ?", (project_id,))
    # 删除notes（因为functions删除时会级联删除）
    # 但我们已保存了notes数据
    # 删除functions（会级联删除notes）
    execute(conn, "DELETE FROM functions WHERE project_id = ?", (project_id,))
    # 删除files
    execute(conn, "DELETE FROM files WHERE project_id = ?", (project_id,))

    return saved_notes


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
