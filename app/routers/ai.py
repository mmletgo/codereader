"""AI辅助分析路由 — /api/v1/ai/"""
from fastapi import APIRouter, HTTPException, Query

from app.database import get_db
from app.models import (
    AIExplanationResponse,
    AILineExplainRequest,
    AILineExplainResponse,
    AIAutoNotesRequest,
    AIAutoNotesResponse,
)
from app.services.ai_service import (
    get_or_generate_explanation,
    generate_line_explanation,
    generate_auto_notes,
)

router = APIRouter()


@router.get("/explanation", response_model=AIExplanationResponse)
def get_explanation(
    function_id: int = Query(..., description="函数ID"),
) -> AIExplanationResponse:
    """获取/生成函数AI解读"""
    try:
        with get_db() as conn:
            return get_or_generate_explanation(conn, function_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI分析失败: {str(e)}")


@router.post("/line-explain", response_model=AILineExplainResponse)
def line_explain(data: AILineExplainRequest) -> AILineExplainResponse:
    """行级代码解释"""
    try:
        with get_db() as conn:
            return generate_line_explanation(
                conn, data.function_id, data.line_number, data.line_content,
            )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI分析失败: {str(e)}")


@router.post("/auto-notes", response_model=AIAutoNotesResponse)
def auto_notes(data: AIAutoNotesRequest) -> AIAutoNotesResponse:
    """生成AI自动备注"""
    try:
        with get_db() as conn:
            notes = generate_auto_notes(conn, data.function_id, data.project_id)
            return AIAutoNotesResponse(notes=notes)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI分析失败: {str(e)}")
