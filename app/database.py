"""SQLite 数据库管理 - 建表、连接管理、CRUD辅助"""
import sqlite3
from pathlib import Path
from contextlib import contextmanager
from typing import Generator, Any

from config import DB_PATH, DATA_DIR


def get_connection() -> sqlite3.Connection:
    """获取数据库连接（启用WAL模式和外键约束）"""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def get_db() -> Generator[sqlite3.Connection, None, None]:
    """数据库连接上下文管理器，自动提交/回滚"""
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


_CREATE_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    root_path   TEXT NOT NULL UNIQUE,
    language    TEXT DEFAULT 'python',
    scan_time   DATETIME DEFAULT CURRENT_TIMESTAMP,
    file_count  INTEGER DEFAULT 0,
    func_count  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    rel_path    TEXT NOT NULL,
    language    TEXT NOT NULL,
    content     TEXT NOT NULL,
    line_count  INTEGER DEFAULT 0,
    UNIQUE(project_id, rel_path)
);

CREATE TABLE IF NOT EXISTS functions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    qualified_name  TEXT NOT NULL,
    signature       TEXT NOT NULL,
    start_line      INTEGER NOT NULL,
    end_line        INTEGER NOT NULL,
    body            TEXT NOT NULL,
    is_async        BOOLEAN DEFAULT 0,
    is_method       BOOLEAN DEFAULT 0,
    class_name      TEXT,
    decorators      TEXT DEFAULT '[]',
    docstring       TEXT,
    sort_order      INTEGER DEFAULT 0,
    is_read         BOOLEAN DEFAULT 0
);

CREATE TABLE IF NOT EXISTS call_relations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    caller_id   INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
    callee_id   INTEGER,
    callee_name TEXT NOT NULL,
    call_line   INTEGER,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    function_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    note_type   TEXT DEFAULT 'general',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_functions_project ON functions(project_id);
CREATE INDEX IF NOT EXISTS idx_functions_file ON functions(file_id);
CREATE INDEX IF NOT EXISTS idx_functions_sort ON functions(project_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_call_relations_caller ON call_relations(caller_id);
CREATE INDEX IF NOT EXISTS idx_call_relations_callee ON call_relations(callee_id);
CREATE INDEX IF NOT EXISTS idx_call_relations_project ON call_relations(project_id);
CREATE TABLE IF NOT EXISTS reading_progress (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id          INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
    last_function_id    INTEGER,
    read_function_ids   TEXT DEFAULT '[]',
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notes_function ON notes(function_id);
CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id);
CREATE INDEX IF NOT EXISTS idx_call_relations_caller_callee ON call_relations(caller_id, callee_id);

CREATE TABLE IF NOT EXISTS ai_explanations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    function_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
    explanation TEXT NOT NULL,
    func_body_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(function_id)
);

CREATE TABLE IF NOT EXISTS reading_paths (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    function_items TEXT NOT NULL DEFAULT '[]',
    last_index    INTEGER DEFAULT 0,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reading_paths_project ON reading_paths(project_id);
"""


def _migrate_db(conn: sqlite3.Connection) -> None:
    """数据库迁移：为已有表添加新列"""
    # 检查 functions 表是否已有 is_read 列
    columns = [row["name"] for row in conn.execute("PRAGMA table_info(functions)").fetchall()]
    if "is_read" not in columns:
        conn.execute("ALTER TABLE functions ADD COLUMN is_read BOOLEAN DEFAULT 0")

    # 检查 notes 表是否已有 source 列
    note_columns = [row["name"] for row in conn.execute("PRAGMA table_info(notes)").fetchall()]
    if "source" not in note_columns:
        conn.execute("ALTER TABLE notes ADD COLUMN source TEXT DEFAULT 'user'")

    # 检查 reading_paths 表是否存在，不存在则创建
    table_exists = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='reading_paths'"
    ).fetchone()
    if not table_exists:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS reading_paths (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name          TEXT NOT NULL,
                description   TEXT NOT NULL DEFAULT '',
                function_items TEXT NOT NULL DEFAULT '[]',
                last_index    INTEGER DEFAULT 0,
                created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_reading_paths_project ON reading_paths(project_id);
        """)


def init_db() -> None:
    """初始化数据库：创建目录和表，执行迁移"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with get_db() as conn:
        conn.executescript(_CREATE_TABLES_SQL)
        _migrate_db(conn)


# ========== CRUD 辅助函数 ==========

def insert_row(conn: sqlite3.Connection, table: str, data: dict[str, Any]) -> int:
    """插入一行数据，返回自增ID"""
    cols = ", ".join(data.keys())
    placeholders = ", ".join(["?"] * len(data))
    cursor = conn.execute(
        f"INSERT INTO {table} ({cols}) VALUES ({placeholders})",
        list(data.values()),
    )
    return cursor.lastrowid  # type: ignore[return-value]


def fetch_one(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> dict | None:
    """查询单行，返回字典或None"""
    row = conn.execute(sql, params).fetchone()
    return dict(row) if row else None


def fetch_all(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> list[dict]:
    """查询多行，返回字典列表"""
    rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def execute(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> int:
    """执行SQL，返回受影响行数"""
    cursor = conn.execute(sql, params)
    return cursor.rowcount
