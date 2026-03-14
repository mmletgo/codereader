# app/routers/ - API 路由层

## 路由模块
- `projects.py` — `/api/v1/projects/` 项目管理（创建/扫描、列表、详情、删除、重新扫描）
- `functions.py` — `/api/v1/functions/` 函数查询（分页列表、详情含代码+调用关系+备注、调用者/被调用者）
- `notes.py` — `/api/v1/notes/` 备注增删改查
- `call_graph.py` — `/api/v1/call_graph/` 调用关系图数据（D3.js兼容的nodes+links格式）
- `export.py` — `/api/v1/export/` 导出阅后记录（JSON/Markdown格式）
- `reading_paths.py` — `/api/v1/reading-paths/` AI阅读路径（生成、列表、详情、删除、进度更新）

## API设计规范
- 所有路由使用 `APIRouter(prefix=..., tags=[...])`
- 使用 `with app.database.get_db() as conn:` 获取数据库连接，传给服务函数
- 请求/响应模型定义在 `app.models`
- projects路由中创建项目时调用 `analyzer.engine.analyze_project()` 执行扫描

## 各路由端点详情

### projects.py
- `POST /` — 接收ProjectCreate，调用analyze_project扫描后返回ProjectResponse
- `GET /` — 返回list[ProjectResponse]
- `GET /{project_id}` — 返回ProjectResponse，不存在返回404
- `DELETE /{project_id}` — 级联删除项目
- `POST /{project_id}/rescan` — 重新扫描：保留notes和已读状态，通过qualified_name重新绑定notes，通过qualified_name+body比较恢复已读状态

### functions.py
- `GET /` — 分页列表(project_id必须, page, per_page)，按sort_order ASC排序，附带note/caller/callee计数和is_read状态
- `GET /{function_id}` — 详情含decorators(JSON解析)、is_read、callers、callees、notes
- `PUT /{function_id}/read` — 标记函数为已读（设置is_read=1），不存在返回404
- `PUT /reset-read?project_id=X` — 重置项目所有函数已读状态为未读
- `GET /{function_id}/callers` — 返回list[FunctionBrief]
- `GET /{function_id}/callees` — 返回list[FunctionBrief]

### notes.py
- `POST /` — 创建备注(NoteCreate)
- `PUT /{note_id}` — 更新备注(NoteUpdate)，只更新非None字段，更新updated_at
- `DELETE /{note_id}` — 删除备注
- `GET /` — 查询备注(可选function_id, project_id过滤)

### call_graph.py
- `GET /` — 返回CallGraphData(nodes+links)，只含callee_id非NULL的关系，nodes按文件分组

### export.py
- `GET /` — 导出(project_id必须, format=json|markdown)，只导出有备注的函数

### ai.py
- `GET /explanation` — 获取/生成函数AI解读（function_id查询参数），带缓存（基于函数体SHA256哈希判断失效）
- `POST /line-explain` — 行级代码解释（请求体：function_id, line_number, line_content）
- `POST /auto-notes` — 生成AI自动备注（请求体：function_id, project_id），备注source='ai'

### reading_paths.py
- `POST /` — 创建阅读路径（AI生成），请求体：ReadingPathCreate(project_id, query)
- `GET /` — 获取项目阅读路径列表，查询参数：project_id
- `GET /{path_id}` — 获取阅读路径详情
- `DELETE /{path_id}` — 删除阅读路径
- `PUT /{path_id}/progress` — 更新阅读进度，请求体：ReadingPathProgressUpdate(last_index)

### ai.py（对话端点）
- `GET /chat` — 获取对话历史，查询参数：function_id，返回ChatHistoryResponse（含func_body_changed标记）
- `POST /chat` — 发送对话消息，请求体：ChatSendRequest(function_id, message)，AI支持tool use（read_file/search_functions/get_call_relations），返回ChatSendResponse
- `DELETE /chat` — 重置对话，查询参数：function_id
