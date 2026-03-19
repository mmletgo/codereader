# app/services/ - 业务逻辑层

## 服务模块
- `project_service.py` — 项目管理（获取项目列表/详情、删除、重新扫描时的数据保存与恢复）
- `function_service.py` — 函数查询（分页列表含计数、详情含调用关系+备注+行级调用信息、caller/callee查询）
- `note_service.py` — 备注CRUD（创建、更新非None字段、删除、按条件查询）
- `export_service.py` — 导出逻辑（组装有备注函数的完整数据、渲染Markdown格式）
- `ai_service.py` — AI辅助分析（函数解读生成与缓存、行级代码解释、自动备注生成、函数级AI对话），使用anthropic SDK调用Claude API，对话支持tool use（read_file/search_functions/get_call_relations）
- `reading_path_service.py` — AI阅读路径（生成、列表、详情、删除、进度更新），AI根据用户查询从项目函数列表中选择相关函数并排序为推荐阅读路径

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
- 分页查询使用LEFT JOIN预聚合子查询统计note_count、caller_count、callee_count（替代关联子查询，性能更优），同时返回is_read状态
- 详情中decorators从JSON字符串解析为list[str]
- callers通过call_relations表的callee_id查询，callees通过caller_id查询(callee_id非NULL)
- `_get_callees_and_line_calls()` — 合并查询callees和line_calls，一次数据库查询同时提取去重的被调用函数列表和按行分组的行级调用信息，包含call_expression（原始调用表达式）用于前端多候选分组
- `_get_line_calls()` — 独立查询函数中每行调用的项目内函数（按call_line分组），包含call_expression，供其他场景使用

### export_service.py
- `get_export_data()` — 通过JOIN notes表筛选有备注的函数，组装完整导出数据
- `render_markdown()` — 按文件分组渲染Markdown，包含位置、签名、调用关系、代码块、备注列表

### reading_path_service.py
- `generate_reading_path()` — AI生成阅读路径：收集项目函数概要+调用关系，构造prompt让Claude选择相关函数并排序，解析AI返回JSON，验证qualified_name存在性，存入reading_paths表
- `get_reading_paths()` — 获取项目阅读路径列表，从function_items JSON解析函数数量
- `get_reading_path_detail()` — 获取阅读路径详情，通过qualified_name映射当前function_id（函数可能因重新扫描而变化）
- `delete_reading_path()` — 删除阅读路径
- `update_progress()` — 更新阅读进度（last_index）
