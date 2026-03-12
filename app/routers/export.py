"""导出路由 — /api/v1/export/"""
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from app.database import get_db
from app.services.export_service import get_export_data, render_markdown, save_export_file

router = APIRouter()


@router.get("/", response_model=None)
def export_notes(
    project_id: int = Query(..., description="项目ID"),
    format: str = Query("json", description="导出格式: json 或 markdown"),
) -> Response | dict:
    """导出阅后记录"""
    with get_db() as conn:
        data = get_export_data(conn, project_id)
        if data is None:
            raise HTTPException(status_code=404, detail="项目不存在")

    if format == "markdown":
        md_text = render_markdown(data)
        return Response(content=md_text, media_type="text/markdown")

    # 默认JSON格式
    return data.model_dump()


@router.post("/save")
def save_export(
    project_id: int = Query(..., description="项目ID"),
    format: str = Query("json", description="导出格式: json 或 markdown"),
) -> dict[str, str]:
    """导出并保存到服务端"""
    with get_db() as conn:
        data = get_export_data(conn, project_id)
        if data is None:
            raise HTTPException(status_code=404, detail="项目不存在")

    filepath = save_export_file(data, format)
    return {"message": "已保存", "path": filepath}
