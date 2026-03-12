# app/services/ - 业务逻辑层

## 服务模块
- `project_service.py` — 项目管理（获取项目列表/详情、删除、重新扫描时的数据保存与恢复）
- `function_service.py` — 函数查询（分页列表含计数、详情含调用关系+备注、caller/callee查询）
- `note_service.py` — 备注CRUD（创建、更新非None字段、删除、按条件查询）
- `export_service.py` — 导出逻辑（组装有备注函数的完整数据、渲染Markdown格式）
- `ai_service.py` — AI辅助分析（函数解读生成与缓存、行级代码解释、自动备注生成），使用anthropic SDK调用Claude API

## 职责划分
服务层封装业务逻辑和数据库查询，路由层只负责参数校验和响应序列化。
服务函数接收 `sqlite3.Connection` 作为第一个参数。

## 关键逻辑

### project_service.py
- `delete_scan_data_and_preserve_notes()` — 重新扫描前保存notes映射和已读状态，然后删除files/functions/call_relations，返回 (saved_notes, old_read_status)
- `rebind_notes()` — 重新扫描后通过qualified_name查找新function_id，重新插入notes
- `get_read_status_for_rebind()` — 获取项目函数的已读状态和代码体，返回 {qualified_name: (is_read, body)}
- `restore_read_status()` — 重新扫描后，对qualified_name和body均未变的函数恢复is_read=1

### function_service.py
- 分页查询使用子查询统计note_count、caller_count、callee_count，同时返回is_read状态
- 详情中decorators从JSON字符串解析为list[str]
- callers通过call_relations表的callee_id查询，callees通过caller_id查询(callee_id非NULL)

### export_service.py
- `get_export_data()` — 通过JOIN notes表筛选有备注的函数，组装完整导出数据
- `render_markdown()` — 按文件分组渲染Markdown，包含位置、签名、调用关系、代码块、备注列表
