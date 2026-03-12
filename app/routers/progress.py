"""阅读进度路由 — /api/v1/progress/"""
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
        return ProgressResponse(
            project_id=project_id,
            last_function_id=row["last_function_id"],
        )


@router.put("/", response_model=ProgressResponse)
def save_progress(
    project_id: int = Query(..., description="项目ID"),
    data: ProgressUpdate = ...,
) -> ProgressResponse:
    """保存项目阅读进度"""
    with get_db() as conn:
        existing = fetch_one(
            conn,
            "SELECT * FROM reading_progress WHERE project_id = ?",
            (project_id,),
        )

        if existing is None:
            conn.execute(
                "INSERT INTO reading_progress (project_id, last_function_id) "
                "VALUES (?, ?)",
                (project_id, data.last_function_id),
            )
        else:
            last_fid = data.last_function_id if data.last_function_id is not None else existing["last_function_id"]
            execute(
                conn,
                "UPDATE reading_progress SET last_function_id = ?, "
                "updated_at = CURRENT_TIMESTAMP WHERE project_id = ?",
                (last_fid, project_id),
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
        )
