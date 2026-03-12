# static/ - 前端静态文件

## 文件结构
- `index.html` — SPA入口，引入所有CSS/JS，定义5个section视图容器和新建项目对话框
- `css/main.css` — 主样式（暗色主题变量、flex布局、触控44px最小高度、响应式组件）
- `css/code.css` — 代码区域样式（行号用data-line属性+::before伪元素、highlight.js主题覆盖、行级调用按钮和展开区样式、骨架屏shimmer动画）
- `css/graph.css` — D3调用关系图节点/连线/缩放样式
- `js/app.js` — 应用入口，hash路由管理（5条路由规则），项目列表页渲染和创建/删除逻辑
- `js/api.js` — API请求封装（统一fetch wrapper，自动分页加载getAllFunctions，markRead标记已读）
- `js/browse.js` — 核心：函数浏览器（函数列表缓存、左右切换、代码高亮渲染、筛选有备注函数、筛选未读函数、函数已读状态管理、键盘左右箭头快捷键、行级调用函数按钮与展开面板、骨架屏加载占位、requestIdleCallback预加载）
- `js/graph.js` — D3.js横向树状图（buildTree处理循环引用和多根节点、d3.zoom缩放平移、节点点击跳转）
- `js/ai.js` — AI辅助分析模块（函数解读面板展开/折叠、行级代码解释、AI自动备注生成、简单Markdown渲染、前端缓存+防重复请求）
- `js/notes.js` — 备注面板（可折叠、增删、类型badge颜色、同步更新Browse缓存、AI备注显示AI标识）
- `js/list.js` — 函数列表页（按文件分组、搜索debounce 300ms、点击跳转浏览器）
- `js/export.js` — 导出页面（JSON/Markdown格式切换、预览缓存、Blob下载）
- `lib/` — 第三方库本地文件（highlight.min.js, highlight-python.min.js, d3.min.js, github-dark.min.css）

## 前端架构
纯HTML/CSS/JS单页应用，hash路由，无构建步骤。
- 5个视图section通过display:flex/none切换，App.route()根据location.hash分发
- 全局对象：API、Browse、Notes、AI、Graph、List、Export、App
- 模块间通信：Notes直接访问Browse.currentDetail和Browse.cache更新备注数据

## 5个视图路由
- `#/` — 项目列表页（view-projects），卡片式布局，新建/删除项目
- `#/project/{id}/browse?func={funcId}` — 函数浏览器（view-browse），支持func参数直接跳转
- `#/project/{id}/graph` — 调用关系图（view-graph），D3横向树
- `#/project/{id}/list` — 函数列表（view-list），搜索+按文件分组
- `#/project/{id}/export` — 导出（view-export），JSON/Markdown预览+下载

## 移动端交互设计
- 函数浏览：底部导航栏左右箭头按钮切换函数，上下滚动查看代码
- 函数默认按调用关系排序（后端sort_order字段），进入时一次性加载全部函数基本信息
- 性能优化：init()三个API并行加载、_enhanceHighlight单次遍历HTML、骨架屏占位、requestIdleCallback调度预加载、_buildCodeHtml去重复用
- 代码区域：highlight.js语法高亮，每行用`<span class="line" data-line="N">`包裹实现行号
- 备注面板：页面底部，点击"备注(N)"切换展开/折叠，展开时代码区自动缩小
- 调用关系图：D3.js横向树（左到右），支持双指缩放和拖拽，节点颜色区分状态（当前函数蓝色高亮、已读绿色、未读灰色、有备注红色边框），节点可点击跳转

## 暗色主题变量
- --bg-primary: #0d1117, --bg-secondary: #161b22, --bg-tertiary: #21262d
- --text-primary: #e6edf3, --text-secondary: #8b949e
- --accent: #58a6ff, --accent-danger: #f85149, --accent-success: #3fb950
- --border: #30363d

## API接口（后端提供）
- GET /api/v1/projects/ — 项目列表
- POST /api/v1/projects/ — 创建项目（body: {root_path, name?})
- DELETE /api/v1/projects/{id} — 删除项目
- POST /api/v1/projects/{id}/rescan — 重新扫描
- GET /api/v1/functions/?project_id=X&page=1&per_page=50 — 函数分页列表
- GET /api/v1/functions/{id} — 函数详情（含代码body、调用关系callers/callees、备注notes）
- GET /api/v1/call_graph/?project_id=X — 调用关系图数据(nodes+links)
- POST /api/v1/notes/ — 添加备注(body: {function_id, project_id, content, note_type})
- PUT /api/v1/notes/{id} — 更新备注
- DELETE /api/v1/notes/{id} — 删除备注
- GET /api/v1/export/?project_id=X&format=json|markdown — 导出
- PUT /api/v1/functions/{id}/read — 标记函数已读
- GET /api/v1/ai/explanation?function_id=X — 获取函数AI解读（带缓存）
- POST /api/v1/ai/line-explain — 行级代码解释(body: {function_id, line_number, line_content})
- POST /api/v1/ai/auto-notes — 生成AI自动备注(body: {function_id, project_id})
- GET /api/v1/progress/?project_id=X — 获取阅读进度（返回last_function_id）
- PUT /api/v1/progress/?project_id=X — 保存阅读进度（body: {last_function_id?}）
