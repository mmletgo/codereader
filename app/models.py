"""Pydantic 模型定义 - 请求/响应/内部数据结构"""
from pydantic import BaseModel


# ========== Project ==========

class ProjectCreate(BaseModel):
    root_path: str
    name: str | None = None
    include_patterns: list[str] = ["*.py"]
    exclude_patterns: list[str] = []


class ProjectResponse(BaseModel):
    id: int
    name: str
    root_path: str
    language: str
    scan_time: str
    file_count: int
    func_count: int


# ========== Function ==========

class FunctionListItem(BaseModel):
    id: int
    name: str
    qualified_name: str
    signature: str
    file_path: str
    start_line: int
    end_line: int
    is_async: bool
    is_method: bool
    class_name: str | None = None
    has_notes: bool = False
    note_count: int = 0
    caller_count: int = 0
    callee_count: int = 0
    is_read: bool = False


class FunctionBrief(BaseModel):
    """用于调用关系中的简要函数信息"""
    id: int
    name: str
    qualified_name: str
    file_path: str


class NoteInFunction(BaseModel):
    """嵌入在函数详情中的备注"""
    id: int
    content: str
    note_type: str
    created_at: str
    updated_at: str
    source: str = "user"


class FunctionDetail(BaseModel):
    id: int
    name: str
    qualified_name: str
    signature: str
    file_path: str
    start_line: int
    end_line: int
    is_async: bool
    is_method: bool
    class_name: str | None = None
    body: str
    decorators: list[str]
    docstring: str | None = None
    is_read: bool = False
    callers: list[FunctionBrief]
    callees: list[FunctionBrief]
    notes: list[NoteInFunction]


# ========== Function List (分页) ==========

class FunctionListResponse(BaseModel):
    total: int
    page: int
    per_page: int
    items: list[FunctionListItem]


# ========== Note ==========

class NoteCreate(BaseModel):
    function_id: int
    project_id: int
    content: str
    note_type: str = "general"


class NoteUpdate(BaseModel):
    content: str | None = None
    note_type: str | None = None


class NoteResponse(BaseModel):
    id: int
    function_id: int
    project_id: int
    content: str
    note_type: str
    created_at: str
    updated_at: str
    source: str = "user"


# ========== Reading Progress ==========

class ProgressUpdate(BaseModel):
    last_function_id: int | None = None


class ProgressResponse(BaseModel):
    project_id: int
    last_function_id: int | None = None


# ========== Call Graph ==========

class GraphNode(BaseModel):
    id: int
    name: str
    qualified_name: str
    file: str
    group: str
    has_notes: bool = False


class GraphLink(BaseModel):
    source: int
    target: int


class CallGraphData(BaseModel):
    nodes: list[GraphNode]
    links: list[GraphLink]


# ========== Export ==========

class ExportNote(BaseModel):
    type: str
    content: str
    created_at: str


class ExportFunction(BaseModel):
    qualified_name: str
    file: str
    lines: str
    signature: str
    code: str
    calls: list[str]
    called_by: list[str]
    notes: list[ExportNote]


class ExportData(BaseModel):
    project: str
    root_path: str
    export_time: str
    summary: dict
    functions: list[ExportFunction]


# ========== AI ==========

class AIExplanationResponse(BaseModel):
    function_id: int
    explanation: str
    cached: bool = False


class AILineExplainRequest(BaseModel):
    function_id: int
    line_number: int
    line_content: str


class AILineExplainResponse(BaseModel):
    line_number: int
    explanation: str


class AIAutoNotesRequest(BaseModel):
    function_id: int
    project_id: int


class AIAutoNotesResponse(BaseModel):
    notes: list[NoteResponse]
