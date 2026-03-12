# analyzer/ - Python 代码分析引擎

## 文件说明
- `base.py` — 数据类型定义（FunctionInfo, CallInfo, ImportInfo, FileAnalysisResult）和 BaseAnalyzer 抽象基类
- `scanner.py` — 目录递归扫描器，支持include/exclude模式过滤，返回待分析文件列表
- `python_analyzer.py` — Python AST分析器，解析函数定义（签名、行号、装饰器、docstring、类归属）和函数体内调用
- `call_resolver.py` — 调用关系跨文件解析器，将调用名称匹配到具体函数定义（多级匹配策略）
- `engine.py` — 分析引擎入口，协调 scanner→analyzer→resolver 流程，将结果写入SQLite，计算sort_order

## 分析流程
1. `scanner.scan_directory()` 递归扫描，收集所有.py文件路径
2. `PythonAnalyzer.analyze_file()` 逐文件AST解析，提取函数和调用信息
3. `CallResolver.resolve()` 两阶段解析：建立全局函数索引→匹配调用关系
4. `engine.analyze_project()` 协调以上流程，写入数据库，计算调用关系排序的sort_order

## 调用关系排序算法（sort_order）
1. 构建调用图，找到入口函数（项目内无调用者的函数）
2. 从入口函数DFS遍历，按遍历顺序赋予递增sort_order
3. 未被遍历到的函数按文件路径+行号排序追加

## Python AST 分析要点
- 使用 ast.parse() 解析文件
- ast.FunctionDef / ast.AsyncFunctionDef 提取函数
- ast.ClassDef 内嵌套的函数标记为方法（is_method=True, class_name=类名）
- ast.Call 节点提取调用：Name(直接调用), Attribute(obj.method调用)
- ast.Import / ast.ImportFrom 提取import信息用于调用解析

## 调用解析策略（CallResolver）
优先级从高到低：
1. 精确匹配 qualified_name
2. self/cls 方法 → 同类方法匹配
3. 同文件函数匹配
4. 通过import信息匹配
5. 项目内同名函数匹配
6. 无法匹配 → callee_id=NULL，只记录 callee_name
