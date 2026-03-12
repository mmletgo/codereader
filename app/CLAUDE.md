# app/ - FastAPI 应用层

## 文件说明
- `database.py` — SQLite数据库管理，建表语句，连接上下文管理器 `get_db()`，CRUD辅助函数
- `models.py` — 所有Pydantic模型定义（请求体、响应体、内部数据结构）
- `routers/` — API路由层（5个路由模块）
- `services/` — 业务逻辑层（4个服务模块）

## 数据库表结构 (5张表)
- `projects` — 项目信息（路径、名称、扫描时间）
- `files` — 源文件（内容、行数、语言）
- `functions` — 函数定义（签名、代码体、行号、排序权重sort_order）
- `call_relations` — 调用关系边（caller_id→callee_id，外部调用callee_id=NULL）
- `notes` — 阅后备注（绑定function_id，类型note_type）

## 使用模式
路由层调用 `get_db()` 获取数据库连接，使用 `fetch_one/fetch_all/insert_row/execute` 辅助函数操作数据。
所有路由返回Pydantic模型实例。
