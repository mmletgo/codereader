"""调用关系跨文件解析器 - 将调用名称匹配到具体函数定义"""
from collections import defaultdict

from analyzer.base import CallInfo, FunctionInfo, ImportInfo


class CallResolver:
    """调用关系解析器，通过多级索引将 CallInfo 匹配到 FunctionInfo。"""

    def __init__(self, functions: list[FunctionInfo]) -> None:
        # 精确匹配索引: qualified_name -> FunctionInfo
        self.qualified_name_map: dict[str, FunctionInfo] = {}
        # 短名匹配索引: 函数名 -> [FunctionInfo列表]（处理同名函数）
        self.name_map: dict[str, list[FunctionInfo]] = defaultdict(list)
        # 文件级索引: 相对路径 -> [FunctionInfo列表]
        self.file_func_map: dict[str, list[FunctionInfo]] = defaultdict(list)

        for func in functions:
            key: str = f"{func.file_rel_path}::{func.qualified_name}"
            self.qualified_name_map[key] = func
            self.name_map[func.name].append(func)
            self.name_map[func.qualified_name].append(func)
            self.file_func_map[func.file_rel_path].append(func)

    def resolve(
        self,
        calls: list[CallInfo],
        file_imports: dict[str, list[ImportInfo]],
    ) -> list[tuple[CallInfo, str | None]]:
        """解析调用关系列表。

        Args:
            calls: 所有文件中提取的调用信息列表（CallInfo 需携带 caller 信息用于定位文件）
            file_imports: {相对文件路径 -> 该文件的import列表}

        Returns:
            (调用信息, 匹配到的qualified_name或None) 列表
        """
        # 建立 caller_qualified_name -> file_rel_path 映射
        caller_file_map: dict[str, str] = {}
        for key, func in self.qualified_name_map.items():
            # key format: "file_rel_path::qualified_name"
            file_path: str = key.split("::")[0]
            caller_file_map[func.qualified_name + "@" + file_path] = file_path

        results: list[tuple[CallInfo, str | None]] = []
        for call in calls:
            resolved: str | None = self._resolve_single(
                call, file_imports, caller_file_map
            )
            results.append((call, resolved))
        return results

    def _find_caller_file(
        self,
        caller_qname: str,
        caller_file_map: dict[str, str],
    ) -> str | None:
        """根据 caller 的 qualified_name 找到其所在文件。"""
        for key, file_path in caller_file_map.items():
            if key.startswith(caller_qname + "@"):
                return file_path
        return None

    def _resolve_single(
        self,
        call: CallInfo,
        file_imports: dict[str, list[ImportInfo]],
        caller_file_map: dict[str, str],
    ) -> str | None:
        """按优先级解析单个调用。"""
        callee_name: str = call.callee_name
        caller_qname: str = call.caller_qualified_name
        caller_file: str | None = self._find_caller_file(
            caller_qname, caller_file_map
        )

        # 1. self.method / cls.method → 从 caller 的 class 中查找同类方法
        if callee_name.startswith("self.") or callee_name.startswith("cls."):
            method_name: str = callee_name.split(".", 1)[1]
            # 跳过多级属性访问（如 self.logger.warning）
            if "." in method_name:
                return None
            # 从 caller_qname 推断类名: "ClassName.method_name" -> "ClassName"
            if "." in caller_qname:
                caller_class: str = caller_qname.split(".")[0]
                target_qname: str = f"{caller_class}.{method_name}"
                # 在同文件中查找本类方法
                if caller_file is not None:
                    key: str = f"{caller_file}::{target_qname}"
                    if key in self.qualified_name_map:
                        return target_qname
                # 回退到全局搜索同名 qualified_name
                if target_qname in self.name_map:
                    return target_qname
                # 继承回退：在同文件中搜索任意类的同名方法（父类/Mixin）
                if caller_file is not None:
                    for func in self.file_func_map.get(caller_file, []):
                        if func.name == method_name and func.is_method:
                            return func.qualified_name
                # 全局搜索同名方法（唯一匹配时采用）
                candidates: list[FunctionInfo] = [
                    f for f in self.name_map.get(method_name, [])
                    if f.is_method
                ]
                if len(candidates) == 1:
                    return candidates[0].qualified_name
            return None

        # 2. 直接调用 func() — 无点号
        if "." not in callee_name:
            # 2a. 先查同文件
            if caller_file is not None:
                for func in self.file_func_map.get(caller_file, []):
                    if func.name == callee_name:
                        return func.qualified_name
            # 2b. 通过 import 信息匹配
            resolved: str | None = self._resolve_via_import(
                callee_name, caller_file, file_imports
            )
            if resolved is not None:
                return resolved
            # 2c. 全局同名函数
            candidates: list[FunctionInfo] = self.name_map.get(callee_name, [])
            if len(candidates) == 1:
                return candidates[0].qualified_name
            elif len(candidates) > 1:
                # 多个同名函数，无法确定，返回第一个
                return candidates[0].qualified_name
            return None

        # 3. module.func() 或 obj.method() — 有点号
        parts: list[str] = callee_name.split(".")
        attr_name: str = parts[-1]
        obj_name: str = parts[0]

        # 3a. 直接作为 qualified_name 匹配（如 ClassName.method）
        if callee_name in self.name_map:
            return self.name_map[callee_name][0].qualified_name

        # 3b. 通过 import 信息解析模块路径
        if caller_file is not None:
            imports: list[ImportInfo] = file_imports.get(caller_file, [])
            for imp in imports:
                if imp.alias == obj_name:
                    # import module; module.func() -> 在 module 对应文件中查找 func
                    resolved_func: str | None = self._find_func_in_module(
                        imp.module, imp.name, attr_name
                    )
                    if resolved_func is not None:
                        return resolved_func

        # 3c. 全局搜索 attr_name
        candidates = self.name_map.get(attr_name, [])
        if len(candidates) == 1:
            return candidates[0].qualified_name

        return None

    def _resolve_via_import(
        self,
        callee_name: str,
        caller_file: str | None,
        file_imports: dict[str, list[ImportInfo]],
    ) -> str | None:
        """通过 import 信息解析直接调用。

        例如: from module import func; func() -> 查找 module 中的 func
        """
        if caller_file is None:
            return None
        imports: list[ImportInfo] = file_imports.get(caller_file, [])
        for imp in imports:
            if imp.alias == callee_name:
                # from module import name as alias
                # 查找来源模块中名为 imp.name 的函数
                target_name: str = imp.name
                module_path: str = imp.module
                resolved: str | None = self._find_func_in_module(
                    module_path, target_name, target_name
                )
                if resolved is not None:
                    return resolved
        return None

    def _find_func_in_module(
        self,
        module_path: str,
        imported_name: str,
        func_name: str,
    ) -> str | None:
        """在模块对应的文件中查找函数。

        将模块路径转为文件相对路径，然后在 file_func_map 中查找。
        """
        # 将模块路径转为可能的文件路径
        # 例如: analyzer.base -> analyzer/base.py
        possible_paths: list[str] = _module_to_file_paths(module_path)

        for path in possible_paths:
            funcs: list[FunctionInfo] = self.file_func_map.get(path, [])
            for func in funcs:
                if func.name == func_name or func.qualified_name == func_name:
                    return func.qualified_name
        return None


def _module_to_file_paths(module_path: str) -> list[str]:
    """将 Python 模块路径转为可能的文件相对路径列表。

    例如:
        "analyzer.base" -> ["analyzer/base.py"]
        "analyzer" -> ["analyzer/__init__.py", "analyzer.py"]
    """
    if not module_path:
        return []
    parts: list[str] = module_path.replace(".", "/").split("/")
    base: str = "/".join(parts)
    return [
        f"{base}.py",
        f"{base}/__init__.py",
    ]
