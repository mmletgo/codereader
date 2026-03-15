"""JavaScript/TypeScript 代码分析器 - 基于 tree-sitter 提取函数定义、调用关系和 import 信息"""
from __future__ import annotations

import os
import re
import warnings

import tree_sitter_javascript as tsjs
import tree_sitter_typescript as tsts
from tree_sitter import Language, Node, Parser

from analyzer.base import (
    BaseAnalyzer,
    CallInfo,
    FileAnalysisResult,
    FunctionInfo,
    ImportInfo,
)

# ---------------------------------------------------------------------------
# Language singletons
# ---------------------------------------------------------------------------
_JS_LANG: Language = Language(tsjs.language())
_TS_LANG: Language = Language(tsts.language_typescript())
_TSX_LANG: Language = Language(tsts.language_tsx())

# ---------------------------------------------------------------------------
# Extension -> language mapping
# ---------------------------------------------------------------------------
_EXT_TO_LANGUAGE: dict[str, Language] = {
    ".js": _JS_LANG,
    ".mjs": _JS_LANG,
    ".jsx": _JS_LANG,
    ".ts": _TS_LANG,
    ".tsx": _TSX_LANG,
}

_EXT_TO_LANG_STR: dict[str, str] = {
    ".js": "javascript",
    ".mjs": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
}

# ---------------------------------------------------------------------------
# Node types that represent "function-like" constructs inside variable
# declarations (arrow_function, function_expression, generator_function)
# ---------------------------------------------------------------------------
_VAR_FUNC_TYPES: frozenset[str] = frozenset({
    "arrow_function",
    "function_expression",
    "generator_function",
})

# Node types that indicate a nested scope boundary – we skip these when
# collecting call_expression nodes to avoid attributing inner calls to the
# outer function.
_NESTED_SCOPE_TYPES: frozenset[str] = frozenset({
    "function_declaration",
    "generator_function_declaration",
    "arrow_function",
    "function_expression",
    "generator_function",
    "class_declaration",
    "class",
})

# TS-only node types to skip entirely
_TS_SKIP_TYPES: frozenset[str] = frozenset({
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
})

# JSDoc pattern: /** ... */
_JSDOC_RE: re.Pattern[str] = re.compile(r"^/\*\*")


class JsAnalyzer(BaseAnalyzer):
    """基于 tree-sitter 的 JavaScript/TypeScript 代码分析器"""

    def supported_extensions(self) -> list[str]:
        return [".js", ".jsx", ".mjs", ".ts", ".tsx"]

    def analyze_file(
        self, file_path: str, content: str, rel_path: str
    ) -> FileAnalysisResult:
        """分析单个 JS/TS 文件，提取函数定义、调用和 import 信息。"""
        lines: list[str] = content.splitlines()
        line_count: int = len(lines)

        ext: str = os.path.splitext(file_path)[1].lower()
        language: Language | None = _EXT_TO_LANGUAGE.get(ext)
        lang_str: str = _EXT_TO_LANG_STR.get(ext, "javascript")

        if language is None:
            warnings.warn(f"Unsupported extension {ext} for {file_path}")
            return FileAnalysisResult(
                rel_path=rel_path,
                language=lang_str,
                content=content,
                line_count=line_count,
            )

        parser: Parser = Parser(language)
        content_bytes: bytes = content.encode("utf-8")

        try:
            tree = parser.parse(content_bytes)
        except Exception as e:
            print(f"Warning: parse error in {file_path}: {e}")
            return FileAnalysisResult(
                rel_path=rel_path,
                language=lang_str,
                content=content,
                line_count=line_count,
            )

        functions: list[FunctionInfo] = []
        calls: list[CallInfo] = []
        imports: list[ImportInfo] = []

        # 提取 imports
        _extract_imports(tree.root_node, imports)

        # 递归遍历提取函数定义和调用
        _visit_node(tree.root_node, lines, rel_path, functions, calls)

        return FileAnalysisResult(
            rel_path=rel_path,
            language=lang_str,
            content=content,
            line_count=line_count,
            functions=functions,
            calls=calls,
            imports=imports,
        )


# ===========================================================================
# Node visitor – recursive extraction of functions and calls
# ===========================================================================


def _visit_node(
    node: Node,
    lines: list[str],
    rel_path: str,
    functions: list[FunctionInfo],
    calls: list[CallInfo],
    class_name: str | None = None,
) -> None:
    """递归遍历 tree-sitter 节点，提取函数定义和调用。"""
    for child in node.children:
        node_type: str = child.type

        # Skip TS-only type constructs
        if node_type in _TS_SKIP_TYPES:
            continue

        # --- export_statement: unwrap and process inner declaration ----------
        if node_type == "export_statement":
            _handle_export_statement(child, lines, rel_path, functions, calls, class_name)
            continue

        # --- function_declaration / generator_function_declaration -----------
        if node_type in ("function_declaration", "generator_function_declaration"):
            _handle_function_declaration(child, lines, rel_path, functions, calls, class_name)
            continue

        # --- class_declaration -----------------------------------------------
        if node_type == "class_declaration":
            _handle_class_declaration(child, lines, rel_path, functions, calls)
            continue

        # --- lexical_declaration / variable_declaration (const/let/var) ------
        if node_type in ("lexical_declaration", "variable_declaration"):
            _handle_variable_declaration(child, lines, rel_path, functions, calls, class_name)
            continue

        # --- Recurse into other structural nodes (if/for/try/with etc.) -----
        _visit_node(child, lines, rel_path, functions, calls, class_name=class_name)


def _handle_export_statement(
    node: Node,
    lines: list[str],
    rel_path: str,
    functions: list[FunctionInfo],
    calls: list[CallInfo],
    class_name: str | None,
) -> None:
    """处理 export 语句，提取其中的函数/类声明。"""
    is_default: bool = any(c.type == "default" for c in node.children)

    for child in node.children:
        child_type: str = child.type

        if child_type in ("function_declaration", "generator_function_declaration"):
            _handle_function_declaration(child, lines, rel_path, functions, calls, class_name)
            return

        # export default function() {} — anonymous, parsed as function_expression
        if child_type == "function_expression" and is_default:
            _handle_anonymous_default_function(
                child, node, lines, rel_path, functions, calls
            )
            return

        if child_type == "class_declaration":
            _handle_class_declaration(child, lines, rel_path, functions, calls)
            return

        # export default class { ... } — anonymous class, node type is "class"
        if child_type == "class" and is_default:
            _handle_class_node(child, lines, rel_path, functions, calls, class_name_override=None)
            return

        if child_type in ("lexical_declaration", "variable_declaration"):
            _handle_variable_declaration(child, lines, rel_path, functions, calls, class_name)
            return

    # If nothing matched inside, still recurse to catch nested structures
    _visit_node(node, lines, rel_path, functions, calls, class_name=class_name)


def _handle_function_declaration(
    node: Node,
    lines: list[str],
    rel_path: str,
    functions: list[FunctionInfo],
    calls: list[CallInfo],
    class_name: str | None,
) -> None:
    """处理 function_declaration / generator_function_declaration。"""
    name_node: Node | None = node.child_by_field_name("name")
    name: str = name_node.text.decode("utf-8") if name_node else "default"

    func_info: FunctionInfo = _build_function_info(
        func_node=node,
        name=name,
        lines=lines,
        rel_path=rel_path,
        class_name=class_name,
    )
    functions.append(func_info)

    # Extract calls inside the function body
    _extract_calls(node, func_info.qualified_name, calls)

    # Recurse into the function body to find nested function/class definitions
    # (nested functions are not class methods)
    _visit_node(node, lines, rel_path, functions, calls, class_name=None)


def _handle_anonymous_default_function(
    func_node: Node,
    export_node: Node,
    lines: list[str],
    rel_path: str,
    functions: list[FunctionInfo],
    calls: list[CallInfo],
) -> None:
    """处理 export default function() {} 匿名默认导出函数。"""
    # Use the export_statement node for range so the `export default` part is included
    func_info: FunctionInfo = _build_function_info(
        func_node=func_node,
        name="default",
        lines=lines,
        rel_path=rel_path,
        class_name=None,
        range_node=export_node,
    )
    functions.append(func_info)
    _extract_calls(func_node, func_info.qualified_name, calls)

    # Recurse into body to find nested definitions
    _visit_node(func_node, lines, rel_path, functions, calls, class_name=None)


def _handle_class_declaration(
    node: Node,
    lines: list[str],
    rel_path: str,
    functions: list[FunctionInfo],
    calls: list[CallInfo],
) -> None:
    """处理 class_declaration，提取其中的方法。"""
    name_node: Node | None = node.child_by_field_name("name")
    cls_name: str = name_node.text.decode("utf-8") if name_node else "AnonymousClass"
    _handle_class_node(node, lines, rel_path, functions, calls, class_name_override=cls_name)


def _handle_class_node(
    node: Node,
    lines: list[str],
    rel_path: str,
    functions: list[FunctionInfo],
    calls: list[CallInfo],
    class_name_override: str | None,
) -> None:
    """处理 class 节点体中的方法定义。"""
    cls_name: str = class_name_override or "AnonymousClass"

    # Find class_body child
    body_node: Node | None = None
    for child in node.children:
        if child.type == "class_body":
            body_node = child
            break

    if body_node is None:
        return

    for member in body_node.children:
        if member.type == "method_definition":
            _handle_method_definition(member, lines, rel_path, functions, calls, cls_name)


def _handle_method_definition(
    node: Node,
    lines: list[str],
    rel_path: str,
    functions: list[FunctionInfo],
    calls: list[CallInfo],
    class_name: str,
) -> None:
    """处理 method_definition（类方法、getter、setter）。"""
    name_node: Node | None = node.child_by_field_name("name")
    name: str = name_node.text.decode("utf-8") if name_node else "anonymous"

    # Decorators
    decorators: list[str] = _extract_decorators(node)

    func_info: FunctionInfo = _build_function_info(
        func_node=node,
        name=name,
        lines=lines,
        rel_path=rel_path,
        class_name=class_name,
        decorators=decorators,
    )
    functions.append(func_info)
    _extract_calls(node, func_info.qualified_name, calls)

    # Recurse into method body to find nested definitions
    _visit_node(node, lines, rel_path, functions, calls, class_name=None)


def _handle_variable_declaration(
    node: Node,
    lines: list[str],
    rel_path: str,
    functions: list[FunctionInfo],
    calls: list[CallInfo],
    class_name: str | None,
) -> None:
    """处理 lexical_declaration / variable_declaration 中的函数赋值。

    如 const foo = () => {} / const bar = function() {} / const gen = function*() {}
    """
    for child in node.children:
        if child.type != "variable_declarator":
            continue

        name_node: Node | None = child.child_by_field_name("name")
        value_node: Node | None = child.child_by_field_name("value")

        if name_node is None or value_node is None:
            continue

        if value_node.type not in _VAR_FUNC_TYPES:
            continue

        var_name: str = name_node.text.decode("utf-8")

        # Use the full variable declaration (including const/let/var) for range
        func_info: FunctionInfo = _build_function_info(
            func_node=value_node,
            name=var_name,
            lines=lines,
            rel_path=rel_path,
            class_name=class_name,
            range_node=node,
        )
        functions.append(func_info)
        _extract_calls(value_node, func_info.qualified_name, calls)

        # Recurse into the function body to find nested definitions
        _visit_node(value_node, lines, rel_path, functions, calls, class_name=None)


# ===========================================================================
# Build FunctionInfo
# ===========================================================================


def _build_function_info(
    func_node: Node,
    name: str,
    lines: list[str],
    rel_path: str,
    class_name: str | None,
    range_node: Node | None = None,
    decorators: list[str] | None = None,
) -> FunctionInfo:
    """从 tree-sitter 节点构造 FunctionInfo。

    Args:
        func_node: 函数/箭头函数/方法节点（用于签名和 async 检测）
        name: 函数名
        lines: 源文件按行分割后的列表
        rel_path: 文件相对路径
        class_name: 所属类名（方法时非 None）
        range_node: 可选的范围覆盖节点（用于 variable_declaration 包裹的函数）
        decorators: 预先提取的装饰器列表
    """
    # The node whose range we use for start_line/end_line/body
    span_node: Node = range_node if range_node is not None else func_node

    is_async: bool = _is_async(func_node)
    is_method: bool = class_name is not None
    qualified_name: str = f"{class_name}.{name}" if class_name else name

    # Line numbers (1-based)
    start_line: int = span_node.start_point[0] + 1
    end_line: int = span_node.end_point[0] + 1

    # Body: slice from source lines
    body: str = "\n".join(lines[start_line - 1 : end_line])

    # Signature: text from func_node start up to the opening '{'
    signature: str = _build_signature(func_node, name, is_async)

    # Docstring: look for preceding JSDoc comment
    docstring: str | None = _extract_jsdoc(func_node if range_node is None else range_node)

    if decorators is None:
        decorators = _extract_decorators(func_node)

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


# ===========================================================================
# Signature construction
# ===========================================================================


def _build_signature(func_node: Node, name: str, is_async: bool) -> str:
    """构建函数签名字符串。

    从节点源码中截取: 从函数节点开始到函数体 '{' 之前的文本。
    保持原始格式。
    """
    # Find the statement_block child (function body)
    body_node: Node | None = _find_child_by_type(func_node, "statement_block")

    if body_node is not None:
        # Signature = text from func_node start up to body start
        sig_bytes: bytes = func_node.text[: body_node.start_byte - func_node.start_byte]
        sig: str = sig_bytes.decode("utf-8").strip()
        return sig

    # For arrow functions with expression body (no statement_block):
    # e.g., const add = (a, b) => a + b
    # Use the text up to and including '=>'
    text: str = func_node.text.decode("utf-8")
    arrow_idx: int = text.find("=>")
    if arrow_idx >= 0:
        return text[: arrow_idx + 2].strip()

    # Fallback: return the first line
    first_line: str = text.split("\n")[0].strip()
    return first_line


# ===========================================================================
# Async detection
# ===========================================================================


def _is_async(node: Node) -> bool:
    """检测函数/方法是否为 async。"""
    for child in node.children:
        if child.type == "async":
            return True
    return False


# ===========================================================================
# Decorator extraction
# ===========================================================================


def _extract_decorators(node: Node) -> list[str]:
    """提取方法节点上的装饰器列表。"""
    decorators: list[str] = []
    for child in node.children:
        if child.type == "decorator":
            # Get the decorator text without the leading '@'
            dec_text: str = child.text.decode("utf-8")
            if dec_text.startswith("@"):
                dec_text = dec_text[1:]
            decorators.append(dec_text)
    return decorators


# ===========================================================================
# JSDoc extraction
# ===========================================================================


def _extract_jsdoc(node: Node) -> str | None:
    """从函数节点的前一个兄弟节点提取 JSDoc 注释。

    匹配 /** ... */ 格式，提取第一行非 @tag 的描述作为 docstring。
    """
    sib: Node | None = node.prev_named_sibling
    if sib is None or sib.type != "comment":
        return None

    text: str = sib.text.decode("utf-8")

    # Must be a JSDoc comment (starts with /**)
    if not _JSDOC_RE.match(text):
        return None

    # Strip the /** and */ delimiters
    inner: str = text[3:]  # remove /**
    if inner.endswith("*/"):
        inner = inner[:-2]

    # Extract first non-tag description line
    desc_lines: list[str] = []
    for raw_line in inner.split("\n"):
        line: str = raw_line.strip()
        # Remove leading * common in JSDoc
        if line.startswith("*"):
            line = line[1:].strip()
        if not line:
            continue
        # Stop at @-tags
        if line.startswith("@"):
            break
        desc_lines.append(line)

    if desc_lines:
        return " ".join(desc_lines)
    return None


# ===========================================================================
# Call extraction
# ===========================================================================


def _extract_calls(
    func_node: Node,
    caller_qualified_name: str,
    calls: list[CallInfo],
) -> None:
    """提取函数体内的所有调用（call_expression 节点）。

    跳过嵌套的函数/类定义体，避免将内部调用归属到外层函数。
    """
    for descendant in _walk_skip_nested_scopes(func_node):
        if descendant.type == "call_expression":
            callee_name: str | None = _resolve_callee_name(descendant)
            if callee_name is not None:
                call_line: int = descendant.start_point[0] + 1  # 1-based
                calls.append(
                    CallInfo(
                        caller_qualified_name=caller_qualified_name,
                        callee_name=callee_name,
                        call_line=call_line,
                    )
                )


def _walk_skip_nested_scopes(node: Node) -> list[Node]:
    """遍历节点树，但跳过嵌套函数/类定义体。"""
    result: list[Node] = []
    _walk_impl(node, result, is_root=True)
    return result


def _walk_impl(node: Node, result: list[Node], is_root: bool) -> None:
    """递归遍历实现，跳过嵌套函数/类。"""
    if not is_root and node.type in _NESTED_SCOPE_TYPES:
        return
    result.append(node)
    for child in node.children:
        _walk_impl(child, result, is_root=False)


def _resolve_callee_name(call_node: Node) -> str | None:
    """从 call_expression 解析被调用的名称。

    - identifier: 直接调用，如 foo()
    - member_expression: 属性调用，如 obj.method()
    - 其他: 忽略（如 IIFE、函数表达式调用等）
    """
    func_child: Node | None = call_node.child_by_field_name("function")
    if func_child is None:
        return None

    if func_child.type == "identifier":
        return func_child.text.decode("utf-8")

    if func_child.type == "member_expression":
        return _resolve_member_expression(func_child)

    return None


def _resolve_member_expression(node: Node) -> str | None:
    """递归解析 member_expression 为 dotted 名称。

    如 a.b.c -> "a.b.c"
    """
    object_node: Node | None = node.child_by_field_name("object")
    property_node: Node | None = node.child_by_field_name("property")

    if property_node is None:
        return None

    prop_name: str = property_node.text.decode("utf-8")

    if object_node is None:
        return prop_name

    if object_node.type == "identifier":
        return f"{object_node.text.decode('utf-8')}.{prop_name}"

    if object_node.type == "member_expression":
        prefix: str | None = _resolve_member_expression(object_node)
        if prefix is not None:
            return f"{prefix}.{prop_name}"
        return prop_name

    # For this/super
    if object_node.type in ("this", "super"):
        return f"{object_node.type}.{prop_name}"

    return prop_name


# ===========================================================================
# Import extraction
# ===========================================================================


def _extract_imports(root: Node, imports: list[ImportInfo]) -> None:
    """提取文件中的所有 import 语句和 require 调用。"""
    for child in root.children:
        if child.type == "import_statement":
            _extract_es6_import(child, imports)
        elif child.type in ("lexical_declaration", "variable_declaration"):
            _extract_require_import(child, imports)


def _extract_es6_import(node: Node, imports: list[ImportInfo]) -> None:
    """提取 ES6 import 语句。

    处理:
    - import { a, b as c } from 'module'
    - import defaultExport from 'module'
    - import * as ns from 'module'
    """
    # Get module source
    source_node: Node | None = node.child_by_field_name("source")
    if source_node is None:
        return
    module: str = _extract_string_value(source_node)

    # Find the import_clause
    import_clause: Node | None = None
    for child in node.children:
        if child.type == "import_clause":
            import_clause = child
            break

    if import_clause is None:
        return

    for clause_child in import_clause.children:
        clause_type: str = clause_child.type

        # Default import: import foo from 'module'
        if clause_type == "identifier":
            alias: str = clause_child.text.decode("utf-8")
            imports.append(ImportInfo(module=module, name="default", alias=alias))

        # Named imports: import { a, b as c } from 'module'
        elif clause_type == "named_imports":
            for spec in clause_child.children:
                if spec.type == "import_specifier":
                    name_n: Node | None = spec.child_by_field_name("name")
                    alias_n: Node | None = spec.child_by_field_name("alias")
                    if name_n is not None:
                        imp_name: str = name_n.text.decode("utf-8")
                        imp_alias: str = alias_n.text.decode("utf-8") if alias_n else imp_name
                        imports.append(ImportInfo(module=module, name=imp_name, alias=imp_alias))

        # Namespace import: import * as ns from 'module'
        elif clause_type == "namespace_import":
            ns_ident: Node | None = None
            for ns_child in clause_child.children:
                if ns_child.type == "identifier":
                    ns_ident = ns_child
                    break
            if ns_ident is not None:
                ns_alias: str = ns_ident.text.decode("utf-8")
                imports.append(ImportInfo(module=module, name="*", alias=ns_alias))


def _extract_require_import(node: Node, imports: list[ImportInfo]) -> None:
    """提取 CommonJS require 调用。

    处理: const foo = require('module')
    """
    for child in node.children:
        if child.type != "variable_declarator":
            continue

        name_node: Node | None = child.child_by_field_name("name")
        value_node: Node | None = child.child_by_field_name("value")

        if name_node is None or value_node is None:
            continue
        if value_node.type != "call_expression":
            continue

        # Check if the called function is 'require'
        func_child: Node | None = value_node.child_by_field_name("function")
        if func_child is None or func_child.type != "identifier":
            continue
        if func_child.text.decode("utf-8") != "require":
            continue

        # Get the first argument (module path)
        args_node: Node | None = value_node.child_by_field_name("arguments")
        if args_node is None:
            continue

        # Find first string argument
        for arg_child in args_node.children:
            if arg_child.type == "string":
                module_path: str = _extract_string_value(arg_child)
                var_name: str = name_node.text.decode("utf-8")
                imports.append(ImportInfo(module=module_path, name="default", alias=var_name))
                break


# ===========================================================================
# Utilities
# ===========================================================================


def _extract_string_value(string_node: Node) -> str:
    """从 tree-sitter string 节点提取纯字符串值（去掉引号）。"""
    for child in string_node.children:
        if child.type == "string_fragment":
            return child.text.decode("utf-8")
    # Fallback: strip outer quotes manually
    raw: str = string_node.text.decode("utf-8")
    if len(raw) >= 2 and raw[0] in ("'", '"', "`") and raw[-1] == raw[0]:
        return raw[1:-1]
    return raw


def _find_child_by_type(node: Node, child_type: str) -> Node | None:
    """在子节点中查找指定类型的第一个节点。"""
    for child in node.children:
        if child.type == child_type:
            return child
    return None
