"""AI阅读路径路由 — /api/v1/reading-paths/"""
from fastapi import APIRouter, HTTPException, Query

from app.database import get_db
from app.models import (
    ReadingPathCreate,
    ReadingPathDetailResponse,
    ReadingPathListItem,
    ReadingPathProgressUpdate,
)
from app.services.reading_path_service import (
    generate_reading_path,
    get_reading_paths,
    get_reading_path_detail,
    delete_reading_path,
    update_progress,
)

router = APIRouter()


@router.post("/", response_model=ReadingPathDetailResponse)
def create_reading_path(data: ReadingPathCreate) -> ReadingPathDetailResponse:
    """创建阅读路径（AI生成）"""
    try:
        with get_db() as conn:
            return generate_reading_path(conn, data.project_id, data.query)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI生成阅读路径失败: {str(e)}")


@router.get("/", response_model=list[ReadingPathListItem])
def list_reading_paths(
    project_id: int = Query(..., description="项目ID"),
) -> list[ReadingPathListItem]:
    """获取项目的阅读路径列表"""
    with get_db() as conn:
        return get_reading_paths(conn, project_id)


@router.get("/{path_id}", response_model=ReadingPathDetailResponse)
def get_reading_path(path_id: int) -> ReadingPathDetailResponse:
    """获取阅读路径详情"""
    with get_db() as conn:
        result = get_reading_path_detail(conn, path_id)
        if result is None:
            raise HTTPException(status_code=404, detail="阅读路径不存在")
        return result


@router.delete("/{path_id}")
def remove_reading_path(path_id: int) -> dict[str, str]:
    """删除阅读路径"""
    with get_db() as conn:
        if not delete_reading_path(conn, path_id):
            raise HTTPException(status_code=404, detail="阅读路径不存在")
        return {"message": "阅读路径已删除"}


@router.put("/{path_id}/progress")
def update_reading_path_progress(
    path_id: int,
    data: ReadingPathProgressUpdate,
) -> dict[str, str]:
    """更新阅读进度"""
    try:
        with get_db() as conn:
            update_progress(conn, path_id, data.last_index)
            return {"message": "进度已更新"}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
