"""项目管理路由 — /api/v1/projects/"""
from fastapi import APIRouter, HTTPException

from app.database import get_db
from app.models import ProjectCreate, ProjectResponse
from app.services.project_service import (
    get_all_projects,
    get_project_by_id,
    get_project_row,
    delete_project,
    delete_scan_data_and_preserve_notes,
    rebind_notes,
    restore_read_status,
)
from analyzer.engine import analyze_project

router = APIRouter()


@router.post("/", response_model=ProjectResponse)
def create_project(data: ProjectCreate) -> ProjectResponse:
    """创建项目并执行代码扫描"""
    import os
    root_path = os.path.abspath(data.root_path)
    project_id = analyze_project(
        root_path=root_path,
        project_name=data.name,
        include=data.include_patterns,
        exclude=data.exclude_patterns,
    )
    with get_db() as conn:
        project = get_project_by_id(conn, project_id)
        if project is None:
            raise HTTPException(status_code=500, detail="项目创建失败")
        return project


@router.get("/", response_model=list[ProjectResponse])
def list_projects() -> list[ProjectResponse]:
    """获取所有项目列表"""
    with get_db() as conn:
        return get_all_projects(conn)


@router.get("/{project_id}", response_model=ProjectResponse)
def get_project(project_id: int) -> ProjectResponse:
    """获取项目详情"""
    with get_db() as conn:
        project = get_project_by_id(conn, project_id)
        if project is None:
            raise HTTPException(status_code=404, detail="项目不存在")
        return project


@router.delete("/{project_id}")
def remove_project(project_id: int) -> dict[str, str]:
    """删除项目（级联删除所有关联数据）"""
    with get_db() as conn:
        if not delete_project(conn, project_id):
            raise HTTPException(status_code=404, detail="项目不存在")
        return {"message": "项目已删除"}


@router.post("/{project_id}/rescan", response_model=ProjectResponse)
def rescan_project(project_id: int) -> ProjectResponse:
    """重新扫描项目"""
    with get_db() as conn:
        project_row = get_project_row(conn, project_id)
        if project_row is None:
            raise HTTPException(status_code=404, detail="项目不存在")

        root_path: str = project_row["root_path"]
        project_name: str = project_row["name"]

        # 删除旧的扫描数据，保留notes和已读状态
        saved_notes, old_read_status = delete_scan_data_and_preserve_notes(conn, project_id)

    # 重新扫描，复用已有project_id
    analyze_project(
        root_path=root_path,
        project_name=project_name,
        existing_project_id=project_id,
    )

    # 重新绑定notes和已读状态
    with get_db() as conn:
        rebind_notes(conn, project_id, saved_notes)
        restore_read_status(conn, project_id, old_read_status)

        project = get_project_by_id(conn, project_id)
        if project is None:
            raise HTTPException(status_code=500, detail="重新扫描后项目信息获取失败")
        return project
