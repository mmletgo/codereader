"""AI辅助分析路由 — /api/v1/ai/"""
from fastapi import APIRouter, HTTPException, Query

from app.database import get_db
from app.models import (
    AIExplanationResponse,
    AIExplanationStatusResponse,
    AILineExplainRequest,
    AILineExplainResponse,
    AIAutoNotesRequest,
    AIAutoNotesResponse,
    ChatSendRequest,
    ChatHistoryResponse,
    ChatSendResponse,
)
from app.services.ai_service import (
    get_or_generate_explanation,
    get_cached_explanation_ids,
    generate_line_explanation,
    generate_auto_notes,
    get_chat_history,
    send_chat_message,
    delete_chat,
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


@router.get("/explanation-status", response_model=AIExplanationStatusResponse)
def get_explanation_status(
    project_id: int = Query(..., description="项目ID"),
) -> AIExplanationStatusResponse:
    """批量查询项目中已有有效AI解读缓存的函数ID"""
    with get_db() as conn:
        cached_ids = get_cached_explanation_ids(conn, project_id)
        return AIExplanationStatusResponse(cached_function_ids=cached_ids)


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


@router.get("/chat", response_model=ChatHistoryResponse)
def chat_history(
    function_id: int = Query(..., description="函数ID"),
) -> ChatHistoryResponse:
    """获取对话历史"""
    try:
        with get_db() as conn:
            data = get_chat_history(conn, function_id)
            return ChatHistoryResponse(**data)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取对话历史失败: {str(e)}")


@router.post("/chat", response_model=ChatSendResponse)
def chat_send(data: ChatSendRequest) -> ChatSendResponse:
    """发送对话消息"""
    try:
        with get_db() as conn:
            result = send_chat_message(conn, data.function_id, data.message)
            return ChatSendResponse(**result)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI对话失败: {str(e)}")


@router.delete("/chat")
def chat_delete(
    function_id: int = Query(..., description="函数ID"),
) -> dict[str, bool]:
    """重置对话"""
    with get_db() as conn:
        deleted = delete_chat(conn, function_id)
        return {"deleted": deleted}
