"""备注管理路由 — /api/v1/notes/"""
from fastapi import APIRouter, HTTPException, Query

from app.database import get_db
from app.models import NoteCreate, NoteUpdate, NoteResponse
from app.services.note_service import (
    create_note,
    update_note,
    delete_note,
    get_notes,
)

router = APIRouter()


@router.post("/", response_model=NoteResponse)
def add_note(data: NoteCreate) -> NoteResponse:
    """创建备注"""
    with get_db() as conn:
        return create_note(conn, data)


@router.put("/{note_id}", response_model=NoteResponse)
def edit_note(note_id: int, data: NoteUpdate) -> NoteResponse:
    """更新备注（只更新非None的字段）"""
    with get_db() as conn:
        result = update_note(conn, note_id, data)
        if result is None:
            raise HTTPException(status_code=404, detail="备注不存在")
        return result


@router.delete("/{note_id}")
def remove_note(note_id: int) -> dict[str, str]:
    """删除备注"""
    with get_db() as conn:
        if not delete_note(conn, note_id):
            raise HTTPException(status_code=404, detail="备注不存在")
        return {"message": "备注已删除"}


@router.get("/", response_model=list[NoteResponse])
def list_notes(
    function_id: int | None = Query(None, description="函数ID"),
    project_id: int | None = Query(None, description="项目ID"),
) -> list[NoteResponse]:
    """查询备注列表"""
    with get_db() as conn:
        return get_notes(conn, function_id=function_id, project_id=project_id)
