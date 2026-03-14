# app/ - FastAPI 应用层

## 文件说明
- `database.py` — SQLite数据库管理，建表语句，连接上下文管理器 `get_db()`，CRUD辅助函数，数据库迁移(`_migrate_db`)
- `models.py` — 所有Pydantic模型定义（请求体、响应体、内部数据结构），含CalleeOnLine（行级调用信息）
- `routers/` — API路由层（5个路由模块）
- `services/` — 业务逻辑层（4个服务模块）

## 数据库表结构 (6张表)
- `projects` — 项目信息（路径、名称、扫描时间）
- `files` — 源文件（内容、行数、语言）
- `functions` — 函数定义（签名、代码体、行号、排序权重sort_order、已读状态is_read）
- `call_relations` — 调用关系边（caller_id→callee_id，外部调用callee_id=NULL）
- `notes` — 阅后备注（绑定function_id，类型note_type，来源source：'user'用户手动/'ai'AI生成）
- `ai_explanations` — AI函数解读缓存（绑定function_id，存储explanation和func_body_hash用于缓存失效判断）

## 函数已读状态
- 已读状态直接存储在 functions 表的 `is_read` 列（BOOLEAN DEFAULT 0）
- 标记已读：`PUT /api/v1/functions/{function_id}/read` 将 is_read 设为 1
- 重置已读：`PUT /api/v1/functions/reset-read?project_id=X` 将项目所有函数 is_read 设为 0
- 重新扫描时通过 qualified_name + body 比较恢复未变更函数的已读状态
- reading_progress 表仅保存 last_function_id（阅读位置），不再追踪已读函数ID列表

## 使用模式
路由层调用 `get_db()` 获取数据库连接，使用 `fetch_one/fetch_all/insert_row/execute` 辅助函数操作数据。
所有路由返回Pydantic模型实例。
