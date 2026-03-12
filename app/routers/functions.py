"""函数查询路由 — /api/v1/functions/"""
from fastapi import APIRouter, HTTPException, Query

from app.database import get_db, execute
from app.models import FunctionListResponse, FunctionDetail, FunctionBrief
from app.services.function_service import (
    get_function_list,
    get_function_detail,
    get_callers,
    get_callees,
)

router = APIRouter()


@router.get("/", response_model=FunctionListResponse)
def list_functions(
    project_id: int = Query(..., description="项目ID"),
    page: int = Query(1, ge=1, description="页码"),
    per_page: int = Query(50, ge=1, le=200, description="每页数量"),
) -> FunctionListResponse:
    """获取函数分页列表"""
    with get_db() as conn:
        return get_function_list(conn, project_id, page, per_page)


@router.get("/{function_id}", response_model=FunctionDetail)
def get_function(function_id: int) -> FunctionDetail:
    """获取函数详情"""
    with get_db() as conn:
        detail = get_function_detail(conn, function_id)
        if detail is None:
            raise HTTPException(status_code=404, detail="函数不存在")
        return detail


@router.put("/{function_id}/read")
def mark_function_read(function_id: int) -> dict[str, str]:
    """标记函数为已读"""
    with get_db() as conn:
        affected = execute(conn, "UPDATE functions SET is_read = 1 WHERE id = ?", (function_id,))
        if affected == 0:
            raise HTTPException(status_code=404, detail="函数不存在")
        return {"message": "ok"}


@router.get("/{function_id}/callers", response_model=list[FunctionBrief])
def get_function_callers(function_id: int) -> list[FunctionBrief]:
    """获取调用了指定函数的函数列表"""
    with get_db() as conn:
        return get_callers(conn, function_id)


@router.get("/{function_id}/callees", response_model=list[FunctionBrief])
def get_function_callees(function_id: int) -> list[FunctionBrief]:
    """获取指定函数调用的函数列表"""
    with get_db() as conn:
        return get_callees(conn, function_id)
