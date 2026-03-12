# static/ - 前端静态文件

## 文件结构
- `index.html` — SPA入口，引入所有CSS/JS，定义页面骨架
- `css/main.css` — 主样式（移动端响应式，flex布局，触控优化）
- `css/code.css` — 代码区域样式（行号、高亮主题适配）
- `css/graph.css` — 调用关系图样式
- `js/app.js` — 应用入口，hash路由管理（#/ #/project/{id}/browse 等）
- `js/api.js` — API请求封装（fetch wrapper）
- `js/browse.js` — 核心：函数浏览器（左右按钮切换函数、代码高亮渲染）
- `js/graph.js` — D3.js调用关系横向树状图
- `js/notes.js` — 备注面板（可折叠、增删改、类型选择）
- `js/list.js` — 函数列表页（搜索、筛选、按文件分组）
- `js/export.js` — 导出页面（格式选择、预览、下载）
- `lib/` — 第三方库本地文件（highlight.min.js, d3.min.js等）

## 前端架构
纯HTML/CSS/JS单页应用，hash路由，无构建步骤。
页面视图通过JS动态切换DOM显示/隐藏。

## 移动端交互设计
- 函数浏览：底部导航栏左右箭头按钮切换函数，上下滚动查看代码
- 函数默认按调用关系排序（后端sort_order字段）
- 代码区域：highlight.js语法高亮，带行号
- 备注面板：页面底部，可折叠展开
- 调用关系图：D3.js横向树（左到右），支持双指缩放和拖拽，节点可点击跳转

## API接口（后端提供）
- GET /api/v1/projects/ — 项目列表
- POST /api/v1/projects/ — 创建项目（body: {root_path, name?})
- DELETE /api/v1/projects/{id} — 删除项目
- POST /api/v1/projects/{id}/rescan — 重新扫描
- GET /api/v1/functions/?project_id=X&page=1&per_page=50 — 函数分页列表
- GET /api/v1/functions/{id} — 函数详情（含代码、调用关系、备注）
- GET /api/v1/call_graph/?project_id=X — 调用关系图数据(nodes+links)
- POST /api/v1/notes/ — 添加备注(body: {function_id, project_id, content, note_type})
- PUT /api/v1/notes/{id} — 更新备注
- DELETE /api/v1/notes/{id} — 删除备注
- GET /api/v1/export/?project_id=X&format=json|markdown — 导出
