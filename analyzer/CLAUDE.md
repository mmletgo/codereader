# analyzer/ - 多语言代码分析引擎

## 文件说明
- `base.py` — 数据类型定义（FunctionInfo, CallInfo, ImportInfo, FileAnalysisResult）和 BaseAnalyzer 抽象基类
- `scanner.py` — 目录递归扫描器，支持include/exclude模式过滤，返回待分析文件列表
- `python_analyzer.py` — Python AST分析器，解析函数定义（签名、行号、装饰器、docstring、类归属）和函数体内调用
- `js_analyzer.py` — JS/TS tree-sitter分析器，解析函数声明、箭头函数、类方法、生成器、export default，提取ES6 import/CommonJS require，JSDoc docstring
- `call_resolver.py` — 调用关系跨文件解析器，将调用名称匹配到具体函数定义（多级匹配策略），支持Python点分路径和JS相对路径模块解析
- `engine.py` — 分析引擎入口，协调 scanner→analyzer→resolver 流程，按扩展名分派分析器，将结果写入SQLite，计算sort_order

## 公开接口

### scanner.py
- `scan_directory(root_path: str, include: list[str], exclude: list[str]) -> list[tuple[str, str]]`
  - 递归扫描目录，返回 `(绝对路径, 相对路径)` 元组列表
  - 合并 config.DEFAULT_EXCLUDE 和参数中的 exclude
  - 自动跳过隐藏目录（以 `.` 开头）和匹配排除模式的目录/文件
  - 使用 fnmatch 进行 glob 模式匹配
  - 结果按相对路径排序（通过 os.walk 内部排序）

### python_analyzer.py
- `PythonAnalyzer` 类，继承 `BaseAnalyzer`
  - `analyze_file(file_path, content, rel_path) -> FileAnalysisResult`
  - `supported_extensions() -> [".py"]`
- 使用递归 `_visit_node` 遍历 AST，处理嵌套类和嵌套函数
- 签名格式: `[async] def name(args) [-> return_type]`，包含类型注解和默认值
- 函数体通过行号从 content 切片获取（start_line 到 end_line）
- 调用提取使用 `_walk_skip_nested_functions` 避免将嵌套函数体内的调用归属到外层函数
- 支持链式属性调用名解析（如 `a.b.c()` 解析为 `a.b.c`）
- SyntaxError 时打印警告并返回空结果

### call_resolver.py
- `CallResolver` 类
  - `__init__(functions: list[FunctionInfo])` — 构建三级索引
  - `resolve(calls, file_imports) -> list[tuple[CallInfo, str | None]]`
- 三级索引:
  - `qualified_name_map`: `{file_rel_path::qualified_name -> FunctionInfo}` 精确定位
  - `name_map`: `{函数名/qualified_name -> [FunctionInfo列表]}` 全局搜索
  - `file_func_map`: `{文件相对路径 -> [FunctionInfo列表]}` 文件级搜索
- 解析优先级: self/cls/this方法 → 同文件直接调用 → import解析 → 全局同名 → 属性调用qualified_name匹配 → import模块解析 → 全局属性名
- 模块路径转文件路径:
  - Python: `a.b.c` -> `["a/b/c.py", "a/b/c/__init__.py"]`
  - JS/TS: `./utils` -> `["./utils.js", "./utils.tsx", ..., "./utils/index.js", ...]`（相对caller文件目录解析）

### js_analyzer.py
- `JsAnalyzer` 类，继承 `BaseAnalyzer`
  - `analyze_file(file_path, content, rel_path) -> FileAnalysisResult`
  - `supported_extensions() -> [".js", ".jsx", ".mjs", ".ts", ".tsx"]`
- 基于 tree-sitter 解析（tree-sitter-javascript / tree-sitter-typescript）
- 按扩展名选择语言: `.js/.mjs/.jsx` → JS语言, `.ts` → TS语言, `.tsx` → TSX语言
- language字段: `.js/.jsx/.mjs` → "javascript", `.ts/.tsx` → "typescript"
- 支持函数形式: function_declaration, generator_function_declaration, arrow_function, function_expression, class method_definition, export default
- 递归 `_visit_node` 遍历 CST，跳过 interface/type/enum 声明
- 调用提取使用 `_walk_skip_nested_scopes` 避免嵌套函数体调用归属错误
- Import 提取: ES6 `import` 语句 + CommonJS `require()` 调用
- JSDoc: 匹配 `/** */` 格式注释，提取第一行非 `@` 描述

### engine.py
- `analyze_project(root_path, project_name?, include?, exclude?) -> int (project_id)`
  - 完整流程: scan → 按扩展名分派分析器 → resolve → 写入DB → compute_sort_order → 更新统计
  - 多语言分析器注册: `_ext_map` 字典映射扩展名到对应 BaseAnalyzer 实例
  - `_detect_language(results)`: 根据实际文件语言统计推断项目语言（python/javascript/mixed）
  - decorators 以 JSON 字符串存储
  - 使用 `file_rel_path::qualified_name` 和全局 `qualified_name` 双层映射查找 function_id
- `compute_sort_order(conn, project_id) -> None`
  - 入口函数 = 项目内无被调用者的函数（不在任何 callee_id 中出现）
  - DFS 从入口函数开始，按遍历顺序赋递增 sort_order（从1开始）
  - 未遍历到的函数按 file.rel_path + function.start_line 排序追加

## 分析流程
1. `scanner.scan_directory()` 递归扫描，收集所有匹配include模式的文件路径
2. 按文件扩展名分派到对应分析器（PythonAnalyzer / JsAnalyzer），逐文件解析提取函数、调用和import信息
3. `CallResolver.resolve()` 两阶段解析：建立全局函数索引→匹配调用关系（跨语言跨文件）
4. `engine.analyze_project()` 协调以上流程，写入数据库，计算sort_order，更新项目统计

## 数据库写入
- `projects` 表: name, root_path, language, file_count, func_count
- `files` 表: project_id, rel_path, language, content, line_count
- `functions` 表: file_id, project_id, name, qualified_name, signature, start_line, end_line, body, is_async, is_method, class_name, decorators(JSON), docstring, sort_order
- `call_relations` 表: caller_id, callee_id(可NULL), callee_name, call_line, project_id
