"""调用关系图路由 — /api/v1/call_graph/"""
from fastapi import APIRouter, Query

from app.database import get_db, fetch_all
from app.models import CallGraphData, GraphNode, GraphLink

router = APIRouter()


@router.get("/", response_model=CallGraphData)
def get_call_graph(
    project_id: int = Query(..., description="项目ID"),
) -> CallGraphData:
    """获取调用关系图数据（D3.js兼容的nodes+links格式）"""
    with get_db() as conn:
        # 获取所有有调用关系的函数ID（作为caller或callee）
        # 只包含callee_id不为NULL的关系
        links_rows = fetch_all(
            conn,
            """
            SELECT cr.caller_id AS source, cr.callee_id AS target
            FROM call_relations cr
            WHERE cr.project_id = ? AND cr.callee_id IS NOT NULL
            """,
            (project_id,),
        )

        # 收集所有涉及的函数ID
        func_ids: set[int] = set()
        links: list[GraphLink] = []
        for row in links_rows:
            func_ids.add(row["source"])
            func_ids.add(row["target"])
            links.append(GraphLink(source=row["source"], target=row["target"]))

        # 如果没有调用关系，返回空图
        if not func_ids:
            return CallGraphData(nodes=[], links=[])

        # 获取这些函数的详细信息
        placeholders = ",".join(["?"] * len(func_ids))
        func_rows = fetch_all(
            conn,
            f"""
            SELECT f.id, f.name, f.qualified_name, fi.rel_path AS file_path,
                   f.class_name,
                   (SELECT COUNT(*) FROM notes n WHERE n.function_id = f.id) AS note_count
            FROM functions f
            JOIN files fi ON f.file_id = fi.id
            WHERE f.id IN ({placeholders})
            """,
            tuple(func_ids),
        )

        nodes: list[GraphNode] = []
        for row in func_rows:
            # group: 用文件路径作为分组依据
            group = row["file_path"]
            nodes.append(GraphNode(
                id=row["id"],
                name=row["name"],
                qualified_name=row["qualified_name"],
                file=row["file_path"],
                group=group,
                has_notes=row["note_count"] > 0,
            ))

        return CallGraphData(nodes=nodes, links=links)
