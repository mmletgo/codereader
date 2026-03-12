"""阅读进度路由 — /api/v1/progress/"""
import json

from fastapi import APIRouter, Query

from app.database import get_db, fetch_one, execute
from app.models import ProgressUpdate, ProgressResponse

router = APIRouter()


@router.get("/", response_model=ProgressResponse)
def get_progress(
    project_id: int = Query(..., description="项目ID"),
) -> ProgressResponse:
    """获取项目阅读进度"""
    with get_db() as conn:
        row = fetch_one(
            conn,
            "SELECT * FROM reading_progress WHERE project_id = ?",
            (project_id,),
        )
        if row is None:
            return ProgressResponse(project_id=project_id)
        read_ids: list[int] = json.loads(row["read_function_ids"] or "[]")
        return ProgressResponse(
            project_id=project_id,
            last_function_id=row["last_function_id"],
            read_function_ids=read_ids,
        )


@router.put("/", response_model=ProgressResponse)
def save_progress(
    project_id: int = Query(..., description="项目ID"),
    data: ProgressUpdate = ...,
) -> ProgressResponse:
    """保存项目阅读进度（自动合并已读列表）"""
    with get_db() as conn:
        existing = fetch_one(
            conn,
            "SELECT * FROM reading_progress WHERE project_id = ?",
            (project_id,),
        )

        if existing is None:
            read_ids: list[int] = data.read_function_ids or []
            conn.execute(
                "INSERT INTO reading_progress (project_id, last_function_id, read_function_ids) "
                "VALUES (?, ?, ?)",
                (project_id, data.last_function_id, json.dumps(read_ids)),
            )
        else:
            # 合并已读列表
            old_read: list[int] = json.loads(existing["read_function_ids"] or "[]")
            if data.read_function_ids:
                merged = list(set(old_read) | set(data.read_function_ids))
            else:
                merged = old_read

            last_fid = data.last_function_id if data.last_function_id is not None else existing["last_function_id"]
            execute(
                conn,
                "UPDATE reading_progress SET last_function_id = ?, read_function_ids = ?, "
                "updated_at = CURRENT_TIMESTAMP WHERE project_id = ?",
                (last_fid, json.dumps(merged), project_id),
            )

        # 返回最新状态
        row = fetch_one(
            conn,
            "SELECT * FROM reading_progress WHERE project_id = ?",
            (project_id,),
        )
        assert row is not None
        return ProgressResponse(
            project_id=project_id,
            last_function_id=row["last_function_id"],
            read_function_ids=json.loads(row["read_function_ids"] or "[]"),
        )
