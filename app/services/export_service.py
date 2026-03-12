"""导出服务 — 组装有备注的函数数据，支持JSON和Markdown格式"""
import sqlite3
from datetime import datetime

from app.database import fetch_one, fetch_all
from app.models import ExportData, ExportFunction, ExportNote


def get_export_data(conn: sqlite3.Connection, project_id: int) -> ExportData | None:
    """获取项目导出数据，只包含有备注的函数"""
    # 获取项目信息
    project = fetch_one(conn, "SELECT * FROM projects WHERE id = ?", (project_id,))
    if project is None:
        return None

    # 获取有备注的函数列表
    func_rows = fetch_all(
        conn,
        """
        SELECT DISTINCT f.id, f.qualified_name, fi.rel_path AS file_path,
               f.start_line, f.end_line, f.signature, f.body
        FROM functions f
        JOIN files fi ON f.file_id = fi.id
        JOIN notes n ON n.function_id = f.id
        WHERE f.project_id = ?
        ORDER BY fi.rel_path, f.start_line
        """,
        (project_id,),
    )

    export_functions: list[ExportFunction] = []
    for func_row in func_rows:
        function_id: int = func_row["id"]

        # 获取备注
        note_rows = fetch_all(
            conn,
            "SELECT note_type, content, created_at FROM notes WHERE function_id = ? ORDER BY created_at",
            (function_id,),
        )
        notes = [
            ExportNote(
                type=nr["note_type"],
                content=nr["content"],
                created_at=nr["created_at"],
            )
            for nr in note_rows
        ]

        # 获取被调用者名称列表（calls）
        callee_rows = fetch_all(
            conn,
            """
            SELECT f2.qualified_name
            FROM call_relations cr
            JOIN functions f2 ON cr.callee_id = f2.id
            WHERE cr.caller_id = ? AND cr.callee_id IS NOT NULL
            """,
            (function_id,),
        )
        calls = [r["qualified_name"] for r in callee_rows]

        # 获取调用者名称列表（called_by）
        caller_rows = fetch_all(
            conn,
            """
            SELECT f2.qualified_name
            FROM call_relations cr
            JOIN functions f2 ON cr.caller_id = f2.id
            WHERE cr.callee_id = ?
            """,
            (function_id,),
        )
        called_by = [r["qualified_name"] for r in caller_rows]

        export_functions.append(ExportFunction(
            qualified_name=func_row["qualified_name"],
            file=func_row["file_path"],
            lines=f"{func_row['start_line']}-{func_row['end_line']}",
            signature=func_row["signature"],
            code=func_row["body"],
            calls=calls,
            called_by=called_by,
            notes=notes,
        ))

    # 统计摘要
    total_notes = sum(len(f.notes) for f in export_functions)
    summary = {
        "total_functions": len(export_functions),
        "total_notes": total_notes,
    }

    return ExportData(
        project=project["name"],
        root_path=project["root_path"],
        export_time=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        summary=summary,
        functions=export_functions,
    )


def render_markdown(data: ExportData) -> str:
    """将导出数据渲染为Markdown格式"""
    lines: list[str] = []

    lines.append(f"# 项目阅后记录: {data.project}")
    lines.append(f"> 路径: {data.root_path}")
    lines.append(f"> 导出时间: {data.export_time}")
    lines.append("")
    lines.append("---")
    lines.append("")

    # 按文件分组
    functions_by_file: dict[str, list[ExportFunction]] = {}
    for func in data.functions:
        functions_by_file.setdefault(func.file, []).append(func)

    for file_path, funcs in functions_by_file.items():
        lines.append(f"## {file_path}")
        lines.append("")

        for func in funcs:
            lines.append(f"### {func.qualified_name}")
            lines.append(f"- **位置**: {func.file}:{func.lines}")
            lines.append(f"- **签名**: `{func.signature}`")
            if func.calls:
                lines.append(f"- **调用**: {', '.join(func.calls)}")
            if func.called_by:
                lines.append(f"- **被调用**: {', '.join(func.called_by)}")
            lines.append("")
            lines.append("```python")
            lines.append(func.code)
            lines.append("```")
            lines.append("")

            if func.notes:
                lines.append("#### 备注")
                for i, note in enumerate(func.notes, 1):
                    lines.append(f"{i}. **[{note.type}]** {note.content}")
                lines.append("")

    return "\n".join(lines)
