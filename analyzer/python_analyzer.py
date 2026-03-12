"""Python AST 分析器 - 提取函数定义、调用关系和 import 信息"""
import ast
from typing import Any

from analyzer.base import (
    BaseAnalyzer,
    CallInfo,
    FileAnalysisResult,
    FunctionInfo,
    ImportInfo,
)


class PythonAnalyzer(BaseAnalyzer):
    """基于 ast 模块的 Python 代码分析器"""

    def supported_extensions(self) -> list[str]:
        return [".py"]

    def analyze_file(
        self, file_path: str, content: str, rel_path: str
    ) -> FileAnalysisResult:
        """分析单个 Python 文件，提取函数定义、调用和 import 信息。"""
        lines: list[str] = content.splitlines()
        line_count: int = len(lines)

        try:
            tree: ast.Module = ast.parse(content, filename=file_path)
        except SyntaxError as e:
            print(f"Warning: SyntaxError in {file_path}: {e}")
            return FileAnalysisResult(
                rel_path=rel_path,
                language="python",
                content=content,
                line_count=line_count,
            )

        functions: list[FunctionInfo] = []
        calls: list[CallInfo] = []
        imports: list[ImportInfo] = _extract_imports(tree)

        # 递归遍历提取函数定义和调用
        _visit_node(tree, lines, rel_path, functions, calls, class_name=None)

        return FileAnalysisResult(
            rel_path=rel_path,
            language="python",
            content=content,
            line_count=line_count,
            functions=functions,
            calls=calls,
            imports=imports,
        )


def _visit_node(
    node: ast.AST,
    lines: list[str],
    rel_path: str,
    functions: list[FunctionInfo],
    calls: list[CallInfo],
    class_name: str | None,
) -> None:
    """递归遍历 AST 节点，提取函数定义和调用。"""
    for child in ast.iter_child_nodes(node):
        if isinstance(child, ast.ClassDef):
            # 遍历类体，标记其中的函数为方法
            _visit_node(child, lines, rel_path, functions, calls, class_name=child.name)
        elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            func_info: FunctionInfo = _extract_function(
                child, lines, rel_path, class_name
            )
            functions.append(func_info)
            # 提取此函数体内的调用
            _extract_calls(child, func_info.qualified_name, calls)
            # 递归处理嵌套函数（嵌套在函数内的函数不属于类方法）
            _visit_node(child, lines, rel_path, functions, calls, class_name=None)
        else:
            # 递归进入其他节点（if/for/try/with等），以发现其中的函数/类定义
            _visit_node(child, lines, rel_path, functions, calls, class_name=class_name)


def _extract_function(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    lines: list[str],
    rel_path: str,
    class_name: str | None,
) -> FunctionInfo:
    """从 AST 函数节点提取 FunctionInfo。"""
    name: str = node.name
    is_async: bool = isinstance(node, ast.AsyncFunctionDef)
    is_method: bool = class_name is not None

    qualified_name: str = f"{class_name}.{name}" if class_name else name
    signature: str = _build_signature(node, is_async)

    start_line: int = node.lineno  # 1-based
    end_line: int = node.end_lineno or node.lineno  # 1-based

    # 从 content 按行号切片获取函数体
    body: str = "\n".join(lines[start_line - 1 : end_line])

    # 装饰器列表
    decorators: list[str] = _extract_decorators(node)

    # docstring
    docstring: str | None = ast.get_docstring(node)

    return FunctionInfo(
        name=name,
        qualified_name=qualified_name,
        signature=signature,
        start_line=start_line,
        end_line=end_line,
        body=body,
        is_async=is_async,
        is_method=is_method,
        class_name=class_name,
        decorators=decorators,
        docstring=docstring,
        file_rel_path=rel_path,
    )


def _build_signature(
    node: ast.FunctionDef | ast.AsyncFunctionDef, is_async: bool
) -> str:
    """构建函数签名字符串，包含参数类型注解和返回类型。

    格式如: def foo(a: int, b: str) -> bool
            async def bar(self, data: list) -> None
    """
    prefix: str = "async def" if is_async else "def"
    args_str: str = _format_args(node.args)
    return_str: str = ""
    if node.returns is not None:
        return_str = f" -> {ast.unparse(node.returns)}"
    return f"{prefix} {node.name}({args_str}){return_str}"


def _format_args(args: ast.arguments) -> str:
    """格式化函数参数列表。"""
    parts: list[str] = []

    # 计算默认值的偏移：默认值从右侧对齐
    num_args: int = len(args.args)
    num_defaults: int = len(args.defaults)
    default_offset: int = num_args - num_defaults

    # 位置参数（含 positional-only）
    for i, arg in enumerate(args.args):
        part: str = arg.arg
        if arg.annotation is not None:
            part += f": {ast.unparse(arg.annotation)}"
        # 检查是否有默认值
        default_idx: int = i - default_offset
        if default_idx >= 0:
            part += f"={ast.unparse(args.defaults[default_idx])}"
        parts.append(part)

    # *args
    if args.vararg is not None:
        vararg_str: str = f"*{args.vararg.arg}"
        if args.vararg.annotation is not None:
            vararg_str += f": {ast.unparse(args.vararg.annotation)}"
        parts.append(vararg_str)
    elif args.kwonlyargs:
        # 有 keyword-only 参数但无 *args 时需要一个 *
        parts.append("*")

    # keyword-only 参数
    for i, arg in enumerate(args.kwonlyargs):
        part = arg.arg
        if arg.annotation is not None:
            part += f": {ast.unparse(arg.annotation)}"
        if i < len(args.kw_defaults) and args.kw_defaults[i] is not None:
            part += f"={ast.unparse(args.kw_defaults[i])}"
        parts.append(part)

    # **kwargs
    if args.kwarg is not None:
        kwarg_str: str = f"**{args.kwarg.arg}"
        if args.kwarg.annotation is not None:
            kwarg_str += f": {ast.unparse(args.kwarg.annotation)}"
        parts.append(kwarg_str)

    return ", ".join(parts)


def _extract_decorators(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
) -> list[str]:
    """提取装饰器名称列表。"""
    decorators: list[str] = []
    for decorator in node.decorator_list:
        decorators.append(ast.unparse(decorator))
    return decorators


def _extract_calls(
    func_node: ast.FunctionDef | ast.AsyncFunctionDef,
    caller_qualified_name: str,
    calls: list[CallInfo],
) -> None:
    """提取函数体内的所有调用（ast.Call 节点）。

    不递归进入嵌套函数定义（它们有自己的 caller_qualified_name）。
    """
    for node in _walk_skip_nested_functions(func_node):
        if isinstance(node, ast.Call):
            callee_name: str | None = _resolve_call_name(node.func)
            if callee_name is not None:
                calls.append(
                    CallInfo(
                        caller_qualified_name=caller_qualified_name,
                        callee_name=callee_name,
                        call_line=node.lineno,
                    )
                )


def _walk_skip_nested_functions(
    node: ast.AST,
) -> list[ast.AST]:
    """遍历 AST 节点，但跳过嵌套的函数/类定义体。"""
    result: list[ast.AST] = []
    _walk_impl(node, result, is_root=True)
    return result


def _walk_impl(node: ast.AST, result: list[ast.AST], is_root: bool) -> None:
    """递归遍历实现，跳过嵌套函数/类定义。"""
    if not is_root and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return
    result.append(node)
    for child in ast.iter_child_nodes(node):
        _walk_impl(child, result, is_root=False)


def _resolve_call_name(func_node: ast.expr) -> str | None:
    """从 ast.Call 的 func 属性解析被调用名称。

    - ast.Name: 直接调用，如 func()
    - ast.Attribute: 属性调用，如 obj.method(), self.method()
    """
    if isinstance(func_node, ast.Name):
        return func_node.id
    elif isinstance(func_node, ast.Attribute):
        # 递归解析链式调用的前缀
        prefix: str | None = _resolve_call_prefix(func_node.value)
        if prefix is not None:
            return f"{prefix}.{func_node.attr}"
        return func_node.attr
    return None


def _resolve_call_prefix(node: ast.expr) -> str | None:
    """递归解析调用前缀链。如 a.b.c 返回 'a.b'。"""
    if isinstance(node, ast.Name):
        return node.id
    elif isinstance(node, ast.Attribute):
        prefix: str | None = _resolve_call_prefix(node.value)
        if prefix is not None:
            return f"{prefix}.{node.attr}"
        return node.attr
    return None


def _extract_imports(tree: ast.Module) -> list[ImportInfo]:
    """提取文件中的所有 import 语句。"""
    imports: list[ImportInfo] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append(
                    ImportInfo(
                        module=alias.name,
                        name=alias.name,
                        alias=alias.asname if alias.asname else alias.name,
                    )
                )
        elif isinstance(node, ast.ImportFrom):
            module: str = node.module or ""
            for alias in node.names:
                imports.append(
                    ImportInfo(
                        module=module,
                        name=alias.name,
                        alias=alias.asname if alias.asname else alias.name,
                    )
                )
    return imports
