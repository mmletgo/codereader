# app/services/ - 业务逻辑层

## 服务模块
- `project_service.py` — 项目管理（创建项目记录、触发扫描、获取项目信息）
- `function_service.py` — 函数查询（分页、详情组装、调用关系查询）
- `note_service.py` — 备注CRUD操作
- `export_service.py` — 导出逻辑（组装函数+备注+调用关系为结构化输出）

## 职责划分
服务层封装业务逻辑和数据库查询，路由层只负责参数校验和响应序列化。
服务函数接收 `sqlite3.Connection` 作为第一个参数。
