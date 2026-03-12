# app/routers/ - API 路由层

## 路由模块
- `projects.py` — `/api/v1/projects/` 项目管理（创建/扫描、列表、详情、删除、重新扫描）
- `functions.py` — `/api/v1/functions/` 函数查询（分页列表、详情含代码+调用关系+备注、调用者/被调用者）
- `notes.py` — `/api/v1/notes/` 备注增删改查
- `call_graph.py` — `/api/v1/call_graph/` 调用关系图数据（D3.js兼容的nodes+links格式）
- `export.py` — `/api/v1/export/` 导出阅后记录（JSON/Markdown格式）

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
- `POST /{project_id}/rescan` — 重新扫描：保留notes通过qualified_name重新绑定

### functions.py
- `GET /` — 分页列表(project_id必须, page, per_page)，按sort_order ASC排序，附带note/caller/callee计数
- `GET /{function_id}` — 详情含decorators(JSON解析)、callers、callees、notes
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
