# app/routers/ - API 路由层

## 路由模块
- `projects.py` — `/api/v1/projects/` 项目管理（创建/扫描、列表、详情、删除、重新扫描）
- `functions.py` — `/api/v1/functions/` 函数查询（分页列表、详情含代码+调用关系+备注、调用者/被调用者）
- `notes.py` — `/api/v1/notes/` 备注增删改查
- `call_graph.py` — `/api/v1/call_graph/` 调用关系图数据（D3.js兼容的nodes+links格式）
- `export.py` — `/api/v1/export/` 导出阅后记录（JSON/Markdown格式）

## API设计规范
- 所有路由使用 `APIRouter()`
- 使用 `app.database.get_db()` 获取数据库连接
- 请求/响应模型定义在 `app.models`
- projects路由中创建项目时调用 `analyzer.engine.analyze_project()` 执行扫描
